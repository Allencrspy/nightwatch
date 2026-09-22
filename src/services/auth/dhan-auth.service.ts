import { DhanOAuthClient } from './dhan-oauth.client.js';
import { SessionStore, type SessionStatus } from './session-store.js';
import { NotAuthenticatedError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

export interface StartedLogin {
  loginUrl: string;
  consentAppId: string;
}

export interface CompletedLogin {
  sessionId: string;
  status: SessionStatus;
}

/**
 * Orchestrates the Dhan login. There is no fallback path: if Dhan cannot be
 * reached or the exchange fails, the caller gets an error. A "sandbox session"
 * that reports itself as connected while holding a fabricated token is worse
 * than no session at all, because everything downstream then looks healthy.
 */
export class DhanAuthService {
  private static instance: DhanAuthService;
  private store = SessionStore.getInstance();

  public static getInstance(): DhanAuthService {
    if (!DhanAuthService.instance) DhanAuthService.instance = new DhanAuthService();
    return DhanAuthService.instance;
  }

  /**
   * Begins a login. The user completes it on Dhan's own page, authenticating
   * however they prefer — QR scan, PIN or OTP. None of that is ours to handle.
   */
  public async startLogin(dhanClientId: string, redirectUri: string): Promise<StartedLogin> {
    const { loginUrl, consentAppId } = await DhanOAuthClient.generateConsent(dhanClientId);
    this.store.createPending(consentAppId, redirectUri);
    logger.info({ consentAppId }, 'Started Dhan login');
    return { loginUrl, consentAppId };
  }

  /**
   * Completes a login. Dhan's redirect carries only a tokenId, so this is
   * honoured only when a login started here is still pending — each one
   * single-use and expiring after ten minutes.
   */
  public async completeLogin(tokenId: string): Promise<CompletedLogin> {
    const pending = this.store.consumeMostRecentPending();
    if (!pending) {
      throw new NotAuthenticatedError(
        'No login is pending on this server. Start the login from the dashboard and finish it within 10 minutes.'
      );
    }

    const { accessToken, dhanClientId, expiresAt } = await DhanOAuthClient.consumeConsent(tokenId);
    const session = this.store.create(accessToken, dhanClientId, expiresAt);

    logger.info({ dhanClientId, expiresAt }, 'Dhan session established');
    return { sessionId: session.id, status: this.store.status(session.id) };
  }

  /**
   * Creates a session from credentials the caller has already verified against
   * Dhan. Verification is the caller's job precisely so this cannot be used to
   * mint a session for a token that does not work.
   */
  public createSessionFromToken(accessToken: string, dhanClientId: string): CompletedLogin {
    const session = this.store.create(accessToken, dhanClientId, null);
    logger.info({ dhanClientId }, 'Dhan session established from a user-supplied token');
    return { sessionId: session.id, status: this.store.status(session.id) };
  }

  /** The access token for a session, or null. Callers must handle null. */
  public getAccessToken(sessionId: string): string | null {
    return this.store.getAccessToken(sessionId);
  }

  public getClientId(sessionId: string): string | null {
    return this.store.get(sessionId)?.dhanClientId ?? null;
  }

  public getStatus(sessionId: string | undefined | null): SessionStatus {
    return this.store.status(sessionId);
  }

  public disconnect(sessionId: string): void {
    this.store.destroy(sessionId);
    logger.info('Dhan session disconnected');
  }
}
