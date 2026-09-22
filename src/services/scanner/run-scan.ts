import type { FastifyRequest } from 'fastify';
import { CandidateScannerService } from './candidate-scanner.js';
import { ScoringEngineService } from '../scoring/scoring-engine.js';
import { DhanMarketDataService } from '../dhan/dhan-market-data.service.js';
import { DhanAuthService } from '../auth/dhan-auth.service.js';
import { FNO_STOCK_UNIVERSE } from '../../config/constants.js';
import { NotAuthenticatedError } from '../../utils/errors.js';
import type { AnalystInput } from '../ai/ai-analyst.service.js';

/**
 * Runs a full scan for the caller's Dhan session and shapes it for the
 * analyst. Shared by the direct API route and the paste bridge so both see
 * an identical view of the session — two paths producing different facts for
 * the same evening would be a quiet, hard-to-spot divergence.
 */
export async function buildAnalystInput(
  request: FastifyRequest,
  opts: { capital: number; riskPercent: number; maxTrades: number }
): Promise<AnalystInput> {
  const auth = DhanAuthService.getInstance();
  const sessionId = request.sessionId as string;
  const accessToken = auth.getAccessToken(sessionId);
  const clientId = auth.getClientId(sessionId);
  if (!accessToken || !clientId) throw new NotAuthenticatedError();

  const market = new DhanMarketDataService(accessToken, clientId);
  const scan = await new CandidateScannerService(market).scanUniverse();

  const avg = (scan.niftyQuote.changePercent + scan.bankNiftyQuote.changePercent) / 2;
  const marketBias = avg >= 0.5 ? 'BULLISH' : avg <= -0.5 ? 'BEARISH' : 'NEUTRAL';

  return {
    scoredCandidates: scan.candidates.map((candidate) => ({
      candidate,
      scoreBreakdown: ScoringEngineService.calculateScore(candidate, marketBias),
    })),
    rejected: scan.rejected.map((r) => ({
      symbol: r.quote.symbol,
      stage: r.filters.rejectedBy ?? 'unknown',
      part: r.filters.stages[r.filters.stages.length - 1]?.part ?? 'unknown',
      reason: r.filters.reason ?? 'No reason recorded.',
    })),
    stageOrder: scan.stageOrder,
    funnel: scan.funnel,
    universeSize: FNO_STOCK_UNIVERSE.length,
    niftyQuote: scan.niftyQuote,
    bankNiftyQuote: scan.bankNiftyQuote,
    niftyLastPrice: scan.niftyQuote.lastPrice,
    niftyChangePercent: scan.niftyQuote.changePercent,
    bankNiftyLastPrice: scan.bankNiftyQuote.lastPrice,
    bankNiftyChangePercent: scan.bankNiftyQuote.changePercent,
    sectorPerformances: scan.sectorPerformances,
    skipped: scan.skipped,
    previousCloses: scan.previousCloses,
    capital: opts.capital,
    riskPercent: opts.riskPercent,
    maxTrades: opts.maxTrades,
  };
}
