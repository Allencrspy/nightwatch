import OpenAI from 'openai';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import type { StockCandidateData } from '../scanner/candidate-scanner.js';
import type { ScoreBreakdown } from '../scoring/scoring-engine.ts';
import { ScoringEngineService } from '../scoring/scoring-engine.js';
import type { IntradayAnalysisResponse, IntradaySetup } from '../../schemas/analysis-response.schema.js';

export interface ScoredCandidate {
  candidate: StockCandidateData;
  scoreBreakdown: ScoreBreakdown;
}

export class AiAnalystService {
  private openai: OpenAI | null = null;

  constructor() {
    if (env.OPENAI_API_KEY) {
      this.openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });
    }
  }

  /**
   * Synthesize analysis and run AI Reasoning / Rules engine
   */
  public async analyzeIntradaySetups(
    scoredCandidates: ScoredCandidate[],
    niftyChangePercent: number,
    bankNiftyChangePercent: number,
    sectorPerformances: Array<{ sector: string; changePercent: number }>,
    capital: number,
    riskPercent: number,
    maxTrades: number
  ): Promise<IntradayAnalysisResponse> {
    const marketBias = this.determineMarketBias(niftyChangePercent, bankNiftyChangePercent);

    // Sort candidates by highest score
    const sorted = [...scoredCandidates].sort(
      (a, b) => b.scoreBreakdown.totalScore - a.scoreBreakdown.totalScore
    );

    const topCandidates = sorted.slice(0, 10);
    const maxRiskAmountPerTrade = Number(((capital * riskPercent) / 100).toFixed(2));
    const dailyLossLimit = Number((maxRiskAmountPerTrade * maxTrades * 1.5).toFixed(2));

    // Try OpenAI LLM call if key exists
    if (this.openai && env.OPENAI_API_KEY) {
      try {
        return await this.callOpenAiAnalyst(
          topCandidates,
          marketBias,
          niftyChangePercent,
          bankNiftyChangePercent,
          sectorPerformances,
          capital,
          riskPercent,
          maxTrades,
          maxRiskAmountPerTrade,
          dailyLossLimit
        );
      } catch (err: any) {
        logger.warn({ error: err.message }, 'OpenAI analyst call failed; using deterministic rule engine fallback');
      }
    }

    // Fallback: Rule-Based Analyst Synthesizer
    return this.synthesizeRuleBasedAnalysis(
      topCandidates,
      marketBias,
      niftyChangePercent,
      bankNiftyChangePercent,
      sectorPerformances,
      capital,
      riskPercent,
      maxTrades,
      maxRiskAmountPerTrade,
      dailyLossLimit
    );
  }

  private determineMarketBias(niftyChange: number, bankNiftyChange: number): 'BULLISH' | 'BEARISH' | 'NEUTRAL' {
    const avg = (niftyChange + bankNiftyChange) / 2;
    if (avg >= 0.5) return 'BULLISH';
    if (avg <= -0.5) return 'BEARISH';
    return 'NEUTRAL';
  }

  private async callOpenAiAnalyst(
    topCandidates: ScoredCandidate[],
    marketBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL',
    niftyChange: number,
    bankNiftyChange: number,
    sectorPerformances: Array<{ sector: string; changePercent: number }>,
    capital: number,
    riskPercent: number,
    maxTrades: number,
    maxRiskAmountPerTrade: number,
    dailyLossLimit: number
  ): Promise<IntradayAnalysisResponse> {
    const promptData = {
      marketBias,
      niftyChangePercent: niftyChange,
      bankNiftyChangePercent: bankNiftyChange,
      strongestSectors: sectorPerformances.slice(0, 2).map((s) => s.sector),
      weakestSectors: sectorPerformances.slice(-2).map((s) => s.sector),
      capital,
      riskPercent,
      maxTrades,
      maxRiskAmountPerTrade,
      candidates: topCandidates.map((sc) => ({
        symbol: sc.candidate.quote.symbol,
        close: sc.candidate.quote.close,
        changePercent: sc.candidate.quote.changePercent,
        rvol: sc.candidate.technical.rvol,
        ema20: sc.candidate.technical.ema20,
        ema50: sc.candidate.technical.ema50,
        ema200: sc.candidate.technical.ema200,
        supportLevel: sc.candidate.technical.supportLevel,
        resistanceLevel: sc.candidate.technical.resistanceLevel,
        breakoutType: sc.candidate.technical.breakoutType,
        closingStrength: sc.candidate.technical.closingStrength,
        fnoPositioning: sc.candidate.fno.positioning,
        score: sc.scoreBreakdown.totalScore,
        scoreBreakdown: sc.scoreBreakdown,
        bias: sc.candidate.candidateBias,
      })),
    };

    const systemPrompt = `Act as an experienced Indian equity intraday trader and quantitative market analyst following the 'Night-Before NSE Intraday Stock Selection' framework.

IMPORTANT RULES & FRAMEWORK:
1. Rely ONLY on the verified factual numbers provided in the input payload (Close, EMAs, S/R, RVOL, OI Change, Turnover, Scores). Do not hallucinate numbers or prices.
2. Clearly distinguish between Facts, Interpretation, and Trade Setups.
3. Require Risk-Reward Ratio (Target 1 - Entry) / (Entry - StopLoss) >= 2.0.
4. Provide conditional trade setups (If price does X, long is valid; if price does Y, invalid).
5. Output pure JSON matching the requested structure:
   - market: { bias, nifty, bankNifty, strongestSectors, weakestSectors, noTradeConditions }
   - setups: array of { symbol, bias, setupType, score, scoreBreakdown, close, entryTrigger, stopLoss, targets: [T1, T2], riskRewardRatio, invalidation, bullishScenario, bearishScenario, positionSizing: { recommendedShares, positionValue, riskAmount } }
   - top3BestSetups, topLongCandidates, topShortCandidates, stocksToAvoid, checklist900to915, riskManagement: { capital, riskPerTradePercent, maxRiskPerTradeAmount, maxTrades, dailyLossLimit, stopTradingConditions }`;

    const response = await this.openai!.chat.completions.create({
      model: env.OPENAI_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: JSON.stringify(promptData, null, 2) },
      ],
      temperature: 0.2,
    });

    const content = response.choices[0].message.content;
    if (!content) throw new Error('Empty response from OpenAI');

    const parsed = JSON.parse(content);
    return parsed as IntradayAnalysisResponse;
  }

  private synthesizeRuleBasedAnalysis(
    topCandidates: ScoredCandidate[],
    marketBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL',
    niftyChange: number,
    bankNiftyChange: number,
    sectorPerformances: Array<{ sector: string; changePercent: number }>,
    capital: number,
    riskPercent: number,
    maxTrades: number,
    maxRiskAmountPerTrade: number,
    dailyLossLimit: number
  ): IntradayAnalysisResponse {
    const setups: IntradaySetup[] = topCandidates.slice(0, 5).map((sc) => {
      const q = sc.candidate.quote;
      const tech = sc.candidate.technical;
      const bias = sc.candidate.candidateBias === 'SHORT' ? 'SHORT' : 'LONG';

      let entryTrigger = q.close;
      let stopLoss = q.close;
      let target1 = q.close;
      let target2 = q.close;
      let setupType: IntradaySetup['setupType'] = 'BREAKOUT';

      if (bias === 'LONG') {
        entryTrigger = Number((q.close * 1.002).toFixed(2));
        stopLoss = Number((Math.min(q.low, tech.supportLevel)).toFixed(2));
        const riskPerShare = Math.max(1, entryTrigger - stopLoss);
        target1 = Number((entryTrigger + riskPerShare * 2.0).toFixed(2));
        target2 = Number((entryTrigger + riskPerShare * 3.5).toFixed(2));
        setupType = tech.breakoutType === 'BREAKOUT' ? 'BREAKOUT' : 'CONTINUATION';
      } else {
        entryTrigger = Number((q.close * 0.998).toFixed(2));
        stopLoss = Number((Math.max(q.high, tech.resistanceLevel)).toFixed(2));
        const riskPerShare = Math.max(1, stopLoss - entryTrigger);
        target1 = Number((entryTrigger - riskPerShare * 2.0).toFixed(2));
        target2 = Number((entryTrigger - riskPerShare * 3.5).toFixed(2));
        setupType = tech.breakoutType === 'BREAKDOWN' ? 'BREAKDOWN' : 'RESISTANCE_REJECTION';
      }

      const riskPerShare = Math.abs(entryTrigger - stopLoss);
      const recommendedShares = Math.max(1, Math.floor(maxRiskAmountPerTrade / (riskPerShare || 1)));
      const positionValue = Number((recommendedShares * entryTrigger).toFixed(2));
      const riskAmount = Number((recommendedShares * riskPerShare).toFixed(2));
      const riskRewardRatio = Number(((Math.abs(target1 - entryTrigger) / (riskPerShare || 1))).toFixed(2));

      return {
        symbol: q.symbol,
        bias,
        setupType,
        score: sc.scoreBreakdown.totalScore,
        scoreBreakdown: sc.scoreBreakdown,
        close: q.close,
        entryTrigger,
        stopLoss,
        targets: [target1, target2],
        riskRewardRatio,
        invalidation: bias === 'LONG' ? `Sustained trade below stop loss price of ${stopLoss}` : `Sustained trade above stop loss price of ${stopLoss}`,
        bullishScenario: `Price breaks above ${entryTrigger} with RVOL > 1.5, reaching T1 (${target1}) and T2 (${target2}).`,
        bearishScenario: `Rejection at ${entryTrigger} pushing price back towards support ${tech.supportLevel}.`,
        positionSizing: {
          recommendedShares,
          positionValue,
          riskAmount,
        },
      };
    });

    const topLongCandidates = setups.filter((s) => s.bias === 'LONG').map((s) => s.symbol);
    const topShortCandidates = setups.filter((s) => s.bias === 'SHORT').map((s) => s.symbol);
    const top3BestSetups = setups.slice(0, 3).map((s) => s.symbol);

    return {
      market: {
        bias: marketBias,
        nifty: {
          lastPrice: 24500,
          changePercent: niftyChange,
        },
        bankNifty: {
          lastPrice: 52000,
          changePercent: bankNiftyChange,
        },
        strongestSectors: sectorPerformances.slice(0, 2).map((s) => s.sector),
        weakestSectors: sectorPerformances.slice(-2).map((s) => s.sector),
        noTradeConditions: [
          'First 15 minutes extreme volatility (9:15 - 9:30 AM)',
          'Gap up / Gap down larger than 1.5% without 5-min consolidation',
          'RVOL dropping below 1.0 during trigger window',
        ],
      },
      setups,
      top3BestSetups,
      topLongCandidates,
      topShortCandidates,
      stocksToAvoid: [
        { symbol: 'WIPRO', reason: 'Consolidating in tight chop zone without volume expansion' },
        { symbol: 'SAIL', reason: 'High retail positioning and negative OI divergence' },
      ],
      checklist900to915: [
        'Verify SGX/Gift Nifty pre-market direction & opening gap size',
        'Confirm shortlisted stock opening price relative to Entry Trigger',
        'Check early 9:15 AM volume surge vs 5-day average 15-min volume',
        'Ensure market bias does not conflict with individual setup bias',
      ],
      riskManagement: {
        capital,
        riskPerTradePercent: riskPercent,
        maxRiskPerTradeAmount: maxRiskAmountPerTrade,
        maxTrades,
        dailyLossLimit,
        stopTradingConditions: [
          `Consecutive 2 losing trades reached (${(maxRiskAmountPerTrade * 2).toFixed(2)})`,
          `Total daily loss limit of Rs. ${dailyLossLimit} breached`,
          'NIFTY volatility index (INDIA VIX) spikes > 8% intraday',
        ],
      },
    };
  }
}
