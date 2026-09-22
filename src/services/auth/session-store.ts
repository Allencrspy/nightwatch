import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../../config/env.js';
import { CryptoUtil } from '../../utils/crypto.js';
import { logger } from '../../utils/logger.js';

export interface DhanSession {
  /** Opaque id handed to the dashboard as a bearer token. */
  id: string;
  /** Dhan access token, encrypted at rest. Never logged, never returned. */
  encryptedToken: string;
  dhanClientId: string;
  createdAt: string;
  /** ISO expiry as reported by Dhan, or null when Dhan did not say. */
  expiresAt: string | null;
}

/** Public view of a session. Deliberately carries no token material. */
export interface SessionStatus {
  connected: boolean;
  dhanClientId?: string;
  connectedAt?: string;
  expiresAt?: string | null;
  expired?: boolean;
}

interface PendingLogin {
  consentAppId: string;
  createdAt: number;
  redirectUri: string;
}

const PENDING_TTL_MS = 10 * 60 * 1000;

/**
 * Sessions live in memory and are mirrored to a gitignored file so a server
 * restart does not force a fresh Dhan login. Tokens are encrypted both places.
 */
export class SessionStore {
  private static instance: SessionStore;
  private sessions = new Map<string, DhanSession>();
  private pending = new Map<string, PendingLogin>();

  private constructor() {
    this.load();
  }

  public static getInstance(): SessionStore {
    if (!SessionStore.instance) SessionStore.instance = new SessionStore();
    return SessionStore.instance;
  }

  // --- pending logins ---
  //
  // Dhan's redirect carries only ?tokenId=; it does not echo a state
  // parameter, so the usual state round trip is not available. Instead a
  // callback is only honoured when this server recently started a login and
  // that login has not yet been consumed. That binds the callback to a flow
  // we began, and makes each one single-use, which is what is achievable
  // within the documented redirect.

  public createPending(consentAppId: string, redirectUri: string): void {
    this.prunePending();
    this.pending.set(consentAppId, { consentAppId, createdAt: Date.now(), redirectUri });
  }

  /** Consumes the most recent unconsumed login, or null when there is none. */
  public consumeMostRecentPending(): PendingLogin | null {
    this.prunePending();
    let newest: PendingLogin | null = null;
    for (const p of this.pending.values()) {
      if (!newest || p.createdAt > newest.createdAt) newest = p;
    }
    if (!newest) return null;
    this.pending.delete(newest.consentAppId);
    return newest;
  }

  public pendingCount(): number {
    this.prunePending();
    return this.pending.size;
  }

  private prunePending(): void {
    const cutoff = Date.now() - PENDING_TTL_MS;
    for (const [k, v] of this.pending) if (v.createdAt < cutoff) this.pending.delete(k);
  }

  // --- sessions ---

  public create(accessToken: string, dhanClientId: string, expiresAt: string | null): DhanSession {
    const session: DhanSession = {
      id: crypto.randomBytes(32).toString('base64url'),
      encryptedToken: CryptoUtil.encrypt(accessToken),
      dhanClientId,
      createdAt: new Date().toISOString(),
      expiresAt,
    };
    this.sessions.set(session.id, session);
    this.persist();
    return session;
  }

  public get(id: string | undefined | null): DhanSession | null {
    if (!id) return null;
    const s = this.sessions.get(id);
    if (!s) return null;
    if (this.isExpired(s)) {
      this.sessions.delete(id);
      this.persist();
      return null;
    }
    return s;
  }

  /** Decrypts on demand so the plaintext token is never held between calls. */
  public getAccessToken(id: string): string | null {
    const s = this.get(id);
    if (!s) return null;
    try {
      return CryptoUtil.decrypt(s.encryptedToken);
    } catch (err) {
      logger.error({ sessionId: s.id.slice(0, 8) }, 'Stored Dhan token could not be decrypted; dropping session');
      this.destroy(id);
      return null;
    }
  }

  public destroy(id: string): void {
    if (this.sessions.delete(id)) this.persist();
  }

  public status(id: string | undefined | null): SessionStatus {
    const s = this.get(id);
    if (!s) return { connected: false };
    return {
      connected: true,
      dhanClientId: s.dhanClientId,
      connectedAt: s.createdAt,
      expiresAt: s.expiresAt,
      expired: false,
    };
  }

  private isExpired(s: DhanSession): boolean {
    if (!s.expiresAt) return false; // Dhan did not state one; let API calls be the judge.
    return new Date(s.expiresAt).getTime() <= Date.now();
  }

  // --- persistence ---

  private get file(): string {
    return path.resolve(process.cwd(), env.SESSION_STORE_PATH);
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as DhanSession[];
      for (const s of raw) if (!this.isExpired(s)) this.sessions.set(s.id, s);
      logger.info({ count: this.sessions.size }, 'Restored Dhan sessions from disk');
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Could not read session store; starting empty');
    }
  }

  private persist(): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify([...this.sessions.values()], null, 2), { mode: 0o600 });
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Could not write session store; sessions will not survive restart');
    }
  }
}
