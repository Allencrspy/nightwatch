import type { StockCandidateData } from '../scanner/candidate-scanner.js';
import { SCORING_WEIGHTS } from '../../config/constants.js';

export interface ScoreBreakdown {
  priceStructure: number; // Max 20
  volume: number;         // Max 20
  relativeStrength: number; // Max 15
  breakoutQuality: number; // Max 15
  trend: number;          // Max 10
  sector: number;         // Max 10
  liquidity: number;      // Max 5
  news: number;           // Max 5
  totalScore: number;     // Max 100
}

export class ScoringEngineService {
  /**
   * Calculate exact 100-point deterministic score for a candidate stock setup
   */
  public static calculateScore(
    candidate: StockCandidateData,
    marketBias: 'BULLISH' | 'BEARISH' | 'NEUTRAL'
  ): ScoreBreakdown {
    const { quote, technical, relativeStrength, fno, news, candidateBias } = candidate;

    // 1. Price Structure (Max 20)
    let priceStructure = 10;
    if (candidateBias === 'LONG') {
      if (technical.closingStrength >= 0.7) priceStructure += 6;
      else if (technical.closingStrength >= 0.5) priceStructure += 3;
      if (quote.close > technical.ema20) priceStructure += 4;
    } else if (candidateBias === 'SHORT') {
      if (technical.closingStrength <= 0.3) priceStructure += 6;
      else if (technical.closingStrength <= 0.5) priceStructure += 3;
      if (quote.close < technical.ema20) priceStructure += 4;
    }
    priceStructure = Math.min(SCORING_WEIGHTS.priceStructure, Math.max(0, priceStructure));

    // 2. Volume & RVOL (Max 20)
    let volume = 5;
    if (technical.rvol >= 2.0) volume = 20;
    else if (technical.rvol >= 1.5) volume = 16;
    else if (technical.rvol >= 1.2) volume = 12;
    else if (technical.rvol >= 1.0) volume = 8;
    volume = Math.min(SCORING_WEIGHTS.volume, Math.max(0, volume));

    // 3. Relative Strength vs Nifty & Sector (Max 15)
    let rsScore = 5;
    if (candidateBias === 'LONG') {
      if (relativeStrength.vsNiftyPercent > 1.0) rsScore += 5;
      if (relativeStrength.vsSectorPercent > 0.5) rsScore += 5;
    } else if (candidateBias === 'SHORT') {
      if (relativeStrength.vsNiftyPercent < -1.0) rsScore += 5;
      if (relativeStrength.vsSectorPercent < -0.5) rsScore += 5;
    }
    rsScore = Math.min(SCORING_WEIGHTS.relativeStrength, Math.max(0, rsScore));

    // 4. Breakout / Breakdown Quality (Max 15)
    let breakoutQuality = 5;
    if (technical.breakoutType === 'BREAKOUT' && candidateBias === 'LONG') {
      breakoutQuality = 15;
    } else if (technical.breakoutType === 'BREAKDOWN' && candidateBias === 'SHORT') {
      breakoutQuality = 15;
    } else if (technical.breakoutType === 'PULLBACK') {
      breakoutQuality = 10;
    }
    breakoutQuality = Math.min(SCORING_WEIGHTS.breakoutQuality, Math.max(0, breakoutQuality));

    // 5. Trend Alignment (Max 10)
    let trend = 4;
    if (candidateBias === 'LONG' && technical.trendAlignment === 'STRONG_BULLISH') trend = 10;
    else if (candidateBias === 'LONG' && technical.trendAlignment === 'BULLISH') trend = 7;
    else if (candidateBias === 'SHORT' && technical.trendAlignment === 'STRONG_BEARISH') trend = 10;
    else if (candidateBias === 'SHORT' && technical.trendAlignment === 'BEARISH') trend = 7;
    trend = Math.min(SCORING_WEIGHTS.trend, Math.max(0, trend));

    // 6. Sector Confirmation (Max 10)
    let sector = 5;
    if (
      (candidateBias === 'LONG' && relativeStrength.outperformingSector) ||
      (candidateBias === 'SHORT' && !relativeStrength.outperformingSector)
    ) {
      sector = 10;
    }
    sector = Math.min(SCORING_WEIGHTS.sector, Math.max(0, sector));

    // 7. Liquidity (Max 5)
    let liquidity = 2;
    if (quote.totalTradedValueCr >= 100) liquidity = 5;
    else if (quote.totalTradedValueCr >= 50) liquidity = 4;
    else if (quote.totalTradedValueCr >= 20) liquidity = 3;
    liquidity = Math.min(SCORING_WEIGHTS.liquidity, Math.max(0, liquidity));

    // 8. News / Catalyst (Max 5)
    const newsScore = news.score;

    const totalScore =
      priceStructure + volume + rsScore + breakoutQuality + trend + sector + liquidity + newsScore;

    return {
      priceStructure,
      volume,
      relativeStrength: rsScore,
      breakoutQuality,
      trend,
      sector,
      liquidity,
      news: newsScore,
      totalScore,
    };
  }
}
