import { z } from 'zod';

export const ScoreBreakdownSchema = z.object({
  priceStructure: z.number(),
  volume: z.number(),
  relativeStrength: z.number(),
  breakoutQuality: z.number(),
  trend: z.number(),
  sector: z.number(),
  liquidity: z.number(),
  news: z.number(),
  totalScore: z.number(),
});

export const IntradaySetupSchema = z.object({
  symbol: z.string(),
  bias: z.enum(['LONG', 'SHORT']),
  setupType: z.enum(['BREAKOUT', 'BREAKDOWN', 'CONTINUATION', 'PULLBACK', 'SUPPORT_REVERSAL', 'RESISTANCE_REJECTION']),
  score: z.number(),
  scoreBreakdown: ScoreBreakdownSchema,
  close: z.number(),
  entryTrigger: z.number(),
  stopLoss: z.number(),
  targets: z.array(z.number()).length(2),
  riskRewardRatio: z.number(),
  invalidation: z.string(),
  bullishScenario: z.string(),
  bearishScenario: z.string(),
  positionSizing: z.object({
    recommendedShares: z.number(),
    positionValue: z.number(),
    riskAmount: z.number(),
  }),
});

export const IntradayAnalysisResponseSchema = z.object({
  market: z.object({
    bias: z.enum(['BULLISH', 'BEARISH', 'NEUTRAL']),
    nifty: z.object({
      lastPrice: z.number(),
      changePercent: z.number(),
    }),
    bankNifty: z.object({
      lastPrice: z.number(),
      changePercent: z.number(),
    }),
    strongestSectors: z.array(z.string()),
    weakestSectors: z.array(z.string()),
    noTradeConditions: z.array(z.string()),
  }),
  setups: z.array(IntradaySetupSchema),
  top3BestSetups: z.array(z.string()),
  topLongCandidates: z.array(z.string()),
  topShortCandidates: z.array(z.string()),
  stocksToAvoid: z.array(
    z.object({
      symbol: z.string(),
      reason: z.string(),
    })
  ),
  checklist900to915: z.array(z.string()),
  riskManagement: z.object({
    capital: z.number(),
    riskPerTradePercent: z.number(),
    maxRiskPerTradeAmount: z.number(),
    maxTrades: z.number(),
    dailyLossLimit: z.number(),
    stopTradingConditions: z.array(z.string()),
  }),
});

export type IntradaySetup = z.infer<typeof IntradaySetupSchema>;
export type IntradayAnalysisResponse = z.infer<typeof IntradayAnalysisResponseSchema>;
