import type { Candle } from '../dhan/dhan-market-data.service.js';

export interface TechnicalMetrics {
  ema20: number;
  ema50: number;
  ema200: number;
  rvol: number;
  avgVolume20: number;
  todayVolume: number;
  swingHigh20: number;
  swingLow20: number;
  supportLevel: number;
  resistanceLevel: number;
  closingStrength: number; // 0.0 to 1.0 (Close relative to Day High/Low range)
  trendAlignment: 'STRONG_BULLISH' | 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'STRONG_BEARISH';
  breakoutType: 'BREAKOUT' | 'BREAKDOWN' | 'CONSOLIDATION' | 'PULLBACK' | 'NONE';
}

export class TechnicalIndicatorService {
  /**
   * Calculate Exponential Moving Average (EMA)
   */
  public static calculateEMA(prices: number[], period: number): number {
    if (prices.length === 0) return 0;
    if (prices.length < period) {
      // Return Simple Moving Average if insufficient length
      const sum = prices.reduce((acc, val) => acc + val, 0);
      return Number((sum / prices.length).toFixed(2));
    }

    const multiplier = 2 / (period + 1);
    // Initial SMA for period
    let ema = prices.slice(0, period).reduce((acc, val) => acc + val, 0) / period;

    for (let i = period; i < prices.length; i++) {
      ema = (prices[i] - ema) * multiplier + ema;
    }

    return Number(ema.toFixed(2));
  }

  /**
   * Calculate Relative Volume (RVOL)
   */
  public static calculateRVOL(volumes: number[], period = 20): { rvol: number; avgVolume20: number } {
    if (volumes.length === 0) return { rvol: 1.0, avgVolume20: 0 };
    
    const todayVolume = volumes[volumes.length - 1];
    const prevVolumes = volumes.slice(-period - 1, -1);
    
    if (prevVolumes.length === 0) return { rvol: 1.0, avgVolume20: todayVolume };

    const avgVolume20 = prevVolumes.reduce((acc, val) => acc + val, 0) / prevVolumes.length;
    const rvol = Number((todayVolume / (avgVolume20 || 1)).toFixed(2));

    return {
      rvol,
      avgVolume20: Math.round(avgVolume20),
    };
  }

  /**
   * Calculate Support and Resistance levels from recent 20 daily candles
   */
  public static calculateSupportResistance(candles: Candle[]): {
    swingHigh20: number;
    swingLow20: number;
    supportLevel: number;
    resistanceLevel: number;
  } {
    const recent20 = candles.slice(-21, -1); // exclude today's candle for true prev levels
    if (recent20.length === 0) {
      const current = candles[candles.length - 1];
      return {
        swingHigh20: current.high,
        swingLow20: current.low,
        supportLevel: current.low,
        resistanceLevel: current.high,
      };
    }

    const highs = recent20.map((c) => c.high);
    const lows = recent20.map((c) => c.low);

    const swingHigh20 = Math.max(...highs);
    const swingLow20 = Math.min(...lows);

    // Support is nearest swing low, Resistance is nearest swing high
    return {
      swingHigh20: Number(swingHigh20.toFixed(2)),
      swingLow20: Number(swingLow20.toFixed(2)),
      supportLevel: Number(swingLow20.toFixed(2)),
      resistanceLevel: Number(swingHigh20.toFixed(2)),
    };
  }

  /**
   * Calculate closing strength (Where close sits within high-low range)
   * 1.0 = Closed at exact high, 0.0 = Closed at exact low
   */
  public static calculateClosingStrength(high: number, low: number, close: number): number {
    const range = high - low;
    if (range <= 0) return 0.5;
    const strength = (close - low) / range;
    return Number(Math.max(0, Math.min(1, strength)).toFixed(2));
  }

  /**
   * Determine overall trend alignment with EMAs
   */
  public static calculateTrendAlignment(
    close: number,
    ema20: number,
    ema50: number,
    ema200: number
  ): TechnicalMetrics['trendAlignment'] {
    if (close > ema20 && ema20 > ema50 && ema50 > ema200) {
      return 'STRONG_BULLISH';
    }
    if (close > ema20 && close > ema50) {
      return 'BULLISH';
    }
    if (close < ema20 && ema20 < ema50 && ema50 < ema200) {
      return 'STRONG_BEARISH';
    }
    if (close < ema20 && close < ema50) {
      return 'BEARISH';
    }
    return 'NEUTRAL';
  }

  /**
   * Analyze all technical metrics from daily candles
   */
  public static analyze(candles: Candle[]): TechnicalMetrics {
    const prices = candles.map((c) => c.close);
    const volumes = candles.map((c) => c.volume);
    const lastCandle = candles[candles.length - 1];

    const ema20 = this.calculateEMA(prices, 20);
    const ema50 = this.calculateEMA(prices, 50);
    const ema200 = this.calculateEMA(prices, 200);

    const { rvol, avgVolume20 } = this.calculateRVOL(volumes, 20);
    const { swingHigh20, swingLow20, supportLevel, resistanceLevel } =
      this.calculateSupportResistance(candles);

    const closingStrength = this.calculateClosingStrength(
      lastCandle.high,
      lastCandle.low,
      lastCandle.close
    );

    const trendAlignment = this.calculateTrendAlignment(
      lastCandle.close,
      ema20,
      ema50,
      ema200
    );

    let breakoutType: TechnicalMetrics['breakoutType'] = 'NONE';
    if (lastCandle.close > swingHigh20) {
      breakoutType = 'BREAKOUT';
    } else if (lastCandle.close < swingLow20) {
      breakoutType = 'BREAKDOWN';
    } else if (Math.abs(lastCandle.close - ema20) / ema20 < 0.01) {
      breakoutType = 'PULLBACK';
    } else {
      breakoutType = 'CONSOLIDATION';
    }

    return {
      ema20,
      ema50,
      ema200,
      rvol,
      avgVolume20,
      todayVolume: lastCandle.volume,
      swingHigh20,
      swingLow20,
      supportLevel,
      resistanceLevel,
      closingStrength,
      trendAlignment,
      breakoutType,
    };
  }
}
