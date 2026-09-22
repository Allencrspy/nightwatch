import { describe, it, expect } from 'vitest';
import { ScoringEngineService } from '../src/services/scoring/scoring-engine.js';
import type { StockCandidateData } from '../src/services/scanner/candidate-scanner.js';

describe('ScoringEngineService', () => {
  it('should calculate 100-point deterministic score correctly', () => {
    const candidate: StockCandidateData = {
      quote: {
        symbol: 'RELIANCE',
        securityId: '2885',
        lastPrice: 3000,
        open: 2950,
        high: 3010,
        low: 2940,
        close: 3000,
        previousClose: 2940,
        change: 60,
        changePercent: 2.04,
        volume: 2500000,
        openInterest: null,
        oiChangePercent: null,
        unavailable: ['openInterest', 'oiChangePercent'],
      },
      sectorName: 'NIFTY ENERGY',
      turnoverCr: 750,
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
        positioning: 'UNKNOWN',
        interpretation: 'Open interest unavailable for this instrument; positioning not assessed.',
        available: false,
        isBullish: false,
        isBearish: false,
        oiChangePercent: null,
        openInterest: null,
      },
      news: {
        available: false,
        hasNews: false,
        sentiment: 'UNKNOWN',
        score: null,
        note: 'No news source configured.',
      },
      candidateBias: 'LONG',
    };

    const score = ScoringEngineService.calculateScore(candidate, 'BULLISH');

    expect(score.volume).toBe(20);
    expect(score.breakoutQuality).toBe(15);
    expect(score.trend).toBe(10);

    // An unassessable factor scores null and leaves the denominator, rather
    // than quietly contributing a middling 3/5 as it used to.
    expect(score.news).toBeNull();
    expect(score.unknownFactors).toContain('news');
    expect(score.unknownFactors).toContain('fnoPositioning');
    expect(score.assessableMax).toBe(95);

    // The total must equal the factors it is made of.
    const sum = score.priceStructure + score.volume + score.relativeStrength +
      score.breakoutQuality + score.trend + score.sector + score.liquidity + (score.news ?? 0);
    expect(score.totalScore).toBeCloseTo(sum, 2);
    expect(score.totalScore).toBeLessThanOrEqual(score.assessableMax);
  });
});
