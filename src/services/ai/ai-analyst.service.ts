import OpenAI from 'openai';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import type { StockCandidateData } from '../scanner/candidate-scanner.js';
import type { ScoreBreakdown } from '../scoring/scoring-engine.js';
import type { QuoteWithChange } from '../dhan/dhan-market-data.service.js';
import type { IntradayAnalysisResponse, IntradaySetup } from '../../schemas/analysis-response.schema.js';
import { buildFactSheet, type FactSheet } from './fact-sheet.js';
import { FRAMEWORK_SYSTEM_PROMPT, PROMPT_VERSION } from './framework-prompt.js';

export interface ScoredCandidate {
  candidate: StockCandidateData;
  scoreBreakdown: ScoreBreakdown;
}

export interface AnalystInput {
  scoredCandidates: ScoredCandidate[];
  /** Names a framework stage removed, each carrying the stage and reason. */
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
      tier: sc.candidate.filters.tier === 'HIGH' ? 'HIGH' : 'WATCHLIST',
      stages: sc.candidate.filters.stages,
      volumeCharacter: sc.candidate.filters.volumeCharacter,
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
      why: '',
      gapPlan: [],
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
      scoredCandidates, rejected, stageOrder, funnel, universeSize,
      niftyLastPrice, niftyChangePercent, bankNiftyLastPrice,
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
      if (setups.length >= 10) break;
      const s = this.buildSetup(sc, capital, maxRiskAmount);
      if (s) setups.push(s);
    }

    const dataNotes: string[] = [
      'Targets are constructed at 2R and 3.5R, so the stated risk-reward is a definition of those levels, not an independent quality filter.',
      'Open interest is unavailable on cash-equity quotes, so F&O positioning is not assessed.',
      'No news source is configured, so the catalyst factor is excluded from every score rather than defaulted.',
    ];
    if (skipped.length) dataNotes.push(`${skipped.length} symbols could not be fetched and were excluded.`);

    // "Do not force a trade." A watchlist of demoted names is not a setup.
    const noHighQualitySetup = !setups.some((s) => s.tier === 'HIGH');
    if (noHighQualitySetup) {
      dataNotes.push(
        setups.length === 0
          ? 'No high-quality trade setup based on the available data. Staying out beats forcing a trade.'
          : 'No setup cleared every stage. The names below are watchlist-only, not trades.'
      );
    }

    return {
      generatedAt: new Date().toISOString(),
      analyst: 'RULE_ENGINE',
      promptVersion: null,
      selfCritique: null,
      dataNotes,
      noHighQualitySetup,
      framework: { stageOrder: [...stageOrder], funnel, universeSize },
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
      // Part 12: highlight the best three, and only from the top tier.
      top3BestSetups: setups.filter((s) => s.tier === 'HIGH').slice(0, 3).map((s) => s.symbol),
      topLongCandidates: setups.filter((s) => s.bias === 'LONG').map((s) => s.symbol),
      topShortCandidates: setups.filter((s) => s.bias === 'SHORT').map((s) => s.symbol),
      // Part 19. Every entry is a name a named stage removed, with its reason.
      // Two tickers used to be hardcoded here with invented explanations.
      stocksToAvoid: rejected.slice(0, 10),
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
   * Runs the framework as an analyst over a fully-computed fact sheet.
   *
   * The division of labour is the point. The model judges — what kind of
   * setup this is, whether the sector conflict matters, what is too extended,
   * whether anything is worth trading. The server computes — risk-reward,
   * position size, every derived number. Anything the model states in those
   * fields is discarded and recalculated, because a model doing arithmetic is
   * exactly where the original handed-over code went wrong.
   */
  private async callOpenAiAnalyst(
    input: AnalystInput,
    base: IntradayAnalysisResponse
  ): Promise<IntradayAnalysisResponse> {
    const sheet: FactSheet = buildFactSheet({
      scored: input.scoredCandidates,
      screenedOut: input.rejected.map((r) => ({ symbol: r.symbol, stage: r.stage, reason: r.reason })),
      nifty: input.niftyQuote,
      bankNifty: input.bankNiftyQuote,
      sectors: input.sectorPerformances,
      capital: input.capital,
      riskPercent: input.riskPercent,
      maxTrades: input.maxTrades,
    });

    logger.info(
      { candidates: sheet.candidates.length, screenedOut: sheet.screenedOut.length, promptVersion: PROMPT_VERSION },
      'Running framework analyst'
    );

    const res = await this.openai!.chat.completions.create({
      model: env.OPENAI_MODEL,
      response_format: { type: 'json_object' },
      temperature: 0.2,
      messages: [
        { role: 'system', content: FRAMEWORK_SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(sheet) },
      ],
    });

    const content = res.choices[0]?.message?.content;
    if (!content) throw new Error('empty response from the analyst');
    const out = JSON.parse(content);

    const known = new Map(input.scoredCandidates.map((sc) => [sc.candidate.quote.symbol, sc.candidate]));
    const maxRiskAmount = sheet.risk.maxRiskPerTrade;
    const setups: IntradaySetup[] = [];

    for (const raw of Array.isArray(out.setups) ? out.setups : []) {
      const candidate = known.get(raw.symbol);
      if (!candidate) {
        // A symbol that was not in the fact sheet cannot have been analysed.
        logger.warn({ symbol: raw.symbol }, 'Analyst returned a symbol absent from the fact sheet; dropped');
        continue;
      }

      const bias = raw.bias === 'SHORT' ? 'SHORT' : 'LONG';
      const entryTrigger = Number(raw.entryTrigger);
      const stopLoss = Number(raw.stopLoss);
      const targets = (Array.isArray(raw.targets) ? raw.targets : []).map(Number).slice(0, 2);

      const risk = bias === 'LONG' ? entryTrigger - stopLoss : stopLoss - entryTrigger;
      if (!Number.isFinite(risk) || risk <= 0 || targets.length !== 2 || targets.some((t: number) => !Number.isFinite(t))) {
        logger.warn({ symbol: raw.symbol, entryTrigger, stopLoss, targets }, 'Analyst setup has unusable geometry; dropped');
        continue;
      }

      // Server-side arithmetic, always. The model's own numbers are ignored.
      const byRisk = Math.floor(maxRiskAmount / risk);
      const byCapital = Math.floor(input.capital / entryTrigger);
      const shares = Math.max(0, Math.min(byRisk, byCapital));
      if (shares === 0) {
        logger.warn({ symbol: raw.symbol }, 'Setup sizes to zero shares at this capital; dropped');
        continue;
      }

      setups.push({
        symbol: raw.symbol,
        bias,
        tier: raw.tier === 'HIGH' ? 'HIGH' : 'WATCHLIST',
        // The deterministic trace travels with the setup as a second opinion.
        stages: candidate.filters.stages,
        volumeCharacter: raw.volumeCharacter ?? candidate.filters.volumeCharacter,
        setupType: raw.setupType,
        score: Number(raw.scoreBreakdown?.totalScore ?? raw.score),
        scoreBreakdown: raw.scoreBreakdown,
        close: candidate.quote.lastPrice,
        entryTrigger,
        stopLoss,
        targets: targets as [number, number],
        riskRewardRatio: Number((Math.abs(targets[0] - entryTrigger) / risk).toFixed(2)),
        why: String(raw.why ?? ''),
        gapPlan: Array.isArray(raw.gapPlan)
          ? raw.gapPlan.filter((g: any) => g?.condition && g?.action)
          : [],
        invalidation: String(raw.invalidation ?? ''),
        bullishScenario: String(raw.bullishScenario ?? ''),
        bearishScenario: String(raw.bearishScenario ?? ''),
        positionSizing: {
          recommendedShares: shares,
          positionValue: Number((shares * entryTrigger).toFixed(2)),
          riskAmount: Number((shares * risk).toFixed(2)),
        },
      });
    }

    const noHighQualitySetup = Boolean(out.noHighQualitySetup) || !setups.some((s) => s.tier === 'HIGH');

    return {
      ...base,
      analyst: 'OPENAI',
      promptVersion: PROMPT_VERSION,
      selfCritique: out.selfCritique ?? null,
      noHighQualitySetup,
      market: {
        ...base.market,
        bias: ['BULLISH', 'BEARISH', 'NEUTRAL'].includes(out.marketBias) ? out.marketBias : base.market.bias,
        strongestSectors: out.strongestSectors ?? base.market.strongestSectors,
        weakestSectors: out.weakestSectors ?? base.market.weakestSectors,
        noTradeConditions: out.noTradeConditions ?? base.market.noTradeConditions,
      },
      setups,
      top3BestSetups: (out.top3BestSetups ?? [])
        .filter((sym: string) => setups.some((s) => s.symbol === sym && s.tier === 'HIGH'))
        .slice(0, 3),
      topLongCandidates: setups.filter((s) => s.bias === 'LONG').map((s) => s.symbol),
      topShortCandidates: setups.filter((s) => s.bias === 'SHORT').map((s) => s.symbol),
      stocksToAvoid: Array.isArray(out.stocksToAvoid) && out.stocksToAvoid.length
        ? out.stocksToAvoid.map((a: any) => ({
            symbol: String(a.symbol), stage: 'analyst', part: 'Part 19 — stocks to avoid',
            reason: String(a.reason ?? 'No reason given.'),
          }))
        : base.stocksToAvoid,
      checklist900to915: out.checklist900to915 ?? base.checklist900to915,
    };
  }
}
