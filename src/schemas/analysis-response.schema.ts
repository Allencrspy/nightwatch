import { z } from 'zod';

/**
 * Shape *and* sanity. The previous version validated that fields existed and
 * were numbers, which a stop on the wrong side of entry passes happily. These
 * invariants are the ones the dashboard was having to re-check client-side;
 * they belong here, where a bad setup never leaves the building.
 */

const price = z.number().finite().positive();

export const ScoreBreakdownSchema = z.object({
  priceStructure: z.number().min(0).max(20),
  volume: z.number().min(0).max(20),
  relativeStrength: z.number().min(0).max(15),
  breakoutQuality: z.number().min(0).max(15),
  trend: z.number().min(0).max(10),
  sector: z.number().min(0).max(10),
  liquidity: z.number().min(0).max(5),
  /** Null means unassessed, and is excluded from both sum and denominator. */
  news: z.number().min(0).max(5).nullable(),
  totalScore: z.number().min(0).max(100),
  assessableMax: z.number().min(1).max(100),
  unknownFactors: z.array(z.string()),
});

const FACTOR_KEYS = [
  'priceStructure', 'volume', 'relativeStrength', 'breakoutQuality',
  'trend', 'sector', 'liquidity', 'news',
] as const;

export const StageResultSchema = z.object({
  stage: z.string(),
  part: z.string(),
  outcome: z.enum(['PASS', 'DEMOTE', 'REJECT']),
  note: z.string().nullable(),
});

export const IntradaySetupSchema = z
  .object({
    symbol: z.string().min(1),
    bias: z.enum(['LONG', 'SHORT']),
    /** HIGH cleared every stage; WATCHLIST was demoted by at least one. */
    tier: z.enum(['HIGH', 'WATCHLIST']),
    /** Every framework stage that ran, in order, with what it concluded. */
    stages: z.array(StageResultSchema).min(1),
    /** Part 2: what the volume actually accompanied. */
    volumeCharacter: z.string().nullable(),
    /** Part 15: what to do at each opening gap. Per setup, not generic. */
    gapPlan: z.array(z.object({ condition: z.string(), action: z.string().min(1) })).default([]),
    /** Fact then interpretation, in the analyst's words. */
    why: z.string().default(''),
    setupType: z.enum([
      'BREAKOUT', 'BREAKDOWN', 'CONTINUATION', 'PULLBACK', 'SUPPORT_REVERSAL', 'RESISTANCE_REJECTION',
    ]),
    score: z.number().min(0).max(100),
    scoreBreakdown: ScoreBreakdownSchema,
    close: price,
    entryTrigger: price,
    stopLoss: price,
    targets: z.array(price).length(2),
    riskRewardRatio: z.number().positive(),
    invalidation: z.string().min(1),
    bullishScenario: z.string().min(1),
    bearishScenario: z.string().min(1),
    positionSizing: z.object({
      recommendedShares: z.number().int().nonnegative(),
      positionValue: z.number().nonnegative(),
      riskAmount: z.number().nonnegative(),
    }),
  })
  .superRefine((s, ctx) => {
    const long = s.bias === 'LONG';
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message: `${s.symbol}: ${message}` });

    // Direction invariants — the class of bug that reads as a valid setup.
    if (long && s.stopLoss >= s.entryTrigger) fail('stopLoss', 'stop must sit below entry for a long');
    if (!long && s.stopLoss <= s.entryTrigger) fail('stopLoss', 'stop must sit above entry for a short');

    s.targets.forEach((t, i) => {
      if (long && t <= s.entryTrigger) fail('targets', `T${i + 1} must sit above entry for a long`);
      if (!long && t >= s.entryTrigger) fail('targets', `T${i + 1} must sit below entry for a short`);
    });

    // Targets must be ordered outward from entry.
    const [t1, t2] = s.targets;
    if (long && t2 <= t1) fail('targets', 'T2 must sit beyond T1 for a long');
    if (!long && t2 >= t1) fail('targets', 'T2 must sit beyond T1 for a short');

    // Stated risk-reward must match the geometry it claims to describe.
    const risk = Math.abs(s.entryTrigger - s.stopLoss);
    if (risk > 0) {
      const computed = Math.abs(t1 - s.entryTrigger) / risk;
      if (Math.abs(computed - s.riskRewardRatio) > 0.05) {
        fail('riskRewardRatio', `states ${s.riskRewardRatio.toFixed(2)} but entry/stop/T1 give ${computed.toFixed(2)}`);
      }
    }

    // Score must equal the factors it is made of, and respect its own ceiling.
    const bd = s.scoreBreakdown;
    const sum = FACTOR_KEYS.reduce((a, k) => a + (bd[k] ?? 0), 0);
    if (Math.abs(sum - bd.totalScore) > 0.01) {
      fail('scoreBreakdown', `factors sum to ${sum} but totalScore says ${bd.totalScore}`);
    }
    if (bd.totalScore > bd.assessableMax) {
      fail('scoreBreakdown', `totalScore ${bd.totalScore} exceeds assessable maximum ${bd.assessableMax}`);
    }
    if (Math.abs(s.score - bd.totalScore) > 0.01) {
      fail('score', `score ${s.score} disagrees with breakdown total ${bd.totalScore}`);
    }
    if (bd.news === null && !bd.unknownFactors.includes('news')) {
      fail('scoreBreakdown', 'news is null but is not listed in unknownFactors');
    }
  });

