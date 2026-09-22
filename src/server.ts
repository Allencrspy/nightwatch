import { buildApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';

async function startServer() {
  const app = buildApp();

  try {
    const address = await app.listen({ port: env.PORT, host: env.HOST });
    logger.info(`🚀 Dhan Trading Analysis API Server listening at ${address}`);
    logger.info(`📊 Health check: ${address}/health`);
    logger.info(`🔐 Dhan Auth Status: ${address}/auth/dhan/status`);
    logger.info(`🎯 Intraday Analysis Endpoint: POST ${address}/api/v1/intraday-analysis`);
  } catch (err: any) {
    logger.error({ error: err.message }, 'Failed to start Fastify server');
    process.exit(1);
  }
}

startServer();
