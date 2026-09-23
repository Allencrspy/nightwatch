import { describe, it, expect } from 'vitest';
import { replaySession } from '../src/services/monitor/outcome';
import { nextWeekday, trackRecord } from '../src/services/monitor/review';

const bar = (i: number, open: number, high: number, low: number, close: number) =>
  ({ timestamp: `2026-09-24T09:${String(15 + i * 5).padStart(2, '0')}:00+05:30`, open, high, low, close, volume: 1000 });

const LONG = { bias: 'LONG' as const, entryTrigger: 100, stopLoss: 98, targets: [103, 106] };
const SHORT = { bias: 'SHORT' as const, entryTrigger: 100, stopLoss: 102, targets: [97, 94] };
const closed = { sessionClosed: true };

describe('replaySession', () => {
  it('never triggers when price stays below a long trigger', () => {
    const r = replaySession(LONG, [bar(0, 99, 99.5, 98.5, 99), bar(1, 99, 99.8, 98.9, 99.5)], closed);
    expect(r.status).toBe('NOT_TRIGGERED');
    expect(r.rMultiple).toBeNull();
  });

  it('ignores a stop-level low that came before the trigger', () => {
    // Dipped to 97 first (below the stop), then triggered and ran to T2.
    const r = replaySession(LONG, [bar(0, 99, 99.5, 97, 99), bar(1, 99, 100.5, 99, 100.3), bar(2, 100.3, 106.5, 100.2, 106)], closed);
    expect(r.status).toBe('T2_HIT');
    expect(r.rMultiple).toBe(3);
  });

  it('marks a stop after T1 as T1_THEN_STOP at -1R', () => {
    const r = replaySession(LONG, [bar(0, 99, 100.5, 99, 100.2), bar(1, 100.2, 103.5, 100, 103), bar(2, 103, 103, 97.5, 98)], closed);
    expect(r.status).toBe('T1_THEN_STOP');
    expect(r.rMultiple).toBe(-1);
    expect(r.maxFavourableR).toBe(1.75);
  });

  it('assumes the stop came first when one bar touches both stop and target', () => {
    const r = replaySession(LONG, [bar(0, 99, 100.5, 99, 100.2), bar(1, 100.2, 106.5, 97.5, 101)], closed);
    expect(r.status).toBe('STOPPED');
  });

  it('fills a gap through the trigger at the open, not the trigger', () => {
    const r = replaySession(LONG, [bar(0, 101, 102, 100.8, 101.5)], closed);
    expect(r.entryPrice).toBe(101);
    expect(r.status).toBe('CLOSED_AT_EOD');
    expect(r.rMultiple).toBe(0.25);
  });

  it('handles shorts', () => {
    const r = replaySession(SHORT, [bar(0, 101, 101, 99.5, 99.8), bar(1, 99.8, 100, 93.5, 94)], closed);
    expect(r.status).toBe('T2_HIT');
    expect(r.rMultiple).toBe(3);
  });

  it('treats a single target as the final one', () => {
    const r = replaySession({ ...LONG, targets: [103] }, [bar(0, 99, 100.5, 99, 100.2), bar(1, 100.2, 103.2, 100, 103)], closed);
    expect(r.status).toBe('T1_HIT');
    expect(r.rMultiple).toBe(1.5);
  });

  it('reports OPEN while the session is running', () => {
    const r = replaySession(LONG, [bar(0, 99, 100.5, 99, 100.4)], { sessionClosed: false });
    expect(r.status).toBe('OPEN');
    expect(r.exitTime).toBeNull();
  });

  it('reports NO_DATA without bars', () => {
    expect(replaySession(LONG, [], closed).status).toBe('NO_DATA');
  });
});

describe('review helpers', () => {
  it('skips weekends', () => {
    expect(nextWeekday('2026-09-23')).toBe('2026-09-24'); // Wed -> Thu
    expect(nextWeekday('2026-09-25')).toBe('2026-09-28'); // Fri -> Mon
  });

  it('totals R across reviewed plans', () => {
    const o = (status: any, r: number | null) => ({ status, rMultiple: r } as any);
    const rec: any = { briefId: 'A', review: { sessionDate: '2026-09-24', setups: [
      { symbol: 'X', top3Rank: 1, outcome: o('T2_HIT', 3) },
      { symbol: 'Y', top3Rank: null, outcome: o('STOPPED', -1) },
      { symbol: 'Z', top3Rank: 2, outcome: o('NOT_TRIGGERED', null) },
    ] } };
    const t = trackRecord([rec]);
    expect(t.triggered).toBe(2);
    expect(t.winRate).toBe(50);
    expect(t.totalR).toBe(2);
    expect(t.top3.totalR).toBe(3);
  });
});
