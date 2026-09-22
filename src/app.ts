import Fastify from 'fastify';
import cors from '@fastify/cors';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { analysisRoutes } from './routes/analysis.js';
import { logger } from './utils/logger.js';

export function buildApp() {
  const app = Fastify({
    logger: false, // We use custom Pino logger instance
  });

  app.register(cors, {
    origin: true,
  });

  app.setErrorHandler((error, _request, reply) => {
    logger.error({ error: error.message, stack: error.stack }, 'Fastify Unhandled Error');
    reply.status(error.statusCode || 500).send({
      success: false,
      error: error.name || 'InternalServerError',
      message: error.message,
    });
  });

  // Register Routes
  app.register(healthRoutes);
  app.register(authRoutes);
  app.register(analysisRoutes);

  return app;
}
