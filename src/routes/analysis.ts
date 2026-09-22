import type { FastifyPluginAsync } from 'fastify';
import { IntradayAnalysisRequestSchema } from '../schemas/analysis-request.schema.js';
import { IntradayAnalysisResponseSchema } from '../schemas/analysis-response.schema.js';
import { CandidateScannerService } from '../services/scanner/candidate-scanner.js';
import { ScoringEngineService } from '../services/scoring/scoring-engine.js';
import { AiAnalystService } from '../services/ai/ai-analyst.service.js';
import { logger } from '../utils/logger.js';

export const analysisRoutes: FastifyPluginAsync = async (fastify) => {
  const scannerService = new CandidateScannerService();
  const aiAnalystService = new AiAnalystService();

  fastify.post('/api/v1/intraday-analysis', async (request, reply) => {
    try {
      const body = IntradayAnalysisRequestSchema.parse(request.body || {});
      const { capital, riskPercent, maxTrades } = body;

      logger.info({ capital, riskPercent, maxTrades }, 'Executing Intraday Stock Selection Analysis API');

      // 1. Scan NSE F&O Universe & calculate technicals
      const scanResult = await scannerService.scanUniverse();

      // Determine market bias
      const niftyChange = scanResult.niftyQuote.changePercent;
      const bankNiftyChange = scanResult.bankNiftyQuote.changePercent;
      const marketBias = (niftyChange + bankNiftyChange) / 2 >= 0.5 ? 'BULLISH' : (niftyChange + bankNiftyChange) / 2 <= -0.5 ? 'BEARISH' : 'NEUTRAL';

      // 2. Compute 100-point deterministic scores for candidates
      const scoredCandidates = scanResult.candidates.map((candidate) => ({
        candidate,
        scoreBreakdown: ScoringEngineService.calculateScore(candidate, marketBias),
      }));

      // 3. AI / LLM Reasoning & setup synthesis
      const responsePlan = await aiAnalystService.analyzeIntradaySetups(
        scoredCandidates,
        niftyChange,
        bankNiftyChange,
        scanResult.sectorPerformances,
        capital,
        riskPercent,
        maxTrades
      );

      // Validate output schema
      const validated = IntradayAnalysisResponseSchema.parse(responsePlan);

      return reply.send({
        success: true,
        data: validated,
      });
    } catch (err: any) {
      logger.error({ error: err.message, stack: err.stack }, 'Failed to process intraday analysis request');
      return reply.status(500).send({
        success: false,
        error: 'Failed to generate intraday trading analysis',
        message: err.message,
      });
    }
  });
};
