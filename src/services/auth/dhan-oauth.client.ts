import axios from 'axios';
import { env, isDhanOAuthConfigured } from '../../config/env.js';
import { NotConfiguredError, UpstreamError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

/**
 * Dhan's browser login flow for individual traders, per DhanHQ v2 docs.
 *
 *   1. POST /app/generate-consent?client_id={dhanClientId}  -> consentAppId
 *   2. Browser opens /login/consentApp-login?consentAppId=…
 *      The user authenticates on Dhan's own page — QR scan, PIN or OTP,
 *      whichever they prefer. Nothing about that step is ours to implement.
 *      Dhan then 302s to the registered redirect URL with ?tokenId=…
 *   3. GET /app/consumeApp-consent?tokenId={tokenId}        -> accessToken
 *
 * Credentials are the user's own API key and secret from web.dhan.co, sent as
 * app_id / app_secret headers. This is available to every Dhan account; it is
 * not a partner-only programme. The access token Dhan returns is valid for
 * 24 hours.
 */

export interface ConsentHandle {
  consentAppId: string;
  loginUrl: string;
}

export interface ConsumedConsent {
  accessToken: string;
  dhanClientId: string;
  dhanClientName?: string;
  expiresAt: string | null;
}

function appHeaders(): Record<string, string> {
  if (!isDhanOAuthConfigured) {
    throw new NotConfiguredError('Dhan API access (DHAN_API_KEY / DHAN_API_SECRET / DHAN_CLIENT_ID)');
  }
  return {
    app_id: env.DHAN_API_KEY as string,
    app_secret: env.DHAN_API_SECRET as string,
    'Content-Type': 'application/json',
  };
}

/** Dhan returns expiry as IST-local ISO with no zone marker. */
function parseExpiry(raw: unknown): string | null {
  if (typeof raw !== 'string' || !raw.trim()) return null;
  const hasZone = /(?:Z|[+-]\d{2}:?\d{2})$/.test(raw.trim());
  const d = new Date(hasZone ? raw : `${raw.trim()}+05:30`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

export class DhanOAuthClient {
  /** Step 1 and 2: get a consent id, and the URL the user logs in at. */
  public static async generateConsent(dhanClientId: string): Promise<ConsentHandle> {
    const url = `${env.DHAN_AUTH_BASE}/app/generate-consent?client_id=${encodeURIComponent(dhanClientId)}`;
    try {
      const res = await axios.post(url, null, { headers: appHeaders(), timeout: 15_000 });
      const body = res.data ?? {};
      const consentAppId = body.consentAppId ?? body.data?.consentAppId;

      if (!consentAppId) {
        throw new Error(`response contained no consentAppId (status ${body.status ?? 'unknown'})`);
      }

      return {
        consentAppId,
        loginUrl: `${env.DHAN_AUTH_BASE}/login/consentApp-login?consentAppId=${encodeURIComponent(consentAppId)}`,
      };
    } catch (err: any) {
      if (err instanceof NotConfiguredError) throw err;
      const detail = err.response?.data ?? err.message;
      logger.error({ status: err.response?.status, detail }, 'Dhan generate-consent failed');
      throw new UpstreamError('Dhan auth', 'could not start the login. Check the API key, secret and client id.', detail);
    }
  }

  /** Step 3: exchange the tokenId from the redirect for an access token. */
  public static async consumeConsent(tokenId: string): Promise<ConsumedConsent> {
    const url = `${env.DHAN_AUTH_BASE}/app/consumeApp-consent?tokenId=${encodeURIComponent(tokenId)}`;
    try {
      const res = await axios.get(url, { headers: appHeaders(), timeout: 15_000 });
      const body = res.data?.data ?? res.data ?? {};

      const accessToken = body.accessToken;
      const dhanClientId = body.dhanClientId;
      if (!accessToken) throw new Error('response contained no accessToken');
      if (!dhanClientId) throw new Error('response contained no dhanClientId');

      return {
        accessToken,
        dhanClientId: String(dhanClientId),
        dhanClientName: body.dhanClientName,
        expiresAt: parseExpiry(body.expiryTime),
      };
    } catch (err: any) {
      if (err instanceof NotConfiguredError) throw err;
      const detail = err.response?.data ?? err.message;
      logger.error({ status: err.response?.status, detail }, 'Dhan consume-consent failed');
      throw new UpstreamError('Dhan auth', 'could not exchange the login token', detail);
    }
  }
}
