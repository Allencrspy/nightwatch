import axios from 'axios';
import { env } from '../../config/env.js';
import { CryptoUtil } from '../../utils/crypto.js';
import { logger } from '../../utils/logger.js';
import type { DhanStatusResponse } from '../../schemas/auth.schema.js';

interface TokenSession {
  encryptedToken: string;
  clientId: string;
  connectedAt: string;
  source: 'OAUTH_CONSENT' | 'ENV' | 'SANDBOX_MOCK';
}

export class DhanAuthService {
  private static instance: DhanAuthService;
  private session: TokenSession | null = null;

  private constructor() {
    // Check if token pre-exists in env
    if (env.DHAN_ACCESS_TOKEN && env.DHAN_CLIENT_ID) {
      this.session = {
        encryptedToken: CryptoUtil.encrypt(env.DHAN_ACCESS_TOKEN),
        clientId: env.DHAN_CLIENT_ID,
        connectedAt: new Date().toISOString(),
        source: 'ENV',
      };
      logger.info('DhanAuthService initialized using ENV credentials');
    }
  }

  public static getInstance(): DhanAuthService {
    if (!DhanAuthService.instance) {
      DhanAuthService.instance = new DhanAuthService();
    }
    return DhanAuthService.instance;
  }

  /**
   * Generates Dhan login consent URL for OAuth flow
   */
  public generateConsentUrl(redirectUri: string): { loginUrl: string; state: string } {
    const state = Math.random().toString(36).substring(2, 15);
    const clientId = env.DHAN_CLIENT_ID || 'SANDBOX_CLIENT_ID';
    
    // Dhan official consent URL structure
    const loginUrl = `${env.DHAN_BASE_URL}/auth/consent?clientId=${encodeURIComponent(clientId)}&redirectUri=${encodeURIComponent(redirectUri)}&state=${state}`;
    
    logger.info({ loginUrl, clientId }, 'Generated Dhan consent URL');
    return { loginUrl, state };
  }

  /**
   * Swaps consent tokenId for access token and securely encrypts it server-side
   */
  public async handleCallback(tokenId: string, clientId?: string): Promise<boolean> {
    const targetClientId = clientId || env.DHAN_CLIENT_ID || 'SANDBOX_CLIENT_ID';
    
    try {
      // In production, Dhan exchange endpoint /auth/token is called with tokenId
      if (env.DHAN_CLIENT_ID && env.DHAN_CLIENT_ID !== 'SANDBOX_CLIENT_ID') {
        const response = await axios.post(`${env.DHAN_BASE_URL}/auth/token`, {
          tokenId,
          clientId: targetClientId,
        });

        const accessToken = response.data?.accessToken || response.data?.data?.accessToken;
        if (!accessToken) {
          throw new Error('Dhan token exchange returned empty access token');
        }

        this.session = {
          encryptedToken: CryptoUtil.encrypt(accessToken),
          clientId: targetClientId,
          connectedAt: new Date().toISOString(),
          source: 'OAUTH_CONSENT',
        };
      } else {
        // Sandbox mock fallback
        const mockAccessToken = `dhan_token_mock_${tokenId}_${Date.now()}`;
        this.session = {
          encryptedToken: CryptoUtil.encrypt(mockAccessToken),
          clientId: targetClientId,
          connectedAt: new Date().toISOString(),
          source: 'SANDBOX_MOCK',
        };
      }

      logger.info({ clientId: targetClientId }, 'Successfully authenticated and stored encrypted Dhan session');
      return true;
    } catch (error: any) {
      logger.error({ error: error.message }, 'Failed to exchange Dhan consent token');
      throw new Error(`Dhan auth callback failed: ${error.message}`);
    }
  }

  /**
   * Retrieves active decrypted access token for API requests
   */
  public getValidToken(): { accessToken: string | null; clientId: string | null } {
    if (!this.session) {
      if (env.DHAN_ACCESS_TOKEN) {
        return {
          accessToken: env.DHAN_ACCESS_TOKEN,
          clientId: env.DHAN_CLIENT_ID || 'SANDBOX_CLIENT_ID',
        };
      }
      return { accessToken: null, clientId: null };
    }

    try {
      const accessToken = CryptoUtil.decrypt(this.session.encryptedToken);
      return { accessToken, clientId: this.session.clientId };
    } catch (err: any) {
      logger.error({ error: err.message }, 'Failed to decrypt stored Dhan access token');
      return { accessToken: null, clientId: null };
    }
  }

  /**
   * Returns current status of Dhan authorization connection
   */
  public getStatus(): DhanStatusResponse {
    if (!this.session) {
      if (env.DHAN_ACCESS_TOKEN) {
        return {
          connected: true,
          clientId: env.DHAN_CLIENT_ID || 'ENV_CLIENT',
          connectedAt: new Date().toISOString(),
          source: 'ENV',
        };
      }
      return {
        connected: false,
        source: 'SANDBOX_MOCK',
      };
    }

    return {
      connected: true,
      clientId: this.session.clientId,
      connectedAt: this.session.connectedAt,
      source: this.session.source,
    };
  }

  /**
   * Invalidates active stored Dhan session
   */
  public disconnect(): void {
    this.session = null;
    logger.info('Dhan authentication session disconnected');
  }
}
