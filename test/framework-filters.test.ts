import { describe, it, expect } from 'vitest';
import { runFramework, STAGE_ORDER } from '../src/services/scanner/framework-filters.js';
import type { StockCandidateData } from '../src/services/scanner/candidate-scanner.js';
import type { TechnicalMetrics } from '../src/services/technical/indicators.js';

/**
 * Calibration against the worked example in the night-before scan. The
 * pipeline should reproduce that scan's own verdicts: a pharma long clears,
 * a relative-strength long in a weak sector is watchlist-only, an 8%-on-top-
 * of-15% gainer is demoted for extension, and a genuinely weak stock with
 * support immediately below it is rejected for risk/reward.
 */

const technical = (over: Partial<TechnicalMetrics> = {}): TechnicalMetrics => ({
  ema20: 1820, ema50: 1800, ema200: 1750,
  rvol: 1.62, avgVolume20: 1_560_000, todayVolume: 2_530_000,
  swingHigh20: 1880, swingLow20: 1790,
  supportLevel: 1832.2, resistanceLevel: 1880,
  closingStrength: 0.75,
  trendAlignment: 'STRONG_BULLISH',
  breakoutType: 'BREAKOUT',
  atr14: 31.4, atrPercent: 1.71,
  high52w: 2046.9, low52w: 1500,
  yearWindowIncomplete: false,
  return4Session: 3.2,
  distanceFromEma20Percent: 2.6,
  ...over,
});

const candidate = (over: Partial<StockCandidateData> = {}): StockCandidateData => ({
  quote: {
    symbol: 'SUNPHARMA', securityId: '3351',
    lastPrice: 1868.9, open: 1840, high: 1891.5, low: 1832.2,
    close: 1868.9, previousClose: 1837.3, change: 31.6, changePercent: 1.72,
    volume: 2_530_000, openInterest: null, oiChangePercent: null,
    unavailable: ['openInterest', 'oiChangePercent'],
  },
  sectorName: 'NIFTY PHARMA',
  turnoverCr: 472.8,
  technical: technical(),
  relativeStrength: {
    vsNiftyPercent: 1.43, vsSectorPercent: 0.56,
    outperformingNifty: true, outperformingSector: true,
  },
  fno: {
    positioning: 'UNKNOWN', interpretation: 'Open interest unavailable.',
    available: false, isBullish: false, isBearish: false,
    oiChangePercent: null, openInterest: null,
  },
  news: { available: false, hasNews: false, sentiment: 'UNKNOWN', score: null, note: '' },
  candidateBias: 'LONG',
  filters: { symbol: 'SUNPHARMA', tier: 'REJECTED', stages: [], rejectedBy: null, reason: null, volumeCharacter: null },
  ...over,
});

const ctx = { sectorChangePercent: 1.16, niftyChangePercent: 0.29 };

describe('framework order', () => {
  it('runs the stages in the framework\'s order', () => {
    expect([...STAGE_ORDER]).toEqual([
      'priceMovement', 'volume', 'priceStructure', 'trend', 'setup',
      'closingStrength', 'relativeStrength', 'sector', 'newsCatalyst',
      'fnoPositioning', 'liquidity', 'riskReward', 'extension',
    ]);
  });

  it('stops at the first rejection and names the stage', () => {
    // Below the +/-1.5% band: Part 2 should stop it before anything else runs.
    const trace = runFramework(candidate({
      quote: { ...candidate().quote, changePercent: 0.4 },
    }), ctx);

    expect(trace.tier).toBe('REJECTED');
    expect(trace.rejectedBy).toBe('priceMovement');
    expect(trace.stages).toHaveLength(1);
    expect(trace.reason).toMatch(/inside the \+\/-1.5% band/);
  });

  it('records a note for every stage that ran', () => {
    const trace = runFramework(candidate(), ctx);
    expect(trace.stages).toHaveLength(STAGE_ORDER.length);
    expect(trace.stages.every((s) => s.note && s.note.length > 0)).toBe(true);
    expect(trace.stages.map((s) => s.stage)).toEqual([...STAGE_ORDER]);
  });
});

