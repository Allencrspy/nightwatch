import { DhanOAuthClient } from './dhan-oauth.client.js';
import { SessionStore, type SessionStatus } from './session-store.js';
import { NotAuthenticatedError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

export interface StartedLogin {
  loginUrl: string;
  state: string;
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

  /** Begins a login. The user completes it on Dhan's own domain. */
  public async startLogin(redirectUri: string): Promise<StartedLogin> {
    const { loginUrl, consentId } = await DhanOAuthClient.generateConsent();
    const state = this.store.createPending(redirectUri);
    logger.info({ consentId }, 'Started Dhan consent flow');
    return { loginUrl: `${loginUrl}&state=${encodeURIComponent(state)}`, state };
  }

  /** Completes a login. Throws if `state` is unknown, replayed, or expired. */
  public async completeLogin(tokenId: string, state: string): Promise<CompletedLogin> {
    const pending = this.store.consumePending(state);
    if (!pending) {
      throw new NotAuthenticatedError(
        'Login state is unknown, already used, or older than 10 minutes. Start the login again.'
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
