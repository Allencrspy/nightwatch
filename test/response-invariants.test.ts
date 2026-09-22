import { describe, it, expect } from 'vitest';
import {
  IntradaySetupSchema,
  IntradayAnalysisResponseSchema,
} from '../src/schemas/analysis-response.schema.js';

/**
 * These are the checks that matter. The previous suite asserted that fields
 * existed and were positive numbers, which every bug found in review passed:
 * a stop on the wrong side of entry, a score that disagreed with its own
 * factors, a risk-reward that did not describe its own levels, and a position
 * worth many times the account. Each one now has a test that fails.
 */

const goodBreakdown = {
  priceStructure: 20, volume: 20, relativeStrength: 15, breakoutQuality: 15,
  trend: 10, sector: 10, liquidity: 5, news: null,
  totalScore: 95, assessableMax: 95, unknownFactors: ['news'],
};

const goodStages = [
  { stage: 'priceMovement', part: 'Part 2 — price movement', outcome: 'PASS' as const, note: 'Up 2.10%.' },
  { stage: 'volume', part: 'Part 2 — volume', outcome: 'PASS' as const, note: '2.1x the 20-day average.' },
];

const goodSetup = {
  symbol: 'RELIANCE',
  bias: 'LONG' as const,
  tier: 'HIGH' as const,
  stages: goodStages,
  volumeCharacter: 'Breakout: cleared the 20-day swing high.',
  setupType: 'BREAKOUT' as const,
  score: 95,
  scoreBreakdown: goodBreakdown,
  close: 1400,
  entryTrigger: 1410,
  stopLoss: 1390,
  targets: [1450, 1480],
  riskRewardRatio: 2,
  invalidation: 'A 5-minute close back below 1390.',
  bullishScenario: 'Holds above 1410 on volume.',
  bearishScenario: 'Rejected at 1410 and loses 1390.',
  positionSizing: { recommendedShares: 50, positionValue: 70500, riskAmount: 1000 },
};

const expectRejected = (setup: unknown, matching: RegExp) => {
  const res = IntradaySetupSchema.safeParse(setup);
  expect(res.success).toBe(false);
  if (!res.success) {
    expect(res.error.issues.map((i) => i.message).join(' | ')).toMatch(matching);
  }
};

describe('setup invariants', () => {
  it('accepts a setup whose geometry holds', () => {
    expect(IntradaySetupSchema.safeParse(goodSetup).success).toBe(true);
  });

  it('rejects a long whose stop sits above entry', () => {
    expectRejected({ ...goodSetup, stopLoss: 1420 }, /stop must sit below entry/);
  });

  it('rejects a short whose stop sits below entry', () => {
    expectRejected(
      { ...goodSetup, bias: 'SHORT', stopLoss: 1400, entryTrigger: 1410, targets: [1370, 1340] },
      /stop must sit above entry/
    );
  });

  it('rejects a target on the wrong side of entry', () => {
    expectRejected({ ...goodSetup, targets: [1380, 1480] }, /T1 must sit above entry/);
  });

  it('rejects targets that are not ordered outward', () => {
    expectRejected({ ...goodSetup, targets: [1480, 1450] }, /T2 must sit beyond T1/);
  });

  it('rejects a stated risk-reward that does not match the levels', () => {
    // The shadowed-variable bug: levels say 2.0, the payload claims 5.0.
    expectRejected({ ...goodSetup, riskRewardRatio: 5 }, /states 5\.00 but entry\/stop\/T1 give 2\.00/);
  });

  it('rejects a total that disagrees with its own factors', () => {
    expectRejected(
      { ...goodSetup, scoreBreakdown: { ...goodBreakdown, totalScore: 82 }, score: 82 },
      /factors sum to 95 but totalScore says 82/
    );
  });

  it('rejects a total above the assessable maximum', () => {
    expectRejected(
      {
        ...goodSetup,
        score: 95,
        scoreBreakdown: { ...goodBreakdown, assessableMax: 90 },
      },
      /exceeds assessable maximum/
    );
  });

  it('requires a null factor to be declared unknown', () => {
    expectRejected(
      { ...goodSetup, scoreBreakdown: { ...goodBreakdown, unknownFactors: [] } },
      /news is null but is not listed in unknownFactors/
    );
  });

  it('rejects a non-positive price', () => {
    expect(IntradaySetupSchema.safeParse({ ...goodSetup, stopLoss: 0 }).success).toBe(false);
  });
});

const goodResponse = {
  generatedAt: new Date().toISOString(),
  analyst: 'RULE_ENGINE' as const,
  dataNotes: [],
  noHighQualitySetup: false,
  framework: {
    stageOrder: ['priceMovement', 'volume'],
    funnel: [{ stage: 'priceMovement', part: 'Part 2 — price movement', rejected: 61 }],
    universeSize: 80,
  },
  market: {
    bias: 'NEUTRAL' as const,
    nifty: { lastPrice: 23414.3, changePercent: 0.29 },
    bankNifty: { lastPrice: 56470.65, changePercent: 0.2 },
    strongestSectors: ['NIFTY PHARMA'],
    weakestSectors: ['NIFTY IT'],
    noTradeConditions: [],
  },
  setups: [goodSetup],
  top3BestSetups: ['RELIANCE'],
  topLongCandidates: ['RELIANCE'],
  topShortCandidates: [],
  stocksToAvoid: [],
  checklist900to915: [],
  skipped: [],
  riskManagement: {
    capital: 500000,
    riskPerTradePercent: 0.5,
    maxRiskPerTradeAmount: 2500,
    maxTrades: 3,
    dailyLossLimit: 5000,
    stopTradingConditions: [],
  },
};

describe('response invariants', () => {
  it('accepts a coherent plan', () => {
    expect(IntradayAnalysisResponseSchema.safeParse(goodResponse).success).toBe(true);
  });

  it('rejects a position larger than the account', () => {
    const res = IntradayAnalysisResponseSchema.safeParse({
      ...goodResponse,
      setups: [{ ...goodSetup, positionSizing: { recommendedShares: 6250, positionValue: 10681125, riskAmount: 2500 } }],
    });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.issues[0].message).toMatch(/exceeds capital/);
  });

  it('rejects risk above the per-trade cap', () => {
    const res = IntradayAnalysisResponseSchema.safeParse({
      ...goodResponse,
      setups: [{ ...goodSetup, positionSizing: { recommendedShares: 50, positionValue: 70500, riskAmount: 9000 } }],
    });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.issues[0].message).toMatch(/exceeds the per-trade cap/);
  });

  it('rejects a daily loss limit above 2% of capital', () => {
    // 2500 x 3 x 1.5 = 11250 on 5L, the old formula. That is 2.25%.
    const res = IntradayAnalysisResponseSchema.safeParse({
      ...goodResponse,
      riskManagement: { ...goodResponse.riskManagement, dailyLossLimit: 11250 },
    });
    expect(res.success).toBe(false);
    if (!res.success) expect(res.error.issues[0].message).toMatch(/exceeds 2% of capital/);
  });

  it('rejects a fabricated index price of zero', () => {
    const res = IntradayAnalysisResponseSchema.safeParse({
      ...goodResponse,
      market: { ...goodResponse.market, nifty: { lastPrice: 0, changePercent: 0.29 } },
    });
    expect(res.success).toBe(false);
  });
});
