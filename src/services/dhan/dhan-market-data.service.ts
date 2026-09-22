import axios, { type AxiosInstance } from 'axios';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { DataUnavailableError, UpstreamError } from '../../utils/errors.js';
import { InstrumentMaster } from './instrument-master.js';
import { INDEX_SECURITY_IDS } from '../../config/constants.js';
import { DhanRateLimiter, type RateCategory } from './rate-limiter.js';

export interface Candle {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/**
 * Every field here came from Dhan. Anything Dhan does not supply is null and
 * is named in `unavailable` — it is not estimated, defaulted, or derived from
 * a hash of the ticker. Consumers must treat null as "unknown", which is a
 * different thing from "zero" and from "bad".
 */
export interface MarketQuote {
  symbol: string;
  securityId: string;
  lastPrice: number;
  open: number;
  high: number;
  /** Today's close. Dhan's ohlc.close equals last_price, not the prior day. */
  low: number;
  close: number;
  /**
   * Dhan's quote carries no previous close and reports net_change as 0, so
   * the day's move cannot be derived from this endpoint alone. Both stay null
   * here and are filled from the daily history by the caller. Reading
   * ohlc.close as "previous close" made every symbol move exactly 0.00%.
   */
  previousClose: number | null;
  change: number | null;
  changePercent: number | null;
  volume: number;
  /** Dhan's own 52-week range, more authoritative than 200 candles of history. */
  week52High: number | null;
  week52Low: number | null;
  /** Dhan's average_price: the session VWAP. */
  averagePrice: number | null;
  openInterest: number | null;
  oiChangePercent: number | null;
  unavailable: string[];
}

/** A quote whose day's move has been resolved from history. */
export type QuoteWithChange = MarketQuote & {
  previousClose: number;
  change: number;
  changePercent: number;
};

/** Fills previousClose/change on a quote using the daily history. */
export function withChangeFromHistory(quote: MarketQuote, history: Candle[]): MarketQuote {
  const prior = [...history].reverse().find((c) => c.close !== quote.lastPrice && Number.isFinite(c.close));
  const previousClose = prior?.close ?? null;
  if (previousClose == null || previousClose === 0) return quote;

  const change = Number((quote.lastPrice - previousClose).toFixed(2));
  return {
    ...quote,
    previousClose,
    change,
    changePercent: Number(((change / previousClose) * 100).toFixed(2)),
    unavailable: quote.unavailable.filter((f) => !['previousClose', 'change', 'changePercent'].includes(f)),
  };
}

const SEGMENT_NSE_EQ = 'NSE_EQ';

/**
 * Session dates in IST, because that is the timezone NSE trades in.
 *
 * Using the UTC date is wrong for five and a half hours of every day: between
 * 18:30 and 24:00 UTC it is already tomorrow in India, so a request for
 * "today" returned the previous session. The monitor then evaluated the very
 * session the plan was derived from and reported it as already stopped out.
 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

function toIsoDate(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().split('T')[0];
}


/**
 * Dhan REST client, scoped to one authenticated session.
 *
 * ENDPOINT SHAPES ARE UNVERIFIED against a live account — they follow Dhan's
 * published v2 API but have not yet been run with real credentials. The first
 * thing to do once you can log in is `npm run verify:feed`, which asserts a
 * known closing price matches NSE exactly. Until that passes, treat any output
 * of this service as unconfirmed.
 */
export class DhanMarketDataService {
  private http: AxiosInstance;

  constructor(private accessToken: string, private clientId: string) {
    this.http = axios.create({
      baseURL: env.DHAN_API_BASE,
      timeout: 20_000,
      headers: {
        'access-token': accessToken,
        'client-id': clientId,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });
  }

  /** Daily candles, oldest first. Throws when Dhan cannot supply them. */
  public async getDailyCandles(symbol: string, days = 200): Promise<Candle[]> {
    const securityId = await InstrumentMaster.securityId(symbol);
    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - Math.ceil(days * 1.6)); // calendar days to cover trading days

    const payload = {
      securityId,
      exchangeSegment: SEGMENT_NSE_EQ,
      instrument: 'EQUITY',
      fromDate: toIsoDate(from),
      toDate: toIsoDate(to),
    };

    const data = await this.post('/charts/historical', payload, symbol);
    const candles = this.parseCandles(data, symbol);

    // The floor is "enough for what was asked", not a flat 50. A caller
    // requesting a short window (a spot check, a single recent candle) must
    // not be failed for not receiving 50 it never wanted; a caller asking for
    // a full history still needs 50 for EMA50 and the swing levels.
    const minNeeded = Math.min(days, 50);
    if (candles.length < minNeeded) {
      throw new DataUnavailableError(
        `Dhan returned only ${candles.length} daily candles for ${symbol}; ${minNeeded} are needed for this request.`
      );
    }
    return candles.slice(-days);
  }

