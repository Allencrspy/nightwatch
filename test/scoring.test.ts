import { describe, it, expect } from 'vitest';
import { ScoringEngineService } from '../src/services/scoring/scoring-engine.js';
import type { StockCandidateData } from '../src/services/scanner/candidate-scanner.js';

describe('ScoringEngineService', () => {
  it('should calculate 100-point deterministic score correctly', () => {
    const candidate: StockCandidateData = {
      quote: {
        symbol: 'RELIANCE',
        lastPrice: 3000,
        open: 2950,
        high: 3010,
        low: 2940,
        close: 3000,
        change: 60,
        changePercent: 2.04,
        volume: 2500000,
        avgVolume20: 1000000,
        rvol: 2.5,
        openInterest: 1000000,
        oiChange: 50000,
        oiChangePercent: 5.0,
        totalTradedValueCr: 750,
        sectorName: 'NIFTY ENERGY',
      },
      technical: {
        ema20: 2900,
        ema50: 2850,
        ema200: 2700,
        rvol: 2.5,
        avgVolume20: 1000000,
        todayVolume: 2500000,
        swingHigh20: 2980,
        swingLow20: 2880,
        supportLevel: 2880,
        resistanceLevel: 2980,
        closingStrength: 0.86,
        trendAlignment: 'STRONG_BULLISH',
        breakoutType: 'BREAKOUT',
      },
      relativeStrength: {
        vsNiftyPercent: 1.5,
        vsSectorPercent: 0.8,
        outperformingNifty: true,
        outperformingSector: true,
      },
      fno: {
        positioning: 'LONG_BUILDUP',
        interpretation: 'Strong long buildup',
        isBullish: true,
        isBearish: false,
        oiChangePercent: 5.0,
        openInterest: 1000000,
      },
      news: {
        hasNews: true,
        sentiment: 'BULLISH',
        score: 5,
      },
      candidateBias: 'LONG',
    };

    const score = ScoringEngineService.calculateScore(candidate, 'BULLISH');
    expect(score.totalScore).toBeGreaterThanOrEqual(80);
    expect(score.volume).toBe(20);
    expect(score.breakoutQuality).toBe(15);
    expect(score.trend).toBe(10);
    expect(score.totalScore).toBeLessThanOrEqual(100);
  });
});
