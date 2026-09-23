import crypto from 'node:crypto';
import type { StockCandidateData } from '../scanner/candidate-scanner.js';
import type { ScoreBreakdown } from '../scoring/scoring-engine.js';
import type { QuoteWithChange } from '../dhan/dhan-market-data.service.js';
import type { UniverseRow } from './universe.js';
import { apiBrief, PROMPT_VERSION, type MarketContext } from './framework-prompt.js';
import { readPlan, type Plan } from './plan-reader.js';
import { runAnalyst, activeProvider } from './providers.js';
import { NotConfiguredError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

export interface ScoredCandidate {
  candidate: StockCandidateData;
  scoreBreakdown: ScoreBreakdown;
}

/** Everything a scan produces that the analyst, the brief and the monitor need. */
export interface AnalystInput {
  scoredCandidates: ScoredCandidate[];
  rejected: Array<{ symbol: string; stage: string; part: string; reason: string }>;
  stageOrder: readonly string[];
  funnel: Array<{ stage: string; part: string; rejected: number }>;
  universeSize: number;
  niftyQuote: QuoteWithChange;
  bankNiftyQuote: QuoteWithChange;
  niftyLastPrice: number;
  niftyChangePercent: number;
  bankNiftyLastPrice: number;
  bankNiftyChangePercent: number;
  sectorPerformances: Array<{ sector: string; changePercent: number }>;
  skipped: Array<{ symbol: string; reason: string }>;
  /** Previous closes for the whole resolved universe, for the monitor. */
  previousCloses: Record<string, number>;
  /** Every analysed F&O stock, for the analyst to scan itself (Part 2). */
  universe: UniverseRow[];
  capital: number;
  riskPercent: number;
  maxTrades: number;
}

export function marketContext(input: AnalystInput): MarketContext {
  const ist = new Date(Date.now() + 5.5 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 16);
  const idx = (q: QuoteWithChange) => ({
    lastPrice: q.lastPrice, changePercent: q.changePercent, open: q.open, high: q.high, low: q.low,
  });
  return {
    asOf: `${ist} IST`,
    nifty: idx(input.niftyQuote),
    bankNifty: idx(input.bankNiftyQuote),
    sectors: input.sectorPerformances,
    universe: input.universe,
  };
}

/**
 * The API path: the same prompt, the same data and the same reader as the
 * paste bridge, with a model called directly instead of a person pasting.
 *
 * There is deliberately no fallback analysis. An earlier version returned a
 * rule engine's setups when no model was configured, which put this code's
 * own trading judgement in front of the user as if it were the analysis.
 * Without a model, the answer is to use the paste bridge.
 */
export class AiAnalystService {
  public async analyze(input: AnalystInput): Promise<Plan> {
    if (!activeProvider()) {
      throw new NotConfiguredError(
        'An analyst model (ANTHROPIC_API_KEY or OPENAI_API_KEY) — or use the Analyst page to run the brief in ChatGPT'
      );
    }

    const briefId = `api-${crypto.randomBytes(6).toString('base64url')}`;
    const { system, user } = apiBrief({
      briefId, capital: input.capital, riskPercent: input.riskPercent, context: marketContext(input),
    });

    const result = await runAnalyst(system, user);
    logger.info({ model: result.model, usage: result.usage }, 'Analyst finished');

    return readPlan(result.json, {
      briefId,
      promptVersion: PROMPT_VERSION,
      source: 'api',
      universe: input.universe,
      capital: input.capital,
      riskPercent: input.riskPercent,
    });
  }
}
