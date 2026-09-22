import type { FastifyPluginAsync } from 'fastify';
import { DhanAuthService } from '../services/auth/dhan-auth.service.js';
import { DhanCallbackQuerySchema, DhanLoginQuerySchema, DhanTokenLoginSchema } from '../schemas/auth.schema.js';
import { DhanMarketDataService } from '../services/dhan/dhan-market-data.service.js';
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

  /**
   * Start a login. Returns the Dhan URL the dashboard opens in a popup, where
   * the user authenticates however they like — QR scan, PIN or OTP.
   */
  fastify.get('/auth/dhan/login', async (request, reply) => {
    const { clientId } = DhanLoginQuerySchema.parse(request.query);
    const dhanClientId = clientId || env.DHAN_CLIENT_ID;

    // Name everything that is missing, not just the first thing checked.
    const missing = [
      !env.DHAN_API_KEY && 'DHAN_API_KEY',
      !env.DHAN_API_SECRET && 'DHAN_API_SECRET',
      !dhanClientId && 'DHAN_CLIENT_ID',
    ].filter(Boolean) as string[];
    if (missing.length || !dhanClientId) {
      throw new AppError(
        503,
        'NOT_CONFIGURED',
        `Dhan browser login needs ${missing.join(', ')} in .env. Generate an API key at web.dhan.co ` +
          `under My Profile > Access DhanHQ APIs, setting the redirect URL to ` +
          `${env.APP_BASE_URL}/auth/dhan/callback, then restart the API.`
      );
    }

    const redirectUri = `${env.APP_BASE_URL}/auth/dhan/callback`;
    const { loginUrl, consentAppId } = await auth.startLogin(dhanClientId, redirectUri);
    return reply.send({
      success: true,
      data: { loginUrl, consentAppId, redirectUri },
      message: 'Open loginUrl in a popup. The user authenticates on Dhan, never here.',
    });
  });

  /** Dhan redirects the user's browser here after consent. */
  fastify.get('/auth/dhan/callback', async (request, reply) => {
    const query = DhanCallbackQuerySchema.parse(request.query);
    const tokenId = query.tokenId || query.consentId;

    reply.type('text/html; charset=utf-8');

    // Dhan's redirect carries only ?tokenId=; there is no state to echo back.
    if (!tokenId) {
      return reply
        .status(400)
        .send(callbackPage({ ok: false, error: 'Dhan did not return a tokenId.' }));
    }

    try {
      const { sessionId, status } = await auth.completeLogin(tokenId);
      return reply.send(callbackPage({ ok: true, sessionId, status }));
    } catch (err: any) {
      const message = err instanceof AppError ? err.message : 'Could not complete the Dhan login.';
      return reply.status(err instanceof AppError ? err.statusCode : 500).send(
        callbackPage({ ok: false, error: message })
      );
    }
  });

  /**
   * Second front door: a 24-hour access token generated directly at
   * web.dhan.co (My Profile > Access DhanHQ APIs).
   *
   * Verified against Dhan before any session exists, encrypted immediately,
   * and never written to config, logged, or returned. The browser login above
   * is the primary route because it needs no copy-pasting and lets the user
   * authenticate by QR.
   */
  fastify.post('/auth/dhan/token', async (request, reply) => {
    const { accessToken, dhanClientId } = DhanTokenLoginSchema.parse(request.body);

    const market = new DhanMarketDataService(accessToken, dhanClientId);
    const check = await market.verifyCredentials();
    if (!check.ok) {
      throw new AppError(401, 'CREDENTIALS_REJECTED', check.reason);
    }

    const { sessionId, status } = auth.createSessionFromToken(accessToken, dhanClientId);
    return reply.send({ success: true, data: { sessionId, status } });
  });

  /** Connection status. Safe to call without a session — reports connected:false. */
  fastify.get('/auth/dhan/status', async (request, reply) => {
    return reply.send({
      success: true,
      data: {
        ...auth.getStatus(readSessionId(request)),
        oauthConfigured: isDhanOAuthConfigured,
        // Which front doors this server can actually offer right now.
        methods: { oauth: isDhanOAuthConfigured, token: true },
      },
    });
  });

  fastify.post('/auth/dhan/disconnect', { preHandler: requireSession }, async (request, reply) => {
    auth.disconnect(request.sessionId as string);
    return reply.send({ success: true, message: 'Dhan session ended.' });
  });
};
