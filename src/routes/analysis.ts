import type { FastifyPluginAsync } from 'fastify';
import { IntradayAnalysisRequestSchema } from '../schemas/analysis-request.schema.js';
import { IntradayAnalysisResponseSchema } from '../schemas/analysis-response.schema.js';
import { CandidateScannerService } from '../services/scanner/candidate-scanner.js';
import { ScoringEngineService } from '../services/scoring/scoring-engine.js';
import { AiAnalystService } from '../services/ai/ai-analyst.service.js';
import { DhanMarketDataService } from '../services/dhan/dhan-market-data.service.js';
import { DhanAuthService } from '../services/auth/dhan-auth.service.js';
import { requireSession } from '../plugins/require-session.js';
import { NotAuthenticatedError, AppError } from '../utils/errors.js';
import { FNO_STOCK_UNIVERSE } from '../config/constants.js';
import { logger } from '../utils/logger.js';

export const analysisRoutes: FastifyPluginAsync = async (fastify) => {
  const aiAnalyst = new AiAnalystService();
  const auth = DhanAuthService.getInstance();

  fastify.post(
    '/api/v1/intraday-analysis',
    { preHandler: requireSession },
    async (request, reply) => {
      const { capital, riskPercent, maxTrades } = IntradayAnalysisRequestSchema.parse(request.body || {});

      const sessionId = request.sessionId as string;
      const accessToken = auth.getAccessToken(sessionId);
      const clientId = auth.getClientId(sessionId);
      if (!accessToken || !clientId) throw new NotAuthenticatedError();

      logger.info({ capital, riskPercent, maxTrades }, 'Running intraday analysis');

      // Session-scoped client: every Dhan call is made as the logged-in user.
      const market = new DhanMarketDataService(accessToken, clientId);
      const scanner = new CandidateScannerService(market);

      const scan = await scanner.scanUniverse();

      const marketBias =
        (scan.niftyQuote.changePercent + scan.bankNiftyQuote.changePercent) / 2 >= 0.5
          ? 'BULLISH'
          : (scan.niftyQuote.changePercent + scan.bankNiftyQuote.changePercent) / 2 <= -0.5
            ? 'BEARISH'
            : 'NEUTRAL';

      const scoredCandidates = scan.candidates.map((candidate) => ({
        candidate,
        scoreBreakdown: ScoringEngineService.calculateScore(candidate, marketBias),
      }));

      const plan = await aiAnalyst.analyzeIntradaySetups({
        scoredCandidates,
        rejected: scan.rejected.map((r) => ({
          symbol: r.quote.symbol,
          stage: r.filters.rejectedBy ?? 'unknown',
          part: r.filters.stages[r.filters.stages.length - 1]?.part ?? 'unknown',
          reason: r.filters.reason ?? 'No reason recorded.',
        })),
        stageOrder: scan.stageOrder,
        funnel: scan.funnel,
        universeSize: FNO_STOCK_UNIVERSE.length,
        niftyLastPrice: scan.niftyQuote.lastPrice,
        niftyChangePercent: scan.niftyQuote.changePercent,
        bankNiftyLastPrice: scan.bankNiftyQuote.lastPrice,
        bankNiftyChangePercent: scan.bankNiftyQuote.changePercent,
        sectorPerformances: scan.sectorPerformances,
        skipped: scan.skipped,
        capital,
        riskPercent,
        maxTrades,
      });

      // The schema enforces geometry, not just shape. A setup that fails here
      // is a bug worth surfacing, not something to ship to the dashboard.
      const parsed = IntradayAnalysisResponseSchema.safeParse(plan);
      if (!parsed.success) {
        logger.error({ issues: parsed.error.issues }, 'Generated plan failed its own invariants');
        throw new AppError(
          500,
          'INVALID_PLAN',
          'The generated plan failed validation and was withheld.',
          parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
        );
      }

      return reply.send({ success: true, data: parsed.data });
    }
  );
};
