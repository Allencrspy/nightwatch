import type { FastifyRequest } from 'fastify';
import { SessionStore } from '../services/auth/session-store.js';
import { NotAuthenticatedError } from '../utils/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    sessionId?: string;
    dhanClientId?: string;
  }
}

/** Reads a bearer session id without asserting one is present. */
export function readSessionId(request: FastifyRequest): string | undefined {
  const header = request.headers.authorization;
  if (!header) return undefined;
  const [scheme, value] = header.split(' ');
  if (!value || scheme.toLowerCase() !== 'bearer') return undefined;
  return value.trim();
}

/**
 * Guard for every route that reaches Dhan on the user's behalf. Without it
 * the analysis endpoint is open to anyone who finds the URL — including to
 * anyone happy to spend the server's OpenAI budget.
 */
export async function requireSession(request: FastifyRequest): Promise<void> {
  const sessionId = readSessionId(request);
  const store = SessionStore.getInstance();
  const session = store.get(sessionId);

  if (!session) throw new NotAuthenticatedError();

  request.sessionId = session.id;
  request.dhanClientId = session.dhanClientId;
}
