import type { FastifyPluginAsync } from 'fastify';
import { IntradayAnalysisRequestSchema } from '../schemas/analysis-request.schema.js';
import { AiAnalystService } from '../services/ai/ai-analyst.service.js';
import { buildAnalystInput } from '../services/scanner/run-scan.js';
import { requireSession } from '../plugins/require-session.js';
import { logger } from '../utils/logger.js';

export const analysisRoutes: FastifyPluginAsync = async (fastify) => {
  const aiAnalyst = new AiAnalystService();

  fastify.post(
    '/api/v1/intraday-analysis',
    { preHandler: requireSession },
    async (request, reply) => {
      const { capital, riskPercent, maxTrades } = IntradayAnalysisRequestSchema.parse(request.body || {});
      logger.info({ capital, riskPercent, maxTrades }, 'Running intraday analysis');

      const input = await buildAnalystInput(request, { capital, riskPercent, maxTrades });
      const plan = await aiAnalyst.analyze(input);
      return reply.send({ success: true, data: plan });
    }
  );
};
