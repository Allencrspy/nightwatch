import axios from 'axios';
import { env, isDhanOAuthConfigured } from '../../config/env.js';
import { NotConfiguredError, UpstreamError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

/**
 * Dhan partner consent flow, isolated so the endpoint shapes live in one file.
 *
 * VERIFY AGAINST CURRENT DHAN DOCS before trusting in production. The flow is:
 *   1. generate-consent  -> consentId
 *   2. user is sent to Dhan's own login page with that consentId
 *   3. Dhan redirects back to our callback with a tokenId
 *   4. consume-consent   -> accessToken + dhanClientId
 * The user's Dhan credentials are only ever entered on Dhan's domain.
 */

export interface ConsentHandle {
  consentId: string;
  loginUrl: string;
}

export interface ConsumedConsent {
  accessToken: string;
  dhanClientId: string;
  expiresAt: string | null;
}

function partnerHeaders(): Record<string, string> {
  if (!isDhanOAuthConfigured) throw new NotConfiguredError('Dhan OAuth (DHAN_PARTNER_ID / DHAN_PARTNER_SECRET)');
  return {
    partner_id: env.DHAN_PARTNER_ID as string,
    partner_secret: env.DHAN_PARTNER_SECRET as string,
    'Content-Type': 'application/json',
  };
}

export class DhanOAuthClient {
  /** Step 1 + 2: ask Dhan for a consent id and build the login URL for it. */
  public static async generateConsent(): Promise<ConsentHandle> {
    const url = `${env.DHAN_AUTH_BASE}/partner/generate-consent`;
    try {
      const res = await axios.post(url, {}, { headers: partnerHeaders(), timeout: 15_000 });
      const consentId = res.data?.consentId ?? res.data?.data?.consentId;
      if (!consentId) throw new Error('response contained no consentId');

      return {
        consentId,
        loginUrl: `${env.DHAN_AUTH_BASE}/login/consentApp-login?consentAppId=${encodeURIComponent(consentId)}`,
      };
    } catch (err: any) {
      if (err instanceof NotConfiguredError) throw err;
      const detail = err.response?.data ?? err.message;
      logger.error({ url, detail }, 'Dhan generate-consent failed');
      throw new UpstreamError('Dhan auth', 'could not start the consent flow', detail);
    }
  }

  /** Step 4: exchange the returned tokenId for an access token. */
  public static async consumeConsent(tokenId: string): Promise<ConsumedConsent> {
    const url = `${env.DHAN_AUTH_BASE}/partner/consume-consent?tokenId=${encodeURIComponent(tokenId)}`;
    try {
      const res = await axios.get(url, { headers: partnerHeaders(), timeout: 15_000 });
      const body = res.data?.data ?? res.data ?? {};
      const accessToken = body.accessToken ?? body.access_token;
      const dhanClientId = body.dhanClientId ?? body.dhanClientID ?? body.clientId;

      if (!accessToken) throw new Error('response contained no accessToken');
      if (!dhanClientId) throw new Error('response contained no dhanClientId');

      // Dhan states an expiry on some flows and not others. Record it only if given.
      const rawExpiry = body.expiryTime ?? body.expiresAt ?? null;
      const expiresAt = rawExpiry ? new Date(rawExpiry).toISOString() : null;

      return { accessToken, dhanClientId, expiresAt };
    } catch (err: any) {
      if (err instanceof NotConfiguredError) throw err;
      const detail = err.response?.data ?? err.message;
      logger.error({ detail }, 'Dhan consume-consent failed');
      throw new UpstreamError('Dhan auth', 'could not exchange the consent token', detail);
    }
  }
}
