import Fastify from 'fastify';
import cors from '@fastify/cors';
import { ZodError } from 'zod';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { analysisRoutes } from './routes/analysis.js';
import { analystRoutes } from './routes/analyst.js';
import { monitorRoutes } from './routes/monitor.js';
import { env } from './config/env.js';
import { AppError } from './utils/errors.js';
import { logger } from './utils/logger.js';

export function buildApp() {
  const app = Fastify({ logger: false });

  // Allowlist, not `origin: true`. The dashboard's origin, plus localhost in dev.
  const allowed = new Set<string>([env.FRONTEND_ORIGIN, env.APP_BASE_URL]);
  app.register(cors, {
    origin(origin, cb) {
      // No Origin header: curl, Postman, or the OAuth redirect itself.
      if (!origin) return cb(null, true);
      if (allowed.has(origin)) return cb(null, true);
      if (env.NODE_ENV !== 'production' && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
        return cb(null, true);
      }
      cb(new Error(`Origin ${origin} is not allowed`), false);
    },
    methods: ['GET', 'POST'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof AppError) {
      logger.warn({ code: error.code, path: request.url }, error.message);
      return reply.status(error.statusCode).send({
        success: false,
        error: error.code,
        message: error.message,
        detail: error.detail,
      });
    }

    if (error instanceof ZodError) {
      return reply.status(400).send({
        success: false,
        error: 'INVALID_REQUEST',
        message: 'Request failed validation.',
        detail: error.issues,
      });
    }

    logger.error({ error: error.message, stack: error.stack, path: request.url }, 'Unhandled error');
    return reply.status(error.statusCode || 500).send({
      success: false,
      error: 'INTERNAL_ERROR',
      message: error.message,
    });
  });

  app.register(healthRoutes);
  app.register(authRoutes);
  app.register(analysisRoutes);
  app.register(analystRoutes);
  app.register(monitorRoutes);

  return app;
}