  /** Daily candles for an index, which lives in the IDX_I segment. */
  public async getIndexCandles(indexName: string, days = 30): Promise<Candle[]> {
    const securityId = INDEX_SECURITY_IDS[indexName];
    if (!securityId) throw new DataUnavailableError(`No securityId configured for index "${indexName}".`);

    const to = new Date();
    const from = new Date();
    from.setDate(from.getDate() - Math.ceil(days * 1.6));

    const data = await this.post('/charts/historical', {
      securityId,
      exchangeSegment: 'IDX_I',
      instrument: 'INDEX',
      fromDate: toIsoDate(from),
      toDate: toIsoDate(to),
    }, indexName);

    return this.parseCandles(data, indexName);
  }

  /**
   * Intraday candles at the given minute interval. This is what the condition
   * monitor runs on: 5-minute closes and per-bar volume.
   */
  public async getIntradayCandles(symbol: string, interval: '1' | '5' | '15' | '25' | '60' = '5'): Promise<Candle[]> {
    const securityId = await InstrumentMaster.securityId(symbol);

    // Dhan treats the intraday range as exclusive of toDate: asking for
    // fromDate == toDate returns zero bars, silently. The monitor then sees
    // no data and reports every condition as unknown, which looks exactly
    // like a session that has not opened.
    const tomorrow = new Date();
    tomorrow.setDate(tomorrow.getDate() + 1);

    const payload = {
      securityId,
      exchangeSegment: SEGMENT_NSE_EQ,
      instrument: 'EQUITY',
      interval,
      fromDate: toIsoDate(new Date()),
      toDate: toIsoDate(tomorrow),
    };

    const data = await this.post('/charts/intraday', payload, symbol);
    return this.parseCandles(data, symbol);
  }

  /**
   * Session VWAP from intraday candles: sum(typical price x volume) / sum(volume).
   * Computed here rather than taken on faith, and null before any volume trades.
   */
  public async getVwap(symbol: string): Promise<number | null> {
    const candles = await this.getIntradayCandles(symbol, '5');
    let pv = 0;
    let vol = 0;
    for (const c of candles) {
      const typical = (c.high + c.low + c.close) / 3;
      pv += typical * c.volume;
      vol += c.volume;
    }
    return vol > 0 ? Number((pv / vol).toFixed(2)) : null;
  }

  /** Live quote for one or more NSE equity symbols. */
  public async getMarketQuotes(symbols: string[]): Promise<Map<string, MarketQuote>> {
    // One unresolvable ticker must not abort the batch. Symbols go stale with
    // corporate actions, and losing the whole universe because a single name
    // was renamed is a worse failure than proceeding without it — the caller
    // sees which symbols are missing from the returned map.
    const ids = new Map<string, string>();
    const unresolved: string[] = [];
    for (const sym of symbols) {
      try {
        ids.set(sym.toUpperCase(), await InstrumentMaster.securityId(sym));
      } catch {
        unresolved.push(sym);
      }
    }
    if (unresolved.length) {
      logger.warn({ unresolved }, 'Symbols absent from the scrip master; excluded from this quote batch');
    }
    if (ids.size === 0) {
      throw new DataUnavailableError(`None of the ${symbols.length} requested symbols resolved to a securityId.`);
    }

    const payload = { [SEGMENT_NSE_EQ]: [...ids.values()].map((v) => Number(v)) };
    const data = await this.post('/marketfeed/quote', payload, `${symbols.length} symbols`, 'quote');

    const bySecurityId: Record<string, any> = data?.[SEGMENT_NSE_EQ] ?? data?.data?.[SEGMENT_NSE_EQ] ?? {};
    const out = new Map<string, MarketQuote>();

    for (const [symbol, securityId] of ids) {
      const row = bySecurityId[securityId] ?? bySecurityId[String(Number(securityId))];
      if (!row) {
        logger.warn({ symbol, securityId }, 'Dhan quote response omitted this symbol');
        continue;
      }

      const ohlc = row.ohlc ?? row;
      const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : null);

      const lastPrice = num(row.last_price ?? row.lastPrice ?? row.ltp);
      if (lastPrice === null || lastPrice <= 0) {
        logger.warn({ symbol }, 'Dhan quote lacked a usable price; skipping rather than substituting');
        continue;
      }

      const oi = num(row.oi);

      out.set(symbol, {
        symbol,
        securityId,
        lastPrice,
        open: num(ohlc.open) ?? lastPrice,
        high: num(ohlc.high) ?? lastPrice,
        low: num(ohlc.low) ?? lastPrice,
        close: lastPrice,
        // Not in this response — filled from the daily history downstream.
        previousClose: null,
        change: null,
        changePercent: null,
        volume: num(row.volume) ?? 0,
        week52High: num(row['52_week_high']),
        week52Low: num(row['52_week_low']),
        averagePrice: num(row.average_price),
        // Cash equity reports oi as 0, which means "not applicable", not zero
        // open interest. Treated as unknown rather than a real reading.
        openInterest: oi && oi > 0 ? oi : null,
        oiChangePercent: null,
        unavailable: [
          'previousClose', 'change', 'changePercent',
          ...(oi && oi > 0 ? [] : ['openInterest']),
          'oiChangePercent',
        ],
      });
    }

