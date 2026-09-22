import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';
import { env } from '../../config/env.js';
import { DataUnavailableError, UpstreamError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

/**
 * Dhan's market-data endpoints key off a numeric securityId, not a ticker.
 * This resolves SUNPHARMA -> 3351 from the published scrip master, cached on
 * disk for the day. A symbol that cannot be resolved raises an error; it is
 * never guessed, and never silently skipped.
 */

const CACHE_FILE = '.instrument-master.json';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface Cached {
  fetchedAt: number;
  /** NSE equity only: TRADING SYMBOL -> securityId */
  nseEq: Record<string, string>;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
      else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      out.push(cur); cur = '';
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

export class InstrumentMaster {
  private static map: Map<string, string> | null = null;
  private static loading: Promise<Map<string, string>> | null = null;

  private static get cachePath(): string {
    return path.resolve(process.cwd(), CACHE_FILE);
  }

  public static async load(): Promise<Map<string, string>> {
    if (this.map) return this.map;
    if (this.loading) return this.loading;

    this.loading = (async () => {
      const cached = this.readCache();
      if (cached) {
        this.map = new Map(Object.entries(cached.nseEq));
        logger.info({ symbols: this.map.size }, 'Instrument master loaded from cache');
        return this.map;
      }

      const csv = await this.download();
      const parsed = this.parse(csv);
      if (parsed.size === 0) {
        throw new DataUnavailableError(
          'Instrument master downloaded but no NSE equity rows were found. The CSV layout may have changed.'
        );
      }

      this.map = parsed;
      this.writeCache(parsed);
      logger.info({ symbols: parsed.size }, 'Instrument master downloaded');
      return parsed;
    })();

    try {
      return await this.loading;
    } finally {
      this.loading = null;
    }
  }

  /** Throws rather than returning undefined — an unresolved symbol is a real failure. */
  public static async securityId(symbol: string): Promise<string> {
    const map = await this.load();
    const id = map.get(symbol.toUpperCase());
    if (!id) {
      throw new DataUnavailableError(
        `No NSE equity securityId found for "${symbol}". Check the symbol against Dhan's scrip master.`
      );
    }
    return id;
  }

  private static async download(): Promise<string> {
    try {
      const res = await axios.get<string>(env.DHAN_INSTRUMENT_MASTER_URL, {
        responseType: 'text',
        timeout: 60_000,
        maxContentLength: 200 * 1024 * 1024,
      });
      return res.data;
    } catch (err: any) {
      throw new UpstreamError('Dhan scrip master', err.message, err.response?.status);
    }
  }

  /**
   * Column names are matched by header rather than position, since Dhan has
   * changed the ordering before. Kept tolerant of the documented aliases.
   */
  private static parse(csv: string): Map<string, string> {
    const lines = csv.split(/\r?\n/).filter((l) => l.trim().length > 0);
    if (lines.length < 2) return new Map();

    const header = splitCsvLine(lines[0]).map((h) => h.trim().toUpperCase());
    const idx = (...names: string[]) => {
      for (const n of names) {
        const i = header.indexOf(n);
        if (i !== -1) return i;
      }
      return -1;
    };

    const iExch = idx('SEM_EXM_EXCH_ID', 'EXCH_ID');
    const iSegment = idx('SEM_SEGMENT', 'SEGMENT');
    const iSecId = idx('SEM_SMST_SECURITY_ID', 'SECURITY_ID');
    const iSymbol = idx('SEM_TRADING_SYMBOL', 'TRADING_SYMBOL');
    const iInstrument = idx('SEM_INSTRUMENT_NAME', 'INSTRUMENT');

    if (iExch === -1 || iSecId === -1 || iSymbol === -1) {
      logger.error({ header: header.slice(0, 12) }, 'Unexpected scrip master header');
      return new Map();
    }

    const out = new Map<string, string>();
    for (let i = 1; i < lines.length; i++) {
      const row = splitCsvLine(lines[i]);
      if (row[iExch]?.trim().toUpperCase() !== 'NSE') continue;

      // Cash equity only. Derivatives rows share ticker prefixes and would collide.
      const segment = iSegment !== -1 ? row[iSegment]?.trim().toUpperCase() : 'E';
      if (segment !== 'E' && segment !== 'EQUITY') continue;
      if (iInstrument !== -1) {
        const inst = row[iInstrument]?.trim().toUpperCase();
        if (inst && inst !== 'EQUITY' && inst !== 'ES') continue;
      }

      const symbol = row[iSymbol]?.trim().toUpperCase();
      const secId = row[iSecId]?.trim();
      if (symbol && secId && !out.has(symbol)) out.set(symbol, secId);
    }
    return out;
  }

  private static readCache(): Cached | null {
    try {
      if (!fs.existsSync(this.cachePath)) return null;
      const c = JSON.parse(fs.readFileSync(this.cachePath, 'utf8')) as Cached;
      if (Date.now() - c.fetchedAt > CACHE_TTL_MS) return null;
      return c;
    } catch {
      return null;
    }
  }

  private static writeCache(map: Map<string, string>): void {
    try {
      const payload: Cached = { fetchedAt: Date.now(), nseEq: Object.fromEntries(map) };
      fs.writeFileSync(this.cachePath, JSON.stringify(payload));
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Could not cache instrument master');
    }
  }
}
