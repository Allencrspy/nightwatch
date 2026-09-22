import type { FastifyPluginAsync } from 'fastify';
import { DhanAuthService } from '../services/auth/dhan-auth.service.js';
import { DhanCallbackQuerySchema } from '../schemas/auth.schema.js';
import { readSessionId, requireSession } from '../plugins/require-session.js';
import { env, isDhanOAuthConfigured } from '../config/env.js';
import { AppError } from '../utils/errors.js';

/**
 * The callback lands in a popup. Rather than putting the session id in a URL
 * — where it would sit in history, logs and the Referer header — the popup
 * hands it to the opener via postMessage, targeted at the configured origin.
 */
function callbackPage(payload: Record<string, unknown>): string {
  const json = JSON.stringify(payload).replace(/</g, '\\u003c');
  const origin = JSON.stringify(env.FRONTEND_ORIGIN);
  const ok = payload.ok === true;
  return `<!doctype html>
<meta charset="utf-8"><title>${ok ? 'Connected' : 'Login failed'}</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0a0a0a;color:#fff;
       font:15px/1.5 -apple-system,"Segoe UI",sans-serif;text-align:center;padding:24px}
  .m{max-width:34ch} .t{font-weight:600;margin-bottom:6px;color:${ok ? '#cef24e' : '#e5484d'}}
  .s{color:#a8a79e;font-size:13px}
</style>
<div class="m">
  <div class="t">${ok ? 'Connected to Dhan' : 'Login failed'}</div>
  <div class="s">${ok ? 'You can close this window.' : String(payload.error ?? 'Please try again.')}</div>
</div>
<script>
  var payload = ${json};
  try { if (window.opener) window.opener.postMessage(payload, ${origin}); } catch (e) {}
  if (${ok}) setTimeout(function(){ try { window.close(); } catch (e) {} }, 1200);
</script>`;
}

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  const auth = DhanAuthService.getInstance();

  /** Start a login. Returns the Dhan URL the dashboard should open in a popup. */
  fastify.get('/auth/dhan/login', async (_request, reply) => {
    const redirectUri = `${env.APP_BASE_URL}/auth/dhan/callback`;
    const { loginUrl, state } = await auth.startLogin(redirectUri);
    return reply.send({
      success: true,
      data: { loginUrl, state, redirectUri },
      message: 'Open loginUrl in a popup. The user authenticates on Dhan, never here.',
    });
  });

  /** Dhan redirects the user's browser here after consent. */
  fastify.get('/auth/dhan/callback', async (request, reply) => {
    const query = DhanCallbackQuerySchema.parse(request.query);
    const tokenId = query.tokenId || query.consentId;

    reply.type('text/html; charset=utf-8');

    if (!tokenId || !query.state) {
      return reply
        .status(400)
        .send(callbackPage({ ok: false, error: 'Dhan did not return a tokenId and state.' }));
    }

    try {
      const { sessionId, status } = await auth.completeLogin(tokenId, query.state);
      return reply.send(callbackPage({ ok: true, sessionId, status }));
    } catch (err: any) {
      const message = err instanceof AppError ? err.message : 'Could not complete the Dhan login.';
      return reply.status(err instanceof AppError ? err.statusCode : 500).send(
        callbackPage({ ok: false, error: message })
      );
    }
  });

  /** Connection status. Safe to call without a session — reports connected:false. */
  fastify.get('/auth/dhan/status', async (request, reply) => {
    return reply.send({
      success: true,
      data: {
        ...auth.getStatus(readSessionId(request)),
        oauthConfigured: isDhanOAuthConfigured,
      },
    });
  });

  fastify.post('/auth/dhan/disconnect', { preHandler: requireSession }, async (request, reply) => {
    auth.disconnect(request.sessionId as string);
    return reply.send({ success: true, message: 'Dhan session ended.' });
  });
};