describe('Part 2 — volume is not a signal by itself', () => {
  it('answers what the volume accompanied', () => {
    const trace = runFramework(candidate(), ctx);
    expect(trace.volumeCharacter).toMatch(/Breakout/);
  });

  it('calls out volume that accompanied a reversal, not buying', () => {
    // Up on the day, but closed near the low: sellers took it back.
    const trace = runFramework(candidate({
      technical: technical({ closingStrength: 0.2, breakoutType: 'CONSOLIDATION' }),
    }), ctx);
    expect(trace.volumeCharacter).toMatch(/Reversal against the move/);
  });

  it('rejects a move that ran on below-average volume', () => {
    const trace = runFramework(candidate({
      technical: technical({ rvol: 0.55, todayVolume: 157_900, avgVolume20: 288_100 }),
    }), ctx);
    expect(trace.rejectedBy).toBe('volume');
    expect(trace.reason).toMatch(/below-average participation/);
  });
});

describe('Part 3 — moving averages are never automatic signals', () => {
  it('demotes a trade against the EMA structure instead of rejecting it', () => {
    const trace = runFramework(candidate({
      technical: technical({ ema20: 1900, ema50: 1950, trendAlignment: 'BEARISH' }),
    }), ctx);
    expect(trace.rejectedBy).not.toBe('trend');
    expect(trace.tier).toBe('WATCHLIST');
    expect(trace.stages.find((s) => s.stage === 'trend')?.outcome).toBe('DEMOTE');
  });
});

describe('Part 7 — sector', () => {
  it('clears a long whose sector confirms it', () => {
    const trace = runFramework(candidate(), ctx);
    expect(trace.stages.find((s) => s.stage === 'sector')?.outcome).toBe('PASS');
    expect(trace.tier).toBe('HIGH');
  });

  it('demotes relative strength in a weak sector to watchlist', () => {
    const trace = runFramework(candidate({ sectorName: 'NIFTY IT' }), {
      sectorChangePercent: -0.8,
      niftyChangePercent: 0.29,
    });
    expect(trace.tier).toBe('WATCHLIST');
    expect(trace.stages.find((s) => s.stage === 'sector')?.outcome).toBe('DEMOTE');
    expect(trace.rejectedBy).toBeNull();
  });
});

describe('Part 13 — risk/reward as room to move', () => {
  it('rejects a short whose support sits immediately below it', () => {
    // Real weakness, but the 52-week low is barely under the trigger.
    const trace = runFramework(candidate({
      quote: {
        ...candidate().quote, symbol: 'BHARTIARTL',
        lastPrice: 1830.2, high: 1868, low: 1825, changePercent: -3.33,
      },
      technical: technical({
        closingStrength: 0.12, breakoutType: 'BREAKDOWN',
        supportLevel: 1825, resistanceLevel: 1868,
        swingHigh20: 1900, swingLow20: 1826,
        low52w: 1800, high52w: 2000,
        ema20: 1900, ema50: 1920, trendAlignment: 'BEARISH',
        return4Session: -2, distanceFromEma20Percent: -3.7,
      }),
      relativeStrength: {
        vsNiftyPercent: -3.62, vsSectorPercent: -2.1,
        outperformingNifty: false, outperformingSector: false,
      },
      candidateBias: 'SHORT',
    }), { sectorChangePercent: -0.9, niftyChangePercent: 0.29 });

    expect(trace.rejectedBy).toBe('riskReward');
    expect(trace.reason).toMatch(/Poor risk\/reward/);
  });
});

describe('Part 19 — extension', () => {
  it('demotes a strong move sitting on a multi-session run', () => {
    const trace = runFramework(candidate({
      quote: { ...candidate().quote, symbol: 'PATANJALI', changePercent: 7.96 },
      technical: technical({ atrPercent: 3.0, return4Session: 15, distanceFromEma20Percent: 9 }),
    }), ctx);

    expect(trace.tier).toBe('WATCHLIST');
    const extension = trace.stages.find((s) => s.stage === 'extension');
    expect(extension?.outcome).toBe('DEMOTE');
    expect(extension?.note).toMatch(/Watch rather than chase/);
  });

  it('rejects a move far beyond its own volatility', () => {
    const trace = runFramework(candidate({
      quote: { ...candidate().quote, changePercent: 9.5 },
      technical: technical({ atrPercent: 2.0, return4Session: 20 }),
    }), ctx);

    expect(trace.rejectedBy).toBe('extension');
    expect(trace.reason).toMatch(/Too extended to chase/);
  });

  it('clears a move in line with its own ATR', () => {
    const trace = runFramework(candidate(), ctx);
    expect(trace.stages.find((s) => s.stage === 'extension')?.outcome).toBe('PASS');
  });
});
