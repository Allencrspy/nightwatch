import type { DhanMarketDataService } from '../dhan/dhan-market-data.service.js';
import type { PlanRecord, PlanReview, SetupReview } from '../ai/plan-history.js';
import { replaySession } from './outcome.js';
import { logger } from '../../utils/logger.js';

/**
 * Works out how a plan's setups actually played out.
 *
 * A plan written on the evening of day D is for the next session. That is
 * normally the next weekday; when it is an exchange holiday Dhan returns no
 * bars, and the next weekday is tried instead.
 */

const IST_MS = 5.5 * 3600 * 1000;
const todayIst = () => new Date(Date.now() + IST_MS).toISOString().slice(0, 10);

export function nextWeekday(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  do d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
  return d.toISOString().slice(0, 10);
}

/** True once the 15:30 IST close of that session has passed. */
export function sessionClosed(date: string): boolean {
  return Date.now() >= new Date(`${date}T15:30:00+05:30`).getTime();
}

export class ReviewNotReadyError extends Error {}

export async function reviewPlan(market: DhanMarketDataService, rec: PlanRecord): Promise<PlanReview> {
  const dataDate = rec.context?.dataDate
    ?? new Date(new Date(rec.acceptedAt).getTime() + IST_MS).toISOString().slice(0, 10);
  let sessionDate = rec.review?.sessionDate ?? nextWeekday(dataDate);

  const setups = rec.plan.setups.filter((s) => s.entryTrigger > 0 && s.stopLoss > 0);

  for (let attempt = 0; attempt < 5; attempt++) {
    if (sessionDate > todayIst()) {
      throw new ReviewNotReadyError(`The session this plan is for (${sessionDate}) has not started yet.`);
    }
    const closed = sessionClosed(sessionDate);
    const results: SetupReview[] = [];
    let anyBars = false;

    for (const s of setups) {
      let candles: Awaited<ReturnType<DhanMarketDataService['getIntradayCandles']>> = [];
      try {
        candles = await market.getIntradayCandles(s.symbol, '5', sessionDate);
      } catch (err: any) {
        logger.warn({ symbol: s.symbol, sessionDate, error: err?.message }, 'Review: intraday bars unavailable');
      }
      if (candles.length) anyBars = true;
      results.push({
        symbol: s.symbol,
        bias: s.bias,
        top3Rank: rec.plan.top3.includes(s.symbol) ? rec.plan.top3.indexOf(s.symbol) + 1 : null,
        entryTrigger: s.entryTrigger,
        stopLoss: s.stopLoss,
        targets: s.targets,
        outcome: replaySession(s, candles, { sessionClosed: closed }),
      });
    }

    // No bars for any setup on a past weekday: an exchange holiday. Try the next.
    if (!anyBars && closed && setups.length) {
      sessionDate = nextWeekday(sessionDate);
      continue;
    }
    return { sessionDate, reviewedAt: new Date().toISOString(), final: closed, setups: results };
  }
  throw new ReviewNotReadyError('No intraday data found for the five sessions after this plan.');
}

/** Totals across every reviewed plan. */
export function trackRecord(records: PlanRecord[]) {
  const reviewed = records.filter((r) => r.review);
  const trades = reviewed.flatMap((r) => r.review!.setups.map((s) => ({ ...s, briefId: r.briefId, sessionDate: r.review!.sessionDate })));
  const taken = trades.filter((t) => t.outcome.rMultiple != null);
  const wins = taken.filter((t) => (t.outcome.rMultiple ?? 0) > 0);
  const sum = (xs: typeof taken) => Number(xs.reduce((a, t) => a + (t.outcome.rMultiple ?? 0), 0).toFixed(2));
  const byStatus: Record<string, number> = {};
  for (const t of trades) byStatus[t.outcome.status] = (byStatus[t.outcome.status] ?? 0) + 1;
  const top3 = taken.filter((t) => t.top3Rank);

  return {
    plans: reviewed.length,
    setups: trades.length,
    triggered: taken.length,
    triggerRate: trades.length ? Number(((taken.length / trades.length) * 100).toFixed(1)) : null,
    winRate: taken.length ? Number(((wins.length / taken.length) * 100).toFixed(1)) : null,
    totalR: sum(taken),
    avgR: taken.length ? Number((sum(taken) / taken.length).toFixed(2)) : null,
    top3: { triggered: top3.length, totalR: sum(top3), avgR: top3.length ? Number((sum(top3) / top3.length).toFixed(2)) : null },
    byStatus,
  };
}
