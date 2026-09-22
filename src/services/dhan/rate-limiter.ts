import { logger } from '../../utils/logger.js';

/**
 * Serialises outbound Dhan calls to stay inside the published rate limits.
 *
 * Per DhanHQ docs: Quote APIs allow 1 request/second, Data APIs 5/second,
 * non-trading 20/second, with a 100,000/day ceiling on Data APIs. Exceeding
 * them does not merely fail the request — Dhan's own 429 body warns that
 * "further requests may result in the user being blocked", so this is about
 * protecting the account, not just avoiding errors.
 *
 * Each category gets its own queue and minimum spacing. Calls run in order
 * and never overlap within a category, which is the simplest thing that is
 * actually correct; categories run independently of one another.
 */
export type RateCategory = 'quote' | 'data' | 'other';

const MIN_INTERVAL_MS: Record<RateCategory, number> = {
  // 1/sec, plus a margin — the published limit is the point at which Dhan
  // starts refusing, not a target to sit exactly on.
  quote: 1100,
  data: 220, // 5/sec
  other: 60, // 20/sec
};

interface Queue {
  last: number;
  chain: Promise<unknown>;
  count: number;
}

export class DhanRateLimiter {
  private static queues: Record<RateCategory, Queue> = {
    quote: { last: 0, chain: Promise.resolve(), count: 0 },
    data: { last: 0, chain: Promise.resolve(), count: 0 },
    other: { last: 0, chain: Promise.resolve(), count: 0 },
  };

  /** Runs `fn` once the category's spacing allows it. */
  public static schedule<T>(category: RateCategory, fn: () => Promise<T>): Promise<T> {
    const q = this.queues[category];

    const run = async (): Promise<T> => {
      const wait = q.last + MIN_INTERVAL_MS[category] - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      q.last = Date.now();
      q.count++;
      return fn();
    };

    // Chain onto the category's queue so calls never overlap, and keep the
    // chain alive when one rejects.
    const result = q.chain.then(run, run);
    q.chain = result.then(() => undefined, () => undefined);
    return result;
  }

  /** Counts since process start, for the log view and for spotting runaway loops. */
  public static stats(): Record<RateCategory, number> {
    return { quote: this.queues.quote.count, data: this.queues.data.count, other: this.queues.other.count };
  }

  /** Backs off after a 429 before the next call in that category. */
  public static async penalise(category: RateCategory, ms = 2000): Promise<void> {
    logger.warn({ category, ms }, 'Rate limited by Dhan; backing off');
    this.queues[category].last = Date.now() + ms;
  }
}
