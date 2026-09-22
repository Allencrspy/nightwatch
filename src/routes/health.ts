import type { FastifyPluginAsync } from 'fastify';

export const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/health', async () => {
    return {
      status: 'OK',
      timestamp: new Date().toISOString(),
      service: 'dhan-trading-analysis-api',
      version: '1.0.0',
    };
  });

  fastify.get('/', async () => {
    return {
      name: 'NSE Intraday Trading Analysis Backend API',
      status: 'ONLINE',
      docs: '/api/v1/intraday-analysis',
    };
  });
};
