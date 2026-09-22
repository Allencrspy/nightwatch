import axios, { type AxiosInstance } from 'axios';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { DataUnavailableError, UpstreamError } from '../../utils/errors.js';
import { InstrumentMaster } from './instrument-master.js';
import { INDEX_SECURITY_IDS } from '../../config/constants.js';

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
  low: number;
  close: number;
  previousClose: number;
  change: number;
  changePercent: number;
  volume: number;
  /** Derivatives-only. Null for cash equity requests. */
  openInterest: number | null;
  oiChangePercent: number | null;
  unavailable: string[];
}

const SEGMENT_NSE_EQ = 'NSE_EQ';

function toIsoDate(d: Date): string {
  return d.toISOString().split('T')[0];
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

    if (candles.length < 50) {
      throw new DataUnavailableError(
        `Dhan returned only ${candles.length} daily candles for ${symbol}; at least 50 are needed for EMA and swing levels.`
      );
    }
    return candles.slice(-days);
  }

  /**
   * Intraday candles at the given minute interval. This is what the condition
   * monitor runs on: 5-minute closes and per-bar volume.
   */
  public async getIntradayCandles(symbol: string, interval: '1' | '5' | '15' | '25' | '60' = '5'): Promise<Candle[]> {
    const securityId = await InstrumentMaster.securityId(symbol);
    const today = toIsoDate(new Date());

    const payload = {
      securityId,
      exchangeSegment: SEGMENT_NSE_EQ,
      instrument: 'EQUITY',
      interval,
      fromDate: today,
      toDate: today,
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
    const ids = new Map<string, string>();
    for (const s of symbols) ids.set(s.toUpperCase(), await InstrumentMaster.securityId(s));

    const payload = { [SEGMENT_NSE_EQ]: [...ids.values()].map((v) => Number(v)) };
    const data = await this.post('/marketfeed/quote', payload, symbols.join(','));

    const bySecurityId: Record<string, any> = data?.[SEGMENT_NSE_EQ] ?? data?.data?.[SEGMENT_NSE_EQ] ?? {};
    const out = new Map<string, MarketQuote>();

    for (const [symbol, securityId] of ids) {
      const row = bySecurityId[securityId] ?? bySecurityId[String(Number(securityId))];
      if (!row) {
        logger.warn({ symbol, securityId }, 'Dhan quote response omitted this symbol');
        continue;
      }

      const ohlc = row.ohlc ?? row;
      const lastPrice = Number(row.last_price ?? row.lastPrice ?? row.ltp);
      const previousClose = Number(ohlc.close ?? row.close ?? row.prev_close);
      const open = Number(ohlc.open ?? row.open);
      const high = Number(ohlc.high ?? row.high);
      const low = Number(ohlc.low ?? row.low);
      const volume = Number(row.volume ?? row.total_traded_quantity ?? row.totalTradedQuantity ?? 0);

      if (!Number.isFinite(lastPrice) || !Number.isFinite(previousClose) || previousClose === 0) {
        logger.warn({ symbol }, 'Dhan quote lacked a usable price; skipping rather than substituting');
        continue;
      }

      const change = Number((lastPrice - previousClose).toFixed(2));

      out.set(symbol, {
        symbol,
        securityId,
        lastPrice,
        open,
        high,
        low,
        close: lastPrice,
        previousClose,
        change,
        changePercent: Number(((change / previousClose) * 100).toFixed(2)),
        volume,
        // Cash-equity quotes carry no open interest. Saying so beats inventing it.
        openInterest: null,
        oiChangePercent: null,
        unavailable: ['openInterest', 'oiChangePercent'],
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

    const data = await this.post('/marketfeed/quote', { IDX_I: [Number(securityId)] }, indexName);
    const rows: Record<string, any> = data?.IDX_I ?? data?.data?.IDX_I ?? {};
    const row = rows[securityId] ?? rows[String(Number(securityId))];
    if (!row) throw new DataUnavailableError(`Dhan returned no quote for index ${indexName}.`);

    const ohlc = row.ohlc ?? row;
    const lastPrice = Number(row.last_price ?? row.lastPrice ?? row.ltp);
    const previousClose = Number(ohlc.close ?? row.close);
    if (!Number.isFinite(lastPrice) || !Number.isFinite(previousClose) || previousClose === 0) {
      throw new DataUnavailableError(`Index quote for ${indexName} lacked a usable price.`);
    }

    const change = Number((lastPrice - previousClose).toFixed(2));
    return {
      symbol: indexName,
      securityId,
      lastPrice,
      open: Number(ohlc.open ?? row.open),
      high: Number(ohlc.high ?? row.high),
      low: Number(ohlc.low ?? row.low),
      close: lastPrice,
      previousClose,
      change,
      changePercent: Number(((change / previousClose) * 100).toFixed(2)),
      volume: 0,
      openInterest: null,
      oiChangePercent: null,
      unavailable: ['volume', 'openInterest', 'oiChangePercent'],
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

  private async post(pathname: string, payload: unknown, context: string): Promise<any> {
    try {
      const res = await this.http.post(pathname, payload);
      return res.data;
    } catch (err: any) {
      const status = err.response?.status;
      const detail = err.response?.data ?? err.message;
      logger.error({ pathname, context, status, detail }, 'Dhan request failed');

      if (status === 401 || status === 403) {
        throw new UpstreamError('Dhan', 'the session was rejected. Log in again.', detail);
      }
      if (status === 429) {
        throw new UpstreamError('Dhan', 'rate limit hit. Slow the scan down or reduce the universe.', detail);
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
