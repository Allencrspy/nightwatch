import type { FastifyPluginAsync } from 'fastify';
import { DhanAuthService } from '../services/auth/dhan-auth.service.js';
import { DhanCallbackQuerySchema } from '../schemas/auth.schema.js';

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  const authService = DhanAuthService.getInstance();

  fastify.get('/auth/dhan/login', async (request, reply) => {
    const host = request.headers.host || `localhost:${fastify.server.address()}`;
    const protocol = request.protocol || 'http';
    const redirectUri = `${protocol}://${host}/auth/dhan/callback`;
    
    const { loginUrl, state } = authService.generateConsentUrl(redirectUri);
    return reply.send({
      success: true,
      loginUrl,
      state,
      message: 'Redirect user to loginUrl to authenticate with Dhan',
    });
  });

  fastify.get('/auth/dhan/callback', async (request, reply) => {
    const query = DhanCallbackQuerySchema.parse(request.query);
    const tokenId = query.tokenId || query.consentId;

    if (!tokenId) {
      return reply.status(400).send({
        success: false,
        error: 'Missing tokenId or consentId in callback query parameters',
      });
    }

    await authService.handleCallback(tokenId);

    return reply.send({
      success: true,
      message: 'Dhan authentication successful. Access token encrypted and saved.',
      status: authService.getStatus(),
    });
  });

  fastify.get('/auth/dhan/status', async (_request, reply) => {
    const status = authService.getStatus();
    return reply.send({
      success: true,
      data: status,
    });
  });

  fastify.post('/auth/dhan/disconnect', async (_request, reply) => {
    authService.disconnect();
    return reply.send({
      success: true,
      message: 'Disconnected from Dhan API',
    });
  });
};
