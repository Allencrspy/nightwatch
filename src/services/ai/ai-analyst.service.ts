import OpenAI from 'openai';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import type { StockCandidateData } from '../scanner/candidate-scanner.js';
import type { ScoreBreakdown } from '../scoring/scoring-engine.js';
import type { IntradayAnalysisResponse, IntradaySetup } from '../../schemas/analysis-response.schema.js';

export interface ScoredCandidate {
  candidate: StockCandidateData;
  scoreBreakdown: ScoreBreakdown;
}

export interface AnalystInput {
  scoredCandidates: ScoredCandidate[];
  niftyLastPrice: number;
  niftyChangePercent: number;
  bankNiftyLastPrice: number;
  bankNiftyChangePercent: number;
  sectorPerformances: Array<{ sector: string; changePercent: number }>;
  skipped: Array<{ symbol: string; reason: string }>;
  capital: number;
  riskPercent: number;
  maxTrades: number;
}

/** The framework caps a day's loss at 1% of capital. */
const MAX_DAILY_LOSS_FRACTION = 0.01;

export class AiAnalystService {
  private openai: OpenAI | null = null;

  constructor() {
    if (env.OPENAI_API_KEY) this.openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
  }

  public async analyzeIntradaySetups(input: AnalystInput): Promise<IntradayAnalysisResponse> {
    const base = this.synthesizeRuleBased(input);

    if (!this.openai) {
      base.dataNotes.push('No OpenAI key configured; setups come from the deterministic rule engine only.');
      return base;
    }

    try {
      const llm = await this.callOpenAiAnalyst(input, base);
      return llm;
    } catch (err: any) {
      // Falling back is fine — the response says which engine produced it.
      logger.warn({ error: err.message }, 'OpenAI analyst failed; returning rule-engine output');
      base.dataNotes.push(`OpenAI analyst unavailable (${err.message}); rule engine used instead.`);
      return base;
    }
  }