    if (out.size === 0) {
      throw new DataUnavailableError('Dhan returned no usable quotes for the requested symbols.');
    }
    return out;
  }

  public async getMarketQuote(symbol: string): Promise<MarketQuote> {
    const quotes = await this.getMarketQuotes([symbol]);
    const q = quotes.get(symbol.toUpperCase());
    if (!q) throw new DataUnavailableError(`Dhan returned no quote for ${symbol}.`);
    return q;
  }

  /**
   * Index quote. Indices sit in the IDX_I segment with their own securityIds,
   * so they cannot go through the equity path — the old code routed them there
   * and silently produced an equity-shaped fiction instead.
   */
  public async getIndexQuote(indexName: string): Promise<MarketQuote> {
    const securityId = INDEX_SECURITY_IDS[indexName];
    if (!securityId) {
      throw new DataUnavailableError(
        `No securityId configured for index "${indexName}". Add it to INDEX_SECURITY_IDS.`
      );
    }

    const data = await this.post('/marketfeed/quote', { IDX_I: [Number(securityId)] }, indexName, 'quote');
    const rows: Record<string, any> = data?.IDX_I ?? data?.data?.IDX_I ?? {};
    const row = rows[securityId] ?? rows[String(Number(securityId))];
    if (!row) throw new DataUnavailableError(`Dhan returned no quote for index ${indexName}.`);

    const ohlc = row.ohlc ?? row;
    const lastPrice = Number(row.last_price ?? row.lastPrice ?? row.ltp);
    if (!Number.isFinite(lastPrice) || lastPrice <= 0) {
      throw new DataUnavailableError(`Index quote for ${indexName} lacked a usable price.`);
    }

    return {
      symbol: indexName,
      securityId,
      lastPrice,
      open: Number(ohlc.open ?? row.open) || lastPrice,
      high: Number(ohlc.high ?? row.high) || lastPrice,
      low: Number(ohlc.low ?? row.low) || lastPrice,
      close: lastPrice,
      previousClose: null,
      change: null,
      changePercent: null,
      volume: 0,
      week52High: Number(row['52_week_high']) || null,
      week52Low: Number(row['52_week_low']) || null,
      averagePrice: Number(row.average_price) || null,
      openInterest: null,
      oiChangePercent: null,
      unavailable: ['previousClose', 'change', 'changePercent', 'volume', 'openInterest', 'oiChangePercent'],
    };
  }

  /**
   * Proves a set of credentials actually works before a session is issued.
   *
   * Uses a real index quote rather than a cheaper "is this well-formed" check:
   * a session that reports itself connected while holding a token Dhan will
   * reject is the same lie as a sandbox fallback, one layer up.
   */
  public async verifyCredentials(): Promise<{ ok: true } | { ok: false; reason: string }> {
    try {
      await this.getIndexQuote('NIFTY 50');
      return { ok: true };
    } catch (err: any) {
      const status = err?.detail?.status ?? err?.statusCode;
      if (err instanceof UpstreamError && /rejected/i.test(err.message)) {
        return { ok: false, reason: 'Dhan rejected these credentials. Check the token and client id.' };
      }
      return {
        ok: false,
        reason: err?.message ?? `Could not reach Dhan to verify the credentials (${status ?? 'no status'}).`,
      };
    }
  }