export const IntradayAnalysisResponseSchema = z
  .object({
    generatedAt: z.string(),
    /** How the setups were produced, so the dashboard never has to guess. */
    analyst: z.enum(['OPENAI', 'RULE_ENGINE']),
    /** Which prompt produced this. A changed prompt is a changed system. */
    promptVersion: z.string().nullable().default(null),
    /** The exact model, so the outcome log can compare like with like. */
    analystModel: z.string().nullable().default(null),
    /** Sources the analyst consulted when researching catalysts. */
    sources: z.array(z.object({ title: z.string(), url: z.string() })).default([]),
    /** Setups the analyst proposed that were rejected here, and why. */
    droppedSetups: z.array(z.object({ symbol: z.string(), reason: z.string() })).default([]),
    /** The analyst's own argument against tonight's list. */
    selfCritique: z.string().nullable().default(null),
    dataNotes: z.array(z.string()),
    /** Part 10 rule: never force a trade. True when nothing cleared every stage. */
    noHighQualitySetup: z.boolean(),
    /** The framework as executed: stage order and how many each stage removed. */
    framework: z.object({
      stageOrder: z.array(z.string()).min(1),
      funnel: z.array(z.object({
        stage: z.string(),
        part: z.string(),
        rejected: z.number().int().nonnegative(),
      })),
      universeSize: z.number().int().nonnegative(),
    }),
    market: z.object({
      bias: z.enum(['BULLISH', 'BEARISH', 'NEUTRAL']),
      nifty: z.object({ lastPrice: price, changePercent: z.number() }),
      bankNifty: z.object({ lastPrice: price, changePercent: z.number() }),
      strongestSectors: z.array(z.string()),
      weakestSectors: z.array(z.string()),
      noTradeConditions: z.array(z.string()),
    }),
    setups: z.array(IntradaySetupSchema),
    top3BestSetups: z.array(z.string()),
    topLongCandidates: z.array(z.string()),
    topShortCandidates: z.array(z.string()),
    /** Part 19: every name a stage removed, with the stage that removed it. */
    stocksToAvoid: z.array(z.object({
      symbol: z.string(),
      stage: z.string(),
      part: z.string(),
      reason: z.string().min(1),
    })),
    checklist900to915: z.array(z.string()),
    /** Symbols the scan could not evaluate. Empty is fine; hidden is not. */
    skipped: z.array(z.object({ symbol: z.string(), reason: z.string() })),
    riskManagement: z.object({
      capital: z.number().positive(),
      riskPerTradePercent: z.number().positive(),
      maxRiskPerTradeAmount: z.number().positive(),
      maxTrades: z.number().int().positive(),
      dailyLossLimit: z.number().positive(),
      stopTradingConditions: z.array(z.string()),
    }),
  })
  .superRefine((r, ctx) => {
    const { capital, maxRiskPerTradeAmount, dailyLossLimit } = r.riskManagement;

    // A position larger than the account is not a position, it is a typo.
    r.setups.forEach((s, i) => {
      if (s.positionSizing.positionValue > capital) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['setups', i, 'positionSizing', 'positionValue'],
          message: `${s.symbol}: position value ${s.positionSizing.positionValue} exceeds capital ${capital}`,
        });
      }
      if (s.positionSizing.riskAmount > maxRiskPerTradeAmount + 0.01) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['setups', i, 'positionSizing', 'riskAmount'],
          message: `${s.symbol}: risk ${s.positionSizing.riskAmount} exceeds the per-trade cap ${maxRiskPerTradeAmount}`,
        });
      }
    });

    // "Do not force a trade." A top-tier setup and the no-setup flag cannot coexist.
    if (r.noHighQualitySetup && r.setups.some((s) => s.tier === 'HIGH')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['noHighQualitySetup'],
        message: 'noHighQualitySetup is true but a HIGH tier setup was returned',
      });
    }
    if (!r.noHighQualitySetup && r.setups.length > 0 && !r.setups.some((s) => s.tier === 'HIGH')) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['noHighQualitySetup'],
        message: 'no HIGH tier setup was returned but noHighQualitySetup is false',
      });
    }
    // Part 12 asks for roughly 5-10 names, with the best three highlighted.
    if (r.top3BestSetups.length > 3) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['top3BestSetups'],
        message: `top3BestSetups holds ${r.top3BestSetups.length} entries`,
      });
    }

    if (dailyLossLimit > capital * 0.02) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['riskManagement', 'dailyLossLimit'],
        message: `daily loss limit ${dailyLossLimit} exceeds 2% of capital`,
      });
    }
  });

export type IntradaySetup = z.infer<typeof IntradaySetupSchema>;
export type IntradayAnalysisResponse = z.infer<typeof IntradayAnalysisResponseSchema>;
