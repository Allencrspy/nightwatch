import type { Candle } from '../dhan/dhan-market-data.service.js';

/**
 * Replays one session's 5-minute bars against a setup's levels, in order.
 *
 * Order matters. Taking the session's high and low and asking "was the
 * trigger hit? the stop? the target?" cannot tell a trade that stopped out
 * before it triggered from one that ran to target, and it cannot tell which
 * came first when a stop and a target were both reached. Walking the bars
 * can, and where a single bar touches both the stop and a target the stop is
 * assumed to have come first — the conservative reading, since a 5-minute bar
 * does not say which way it travelled.
 *
 * Entry fills at the trigger price, or at the bar's open when price gapped
 * through it. Exits fill at the level, or the open on a gap through it. A
 * trade still open at the close is marked to the last close.
 */

export type OutcomeStatus =
  | 'NOT_TRIGGERED' // entry never reached
  | 'OPEN' // triggered, session still running
  | 'STOPPED' // stop hit before any target
  | 'T1_THEN_STOP' // T1 reached, then stopped
  | 'T1_HIT' // T1 reached, T2 not (or only one target), not stopped
  | 'T2_HIT' // final target reached
  | 'CLOSED_AT_EOD' // triggered, neither stop nor T1, closed at the session's end
  | 'NO_DATA';

export interface OutcomeLevels {
  bias: 'LONG' | 'SHORT';
  entryTrigger: number;
  stopLoss: number;
  targets: number[];
}

export interface Outcome {
  status: OutcomeStatus;
  entryTime: string | null;
  entryPrice: number | null;
  exitTime: string | null;
  exitPrice: number | null;
  /** Result in multiples of the planned risk (entry to stop). */
  rMultiple: number | null;
  /** Result as a percentage of the entry price. */
  pnlPercent: number | null;
  /** Best excursion in the trade's favour after entry, in R. */
  maxFavourableR: number | null;
  /** Worst excursion against the trade after entry, in R. */
  maxAdverseR: number | null;
}

const round = (v: number, d = 2) => Number(v.toFixed(d));

export function replaySession(
  levels: OutcomeLevels,
  candles: Candle[],
  opts: { sessionClosed: boolean }
): Outcome {
  const empty: Outcome = {
    status: 'NO_DATA', entryTime: null, entryPrice: null, exitTime: null, exitPrice: null,
    rMultiple: null, pnlPercent: null, maxFavourableR: null, maxAdverseR: null,
  };
  if (!candles.length) return empty;

  const long = levels.bias === 'LONG';
  const dir = long ? 1 : -1;
  const plannedRisk = Math.abs(levels.entryTrigger - levels.stopLoss);
  const [t1, t2] = levels.targets;
  const finalTarget = t2 ?? t1;

  const reached = (c: Candle, level: number) => (long ? c.high >= level : c.low <= level);
  const stopHit = (c: Candle) => (long ? c.low <= levels.stopLoss : c.high >= levels.stopLoss);
  // Gap through a level fills at the open; otherwise at the level.
  const fill = (c: Candle, level: number, favourable: boolean) => {
    const through = long === favourable ? c.open > level : c.open < level;
    return through ? c.open : level;
  };

  const entryIdx = candles.findIndex((c) => reached(c, levels.entryTrigger));
  if (entryIdx === -1) return { ...empty, status: 'NOT_TRIGGERED' };

  const entryBar = candles[entryIdx];
  // A long that gaps above its trigger fills at the open, which is worse.
  const entryPrice = long ? Math.max(entryBar.open, levels.entryTrigger) : Math.min(entryBar.open, levels.entryTrigger);
  const risk = plannedRisk || Math.abs(entryPrice - levels.stopLoss) || 1;

  let t1Reached = false;
  let best = 0;
  let worst = 0;
  const result = (status: OutcomeStatus, c: Candle, exitPrice: number): Outcome => {
    const move = (exitPrice - entryPrice) * dir;
    return {
      status,
      entryTime: entryBar.timestamp,
      entryPrice: round(entryPrice),
      exitTime: c.timestamp,
      exitPrice: round(exitPrice),
      rMultiple: round(move / risk),
      pnlPercent: round((move / entryPrice) * 100),
      maxFavourableR: round(best / risk),
      maxAdverseR: round(worst / risk),
    };
  };

  for (let i = entryIdx; i < candles.length; i++) {
    const c = candles[i];
    best = Math.max(best, ((long ? c.high : c.low) - entryPrice) * dir);
    worst = Math.min(worst, ((long ? c.low : c.high) - entryPrice) * dir);

    // On the entry bar only moves after the fill count; without tick data the
    // stop is still checked, conservatively.
    if (stopHit(c)) {
      return result(t1Reached ? 'T1_THEN_STOP' : 'STOPPED', c, fill(c, levels.stopLoss, false));
    }
    if (finalTarget != null && reached(c, finalTarget)) {
      return result(t2 != null ? 'T2_HIT' : 'T1_HIT', c, fill(c, finalTarget, true));
    }
    if (t1 != null && reached(c, t1)) t1Reached = true;
  }

  const last = candles[candles.length - 1];
  if (!opts.sessionClosed) {
    return { ...result('OPEN', last, last.close), exitTime: null };
  }
  // Closed at the end of the session. If T1 was reached the trade is marked
  // as a T1 hit, but the result is still the close.
  return result(t1Reached ? 'T1_HIT' : 'CLOSED_AT_EOD', last, last.close);
}