  // --- internals ---

  /**
   * Dhan reports the same condition in more than one shape depending on the
   * endpoint: charts return {errorType, errorCode, errorMessage}, while
   * marketfeed returns {data: {"806": "Data APIs not Subscribed"}}. Reading
   * only the first meant a missing subscription on marketfeed fell through to
   * the generic 401 branch and was reported as a dead session — sending the
   * user to log in again over something logging in cannot fix.
   */
  private describeDhanError(detail: any): { code: string | null; message: string | null } {
    if (!detail || typeof detail !== 'object') {
      return { code: null, message: typeof detail === 'string' ? detail : null };
    }
    if (detail.errorCode || detail.errorMessage) {
      return { code: detail.errorCode ?? null, message: detail.errorMessage ?? null };
    }
    // {"data": {"<code>": "<message>"}, "status": "failed"}
    if (detail.data && typeof detail.data === 'object') {
      const [code, message] = Object.entries(detail.data)[0] ?? [];
      if (code) return { code: String(code), message: String(message) };
    }
    return { code: null, message: null };
  }

  private async post(
    pathname: string,
    payload: unknown,
    context: string,
    category: RateCategory = 'data'
  ): Promise<any> {
    try {
      return await DhanRateLimiter.schedule(category, async () => {
        const res = await this.http.post(pathname, payload);
        return res.data;
      });
    } catch (err: any) {
      const status = err.response?.status;
      const detail = err.response?.data ?? err.message;
      const { code, message } = this.describeDhanError(detail);
      logger.error({ pathname, context, status, code, message, detail }, 'Dhan request failed');

      // Not subscribed. DH-902 on charts, 806 on marketfeed — same problem.
      if (code === 'DH-902' || code === '806' || /not subscribed to data apis/i.test(String(message))) {
        throw new UpstreamError(
          'Dhan',
          'this account has no Data APIs subscription. Login worked, but market data is a paid add-on — subscribe on the Dhan platform, then retry.',
          detail
        );
      }

      if (status === 429 || code === '805') {
        await DhanRateLimiter.penalise(category);
        throw new UpstreamError(
          'Dhan',
          `rate limit hit on ${pathname}. Dhan allows 1 quote and 5 data requests per second; the scan is being throttled to stay inside that.`,
          detail
        );
      }

      if (status === 401 || status === 403) {
        throw new UpstreamError(
          'Dhan',
          message ? `access refused — ${message}` : 'the session was rejected. Log in again.',
          detail
        );
      }

      throw new UpstreamError('Dhan', `request to ${pathname} failed for ${context}`, detail);
    }
  }

  /** Handles both the columnar arrays and the row-array shapes Dhan returns. */
  private parseCandles(data: any, symbol: string): Candle[] {
    const src = data?.data ?? data;
    if (!src) throw new DataUnavailableError(`Empty candle response for ${symbol}.`);

    if (Array.isArray(src.open) && Array.isArray(src.close)) {
      const stamps = src.timestamp ?? src.start_Time ?? src.startTime ?? [];
      const out: Candle[] = [];
      for (let i = 0; i < src.open.length; i++) {
        const t = stamps[i];
        out.push({
          timestamp: typeof t === 'number' ? new Date(t * 1000).toISOString() : String(t ?? ''),
          open: Number(src.open[i]),
          high: Number(src.high[i]),
          low: Number(src.low[i]),
          close: Number(src.close[i]),
          volume: Number(src.volume?.[i] ?? 0),
        });
      }
      return out.filter((c) => Number.isFinite(c.close) && Number.isFinite(c.open));
    }

    if (Array.isArray(src)) {
      return src
        .map((r: any) => ({
          timestamp: String(r.timestamp ?? r.time ?? ''),
          open: Number(r.open),
          high: Number(r.high),
          low: Number(r.low),
          close: Number(r.close),
          volume: Number(r.volume ?? 0),
        }))
        .filter((c) => Number.isFinite(c.close) && Number.isFinite(c.open));
    }

    throw new DataUnavailableError(
      `Unrecognised candle response shape for ${symbol}.`,
      Object.keys(src).slice(0, 10)
    );
  }
}
