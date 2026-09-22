import type { StockCandidateData } from '../scanner/candidate-scanner.js';
import type { ScoreBreakdown } from '../scoring/scoring-engine.js';
import type { QuoteWithChange } from '../dhan/dhan-market-data.service.js';

/**
 * The compact, fully-computed view of a session handed to the analyst.
 *
 * The split matters: everything here is arithmetic — EMAs, ATR, relative
 * volume, swing levels, relative strength — computed from Dhan's verified
 * candles before the model sees anything. The model never receives a raw
 * candle series and is never asked to calculate. Its job is the judgment the
 * framework actually calls for: what kind of setup this is, whether sector
 * conflict outweighs relative strength, what counts as too extended.
 *
 * Handing a model raw series and asking it to work out a 20-EMA is where
 * invented numbers come from, and it is entirely avoidable.
 */

export interface CandidateFacts {
  symbol: string;
  sector: string;

  // Today, from the live quote and history.
  prevClose: number;
  open: number;
  high: number;
  low: number;
  close: number;
  changePercent: number;
  closingStrength: number;

  // Participation.
  volume: number;
  avgVolume20: number;
  rvol: number;
  turnoverCr: number;

  // Structure.
  swingHigh20: number;
  swingLow20: number;
  support: number;
  resistance: number;
  breakoutType: string;

  // Trend.
  ema20: number;
  ema50: number;
  ema200: number;
  trendAlignment: string;
  distanceFromEma20Percent: number;

  // Volatility and extension.
  atr14: number;
  atrPercent: number;
  high52w: number;
  low52w: number;
  return4Session: number;

  // Relative strength.
  vsNiftyPercent: number;
  vsSectorPercent: number;
  sectorChangePercent: number | null;

  // Unknowns, stated rather than omitted.
  catalyst: string;
  fnoPositioning: string;

  /** What a mechanical reading of the framework concluded. Advisory only. */
  mechanical: {
    tier: string;
    bias: string;
    volumeCharacter: string | null;
    notes: Array<{ part: string; outcome: string; note: string | null }>;
    objections: Array<{ part: string; reason: string }>;
  };

  /** The deterministic score, for reference. The analyst sets its own. */
  referenceScore: number;
}

export interface MarketFacts {
  nifty: { lastPrice: number; changePercent: number; open: number; high: number; low: number };
  bankNifty: { lastPrice: number; changePercent: number; open: number; high: number; low: number };
  sectors: Array<{ sector: string; changePercent: number }>;
}

export interface FactSheet {
  asOf: string;
  market: MarketFacts;
  candidates: CandidateFacts[];
  /** Names a screen already removed, so the analyst can see what was excluded. */
  screenedOut: Array<{ symbol: string; stage: string; reason: string }>;
  dataCaveats: string[];
  risk: { capital: number; riskPercent: number; maxTrades: number; maxRiskPerTrade: number };
}

const r = (v: number, dp = 2) => Number(v.toFixed(dp));

export function candidateFacts(c: StockCandidateData, score: ScoreBreakdown): CandidateFacts {
  const q = c.quote as QuoteWithChange;
  const t = c.technical;

  return {
    symbol: q.symbol,
    sector: c.sectorName,

    prevClose: r(q.previousClose),
    open: r(q.open),
    high: r(q.high),
    low: r(q.low),
    close: r(q.lastPrice),
    changePercent: r(q.changePercent),
    closingStrength: r(t.closingStrength),

    volume: q.volume,
    avgVolume20: t.avgVolume20,
    rvol: r(t.rvol),
    turnoverCr: r(c.turnoverCr),

    swingHigh20: r(t.swingHigh20),
    swingLow20: r(t.swingLow20),
    support: r(t.supportLevel),
    resistance: r(t.resistanceLevel),
    breakoutType: t.breakoutType,

    ema20: r(t.ema20),
    ema50: r(t.ema50),
    ema200: r(t.ema200),
    trendAlignment: t.trendAlignment,
    distanceFromEma20Percent: r(t.distanceFromEma20Percent),

    atr14: r(t.atr14),
    atrPercent: r(t.atrPercent),
    high52w: r(t.high52w),
    low52w: r(t.low52w),
    return4Session: r(t.return4Session),

    vsNiftyPercent: r(c.relativeStrength.vsNiftyPercent),
    vsSectorPercent: r(c.relativeStrength.vsSectorPercent),
    sectorChangePercent: null, // filled by the builder, which knows the sector table

    catalyst: c.news.available
      ? (c.news.headline ?? 'none found')
      : 'UNKNOWN — no news source is configured. Do not infer a catalyst.',
    fnoPositioning: c.fno.available
      ? c.fno.positioning
      : 'UNKNOWN — cash-equity quotes carry no open interest. Do not infer positioning.',

    mechanical: {
      tier: c.filters.tier,
      bias: c.candidateBias,
      volumeCharacter: c.filters.volumeCharacter,
      notes: c.filters.stages
        .filter((s) => s.outcome !== 'PASS')
        .map((s) => ({ part: s.part, outcome: s.outcome, note: s.note })),
      // Objections strong enough that a mechanical reading would have
      // rejected the name outright. The analyst may still disagree.
      objections: c.filters.concerns.map((x) => ({ part: x.part, reason: x.reason })),
    },

    referenceScore: score.totalScore,
  };
}

export function buildFactSheet(input: {
  scored: Array<{ candidate: StockCandidateData; scoreBreakdown: ScoreBreakdown }>;
  screenedOut: Array<{ symbol: string; stage: string; reason: string }>;
  nifty: QuoteWithChange;
  bankNifty: QuoteWithChange;
  sectors: Array<{ sector: string; changePercent: number }>;
  capital: number;
  riskPercent: number;
  maxTrades: number;
}): FactSheet {
  const sectorByName = new Map(input.sectors.map((s) => [s.sector, s.changePercent]));

  const candidates = input.scored.map(({ candidate, scoreBreakdown }) => {
    const facts = candidateFacts(candidate, scoreBreakdown);
    facts.sectorChangePercent = sectorByName.get(candidate.sectorName) ?? null;
    return facts;
  });

  return {
    asOf: new Date().toISOString(),
    market: {
      nifty: {
        lastPrice: r(input.nifty.lastPrice), changePercent: r(input.nifty.changePercent),
        open: r(input.nifty.open), high: r(input.nifty.high), low: r(input.nifty.low),
      },
      bankNifty: {
        lastPrice: r(input.bankNifty.lastPrice), changePercent: r(input.bankNifty.changePercent),
        open: r(input.bankNifty.open), high: r(input.bankNifty.high), low: r(input.bankNifty.low),
      },
      sectors: input.sectors.map((s) => ({ sector: s.sector, changePercent: r(s.changePercent) })),
    },
    candidates,
    screenedOut: input.screenedOut,
    dataCaveats: [
      'Open interest is unavailable on cash-equity quotes, so F&O positioning is UNKNOWN for every name. Do not assign it.',
      'No news source is configured, so catalysts are UNKNOWN. Say so rather than inferring why a stock moved.',
      'Every figure above was computed from Dhan market data. Use these numbers; do not introduce others.',
    ],
    risk: {
      capital: input.capital,
      riskPercent: input.riskPercent,
      maxTrades: input.maxTrades,
      maxRiskPerTrade: r((input.capital * input.riskPercent) / 100),
    },
  };
}