  private determineMarketBias(nifty: number, bankNifty: number): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
    const avg = (nifty + bankNifty) / 2;
    if (avg >= 0.5) return 'BULLISH';
    if (avg <= -0.5) return 'BEARISH';
    return 'NEUTRAL';
  }

  /**
   * Builds one setup, or null when the geometry does not work.
   *
   * Returning null matters: the previous version always produced a setup,
   * clamping the risk to a minimum of 1 rupee when the structural stop sat at
   * or above the trigger. That manufactured a tradeable-looking plan out of a
   * structure that had none.
   */
  private buildSetup(sc: ScoredCandidate, capital: number, maxRiskAmount: number): IntradaySetup | null {
    const { quote, technical, candidateBias } = sc.candidate;
    if (candidateBias === 'NEUTRAL') return null;

    const long = candidateBias === 'LONG';

    // The level that has to give way, taken from structure rather than a
    // fixed percentage nudge off the close.
    const entryTrigger = long
      ? Number(Math.max(technical.resistanceLevel, quote.high).toFixed(2))
      : Number(Math.min(technical.supportLevel, quote.low).toFixed(2));

    const stopLoss = long
      ? Number(Math.min(quote.low, technical.supportLevel).toFixed(2))
      : Number(Math.max(quote.high, technical.resistanceLevel).toFixed(2));

    const risk = Number((long ? entryTrigger - stopLoss : stopLoss - entryTrigger).toFixed(2));
    if (!Number.isFinite(risk) || risk <= 0) {
      logger.info({ symbol: quote.symbol }, 'Setup rejected: stop is not on the correct side of the trigger');
      return null;
    }
    // A stop further than 5% away is not an intraday stop.
    if (risk / entryTrigger > 0.05) {
      logger.info({ symbol: quote.symbol, riskPct: risk / entryTrigger }, 'Setup rejected: structural stop too wide');
      return null;
    }

    const t1 = Number((long ? entryTrigger + risk * 2 : entryTrigger - risk * 2).toFixed(2));
    const t2 = Number((long ? entryTrigger + risk * 3.5 : entryTrigger - risk * 3.5).toFixed(2));

    // One risk figure for targets, sizing and the ratio. The old code used a
    // clamped value for targets and an unclamped one for R:R, so the stated
    // ratio did not describe the stated levels.
    const byRisk = Math.floor(maxRiskAmount / risk);
    const byCapital = Math.floor(capital / entryTrigger);
    const recommendedShares = Math.max(0, Math.min(byRisk, byCapital));
    if (recommendedShares === 0) return null;

    return {
      symbol: quote.symbol,
      bias: candidateBias,
      setupType: long
        ? technical.breakoutType === 'BREAKOUT' ? 'BREAKOUT' : 'CONTINUATION'
        : technical.breakoutType === 'BREAKDOWN' ? 'BREAKDOWN' : 'RESISTANCE_REJECTION',
      score: sc.scoreBreakdown.totalScore,
      scoreBreakdown: sc.scoreBreakdown,
      close: quote.lastPrice,
      entryTrigger,
      stopLoss,
      targets: [t1, t2],
      riskRewardRatio: 2,
      invalidation: long
        ? `A 5-minute close back below ${stopLoss}, or failure to hold ${entryTrigger} after breaking it.`
        : `A 5-minute close back above ${stopLoss}, or failure to hold ${entryTrigger} after breaking it.`,
      bullishScenario: long
        ? `Price closes a 5-minute candle above ${entryTrigger} on expanding volume and holds it, reaching ${t1} then ${t2}.`
        : `Price fails at ${entryTrigger} and turns back toward ${technical.supportLevel}.`,
      bearishScenario: long
        ? `Price breaks ${entryTrigger}, is rejected, and loses ${stopLoss}.`
        : `Price closes a 5-minute candle below ${entryTrigger} on expanding volume, reaching ${t1} then ${t2}.`,
      positionSizing: {
        recommendedShares,
        positionValue: Number((recommendedShares * entryTrigger).toFixed(2)),
        riskAmount: Number((recommendedShares * risk).toFixed(2)),
      },
    };
  }

  private synthesizeRuleBased(input: AnalystInput): IntradayAnalysisResponse {
    const {
      scoredCandidates, niftyLastPrice, niftyChangePercent, bankNiftyLastPrice,
      bankNiftyChangePercent, sectorPerformances, skipped, capital, riskPercent, maxTrades,
    } = input;

    const maxRiskAmount = Number(((capital * riskPercent) / 100).toFixed(2));
    const dailyLossLimit = Number(
      Math.min(maxRiskAmount * maxTrades, capital * MAX_DAILY_LOSS_FRACTION).toFixed(2)
    );

    const sorted = [...scoredCandidates].sort(
      (a, b) => b.scoreBreakdown.totalScore - a.scoreBreakdown.totalScore
    );

    const setups: IntradaySetup[] = [];
    for (const sc of sorted) {
      if (setups.length >= 5) break;
      const s = this.buildSetup(sc, capital, maxRiskAmount);
      if (s) setups.push(s);
    }

    const dataNotes: string[] = [
      'Targets are constructed at 2R and 3.5R, so the stated risk-reward is a definition of those levels, not an independent quality filter.',
      'Open interest is unavailable on cash-equity quotes, so F&O positioning is not assessed.',
      'No news source is configured, so the catalyst factor is excluded from every score rather than defaulted.',
    ];
    if (skipped.length) dataNotes.push(`${skipped.length} symbols could not be fetched and were excluded.`);

    return {
      generatedAt: new Date().toISOString(),
      analyst: 'RULE_ENGINE',
      dataNotes,
      market: {
        bias: this.determineMarketBias(niftyChangePercent, bankNiftyChangePercent),
        nifty: { lastPrice: niftyLastPrice, changePercent: niftyChangePercent },
        bankNifty: { lastPrice: bankNiftyLastPrice, changePercent: bankNiftyChangePercent },
        strongestSectors: sectorPerformances.slice(0, 2).map((s) => s.sector),
        weakestSectors: sectorPerformances.slice(-2).map((s) => s.sector),
        noTradeConditions: [
          'First 15 minutes of extreme volatility (09:15–09:30)',
          'Gap larger than 1.5% without a 5-minute consolidation',
          'Relative volume below 1.0 during the trigger window',
          'Price reaches the target zone before the entry trigger',
        ],
      },
      setups,
      top3BestSetups: setups.slice(0, 3).map((s) => s.symbol),
      topLongCandidates: setups.filter((s) => s.bias === 'LONG').map((s) => s.symbol),
      topShortCandidates: setups.filter((s) => s.bias === 'SHORT').map((s) => s.symbol),
      // Only names this scan actually rejected on structure. Previously two
      // tickers were hardcoded here with invented reasons.
      stocksToAvoid: sorted
        .filter((sc) => !setups.some((s) => s.symbol === sc.candidate.quote.symbol))
        .slice(0, 5)
        .map((sc) => ({
          symbol: sc.candidate.quote.symbol,
          reason:
            sc.candidate.candidateBias === 'NEUTRAL'
              ? 'No directional bias: close sat mid-range relative to the day.'
              : 'Structural stop and trigger did not produce a workable intraday risk.',
        })),
      checklist900to915: [
        'Check the opening gap against each setup trigger',
        'Confirm the opening price still leaves the planned risk-reward intact',
        'Compare the first 15-minute volume with the 5-day average',
        'Confirm market bias does not contradict the setup bias',
      ],
      skipped,
      riskManagement: {
        capital,
        riskPerTradePercent: riskPercent,
        maxRiskPerTradeAmount: maxRiskAmount,
        maxTrades,
        dailyLossLimit,
        stopTradingConditions: [
          `Two consecutive losing trades (${(maxRiskAmount * 2).toFixed(2)})`,
          `Daily loss limit of ${dailyLossLimit} reached`,
          'India VIX spikes more than 8% intraday',
        ],
      },
    };
  }

  /**
   * The LLM re-reasons over the same verified numbers. It may reorder, reject
   * or re-narrate — it may not introduce prices, and the response schema
   * rejects anything whose geometry does not hold.
   */
  private async callOpenAiAnalyst(
    input: AnalystInput,
    base: IntradayAnalysisResponse
  ): Promise<IntradayAnalysisResponse> {
    const systemPrompt = `You are an Indian equity intraday analyst working to a night-before NSE selection framework.

RULES
1. Use ONLY the numbers in the payload. Never introduce a price, level or statistic that is not there.
2. A field marked null or listed in unknownFactors is UNKNOWN. Do not treat unknown as neutral, and do not estimate it.
3. Keep every setup's entryTrigger, stopLoss and targets exactly as given. You may drop a setup; you may not move its levels.
4. Separate fact from interpretation in the narrative fields.
5. Return JSON matching the schema of the provided baseline object, with the same keys.`;

    const res = await this.openai!.chat.completions.create({
      model: env.OPENAI_MODEL,
      response_format: { type: 'json_object' },
      temperature: 0.2,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify({ baseline: base, skipped: input.skipped }, null, 2) },
      ],
    });

    const content = res.choices[0]?.message?.content;
    if (!content) throw new Error('empty response');

    const parsed = JSON.parse(content) as IntradayAnalysisResponse;
    // Provenance and data caveats are ours to state, not the model's to edit.
    return {
      ...parsed,
      generatedAt: new Date().toISOString(),
      analyst: 'OPENAI',
      dataNotes: base.dataNotes,
      skipped: input.skipped,
    };
  }
}
