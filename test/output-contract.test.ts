import { describe, it, expect } from 'vitest';
import { CONTRACT_EXAMPLE, outputContract } from '../src/services/ai/output-contract.js';
import { readPlan } from '../src/services/ai/plan-reader.js';
import type { UniverseRow } from '../src/services/ai/universe.js';

const row = (symbol: string, close: number): UniverseRow => ({
  symbol, fno: true, sector: 'X', prevClose: close, open: close, high: close, low: close, close,
  changePct: 2, volume: 1, avgVol20: 1, rvol: 1, closePos: 0.8,
  swingHigh20: close, swingLow20: close, swingHigh50: close, swingLow50: close,
  ema20: close, ema50: close, ema200: close, atr14: 10, high52w: close, low52w: close,
  run4dPct: 1, turnoverCr: 100, vsNiftyPct: 1, sectorPct: 1,
});

const ctx = (universe: UniverseRow[]) => ({
  briefId: 'B1', promptVersion: 'test', source: 'pasted' as const,
  universe, capital: 200000, riskPercent: 0.5,
});

/**
 * The reader must never filter the analyst's findings. It computes and it
 * warns; it does not drop. These tests pin that, because the previous reader
 * dropped setups on rules the user's prompt never had.
 */
describe('plan reader', () => {
  it('reads the contract example cleanly, with nothing dropped and no warnings', () => {
    const plan = readPlan(CONTRACT_EXAMPLE, ctx([row('ABC', 500), row('XYZ', 830), row('PQR', 100)]));
    expect(plan.setups).toHaveLength(CONTRACT_EXAMPLE.setups.length);
    expect(plan.watchlist).toHaveLength(CONTRACT_EXAMPLE.watchlist.length);
    expect(plan.setups.flatMap((s) => s.warnings)).toEqual([]);
  });

  it('keeps a setup with poor risk-reward, and shows the computed figure', () => {
    const plan = readPlan(
      { setups: [{ symbol: 'ABC', bias: 'LONG', entryTrigger: 100, stopLoss: 90, targets: [101] }] },
      ctx([row('ABC', 99)])
    );
    expect(plan.setups).toHaveLength(1);
    expect(plan.setups[0].riskRewardComputed).toBe(0.1);
  });

  it('keeps a setup whose stop is on the wrong side, with a warning', () => {
    const plan = readPlan(
      { setups: [{ symbol: 'ABC', bias: 'LONG', entryTrigger: 100, stopLoss: 105, targets: [110] }] },
      ctx([row('ABC', 99)])
    );
    expect(plan.setups).toHaveLength(1);
    expect(plan.setups[0].warnings.join(' ')).toMatch(/wrong side/);
  });

  it('keeps a symbol that is not in the exchange data, with a warning, and marks it unmonitorable', () => {
    const plan = readPlan(
      { setups: [{ symbol: 'NEWCO', bias: 'LONG', entryTrigger: 100, stopLoss: 95, targets: [110] }] },
      ctx([row('ABC', 99)])
    );
    expect(plan.setups).toHaveLength(1);
    expect(plan.setups[0].monitorable).toBe(false);
    expect(plan.setups[0].warnings.join(' ')).toMatch(/not in the exchange data/);
  });

  it('sizes positions with the prompt\'s own Part 18 formula, uncapped', () => {
    const plan = readPlan(
      { setups: [{ symbol: 'ABC', bias: 'LONG', entryTrigger: 100, stopLoss: 98, targets: [106] }] },
      ctx([row('ABC', 99)])
    );
    // ₹1,000 max risk (0.5% of 2L) ÷ ₹2 stop distance = 500 shares.
    expect(plan.setups[0].positionSizing.shares).toBe(500);
  });

  it('asks for the brief id and the summary file in the contract', () => {
    const text = outputContract('B1', 'file');
    expect(text).toContain('nightwatch-reply-B1.json');
    expect(text).toContain('"briefId": "B1"');
  });
});
