import { describe, it, expect } from 'vitest';
import { TechnicalIndicatorService } from '../src/services/technical/indicators.js';

describe('TechnicalIndicatorService', () => {
  it('should correctly compute Exponential Moving Average (EMA)', () => {
    const prices = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30];
    const ema20 = TechnicalIndicatorService.calculateEMA(prices, 20);
    expect(ema20).toBeGreaterThan(19);
    expect(ema20).toBeLessThan(30);
  });

  it('should correctly compute RVOL', () => {
    const volumes = [100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 100, 250];
    const { rvol, avgVolume20 } = TechnicalIndicatorService.calculateRVOL(volumes, 20);
    expect(avgVolume20).toBe(100);
    expect(rvol).toBe(2.5);
  });

  it('should calculate closing strength ratio accurately', () => {
    const strengthHigh = TechnicalIndicatorService.calculateClosingStrength(100, 90, 100);
    expect(strengthHigh).toBe(1.0);

    const strengthLow = TechnicalIndicatorService.calculateClosingStrength(100, 90, 90);
    expect(strengthLow).toBe(0.0);

    const strengthMid = TechnicalIndicatorService.calculateClosingStrength(100, 90, 95);
    expect(strengthMid).toBe(0.5);
  });
});
