import { FNO_STOCK_UNIVERSE, SCANNER_THRESHOLDS, SECTOR_MAPPINGS } from '../../config/constants.js';
import {
  DhanMarketDataService, withChangeFromHistory,
  type MarketQuote, type QuoteWithChange, type Candle,
} from '../dhan/dhan-market-data.service.js';
import { DhanRateLimiter } from '../dhan/rate-limiter.js';
import { TechnicalIndicatorService, type TechnicalMetrics } from '../technical/indicators.js';
import { RelativeStrengthService, type RelativeStrengthMetrics } from '../technical/relative-strength.js';
import { FnoAnalysisService, type FnoAnalysisResult } from '../fno/fno-analysis.service.js';
import { NewsCatalystService, type NewsCatalystResult } from '../news/news-catalyst.service.js';
import { runFramework, STAGE_ORDER, STAGE_PART, type FilterTrace } from './framework-filters.js';
import { DataUnavailableError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

export interface StockCandidateData {
  quote: QuoteWithChange;
  sectorName: string;
  /** Turnover in crore, computed from price and volume Dhan actually returned. */
  turnoverCr: number;
  technical: TechnicalMetrics;
  relativeStrength: RelativeStrengthMetrics;
  fno: FnoAnalysisResult;
  news: NewsCatalystResult;
  candidateBias: 'LONG' | 'SHORT' | 'NEUTRAL';
  /** Every framework stage that ran, with what each concluded. */
  filters: FilterTrace;
}

export interface ScanResult {
  /** Survivors of the filter pipeline, HIGH and WATCHLIST tiers. */
  candidates: StockCandidateData[];
  /** Everything a filter rejected, each carrying the filter and the reason. */
  rejected: StockCandidateData[];
  /** The framework's stage order, so the dashboard can show the funnel as it ran. */
  stageOrder: readonly string[];
  /** How many symbols each stage rejected, in order. */
  funnel: Array<{ stage: string; part: string; rejected: number }>;
  niftyQuote: QuoteWithChange;
  bankNiftyQuote: QuoteWithChange;
  sectorPerformances: Array<{ sector: string; changePercent: number }>;
  /** Symbols the scan could not evaluate, with the reason. Surfaced, not hidden. */
  skipped: Array<{ symbol: string; reason: string }>;
}

/**
 * Dhan's historical endpoint excludes the current session, so after the close
 * its most recent daily bar is yesterday's. Analysing that would silently
 * produce a scan one day stale — every number plausible, all of them wrong for
 * tomorrow. The live quote carries today's real OHLCV, so it is appended as
 * today's bar when history has not caught up. Nothing is synthesised: these
 * are Dhan's own figures, from a different endpoint.
 */
export function withTodaysBar(history: Candle[], quote: MarketQuote): Candle[] {
  const today = new Date().toISOString().split('T')[0];
  const lastDate = history.length ? String(history[history.length - 1].timestamp).split('T')[0] : '';
  if (lastDate === today) return history;

  const { open, high, low, lastPrice, volume } = quote;
  const usable = [open, high, low, lastPrice].every((v) => Number.isFinite(v) && v > 0);
  if (!usable || !Number.isFinite(volume) || volume <= 0) return history;

  return [...history, { timestamp: `${today}T00:00:00.000Z`, open, high, low, close: lastPrice, volume }];
}

const SECTOR_BY_SYMBOL = new Map<string, string>();
for (const s of SECTOR_MAPPINGS) for (const sym of s.symbols) SECTOR_BY_SYMBOL.set(sym, s.sector);

export class CandidateScannerService {
  /** Takes the session-scoped Dhan client; there is no ambient singleton now. */
  constructor(private market: DhanMarketDataService) {}

  public async scanUniverse(): Promise<ScanResult> {
    logger.info({ universe: FNO_STOCK_UNIVERSE.length }, 'Starting NSE F&O universe scan');

    // Index moves drive relative strength and the market bias, and Dhan's
    // quote carries no previous close, so each index needs its own history.
    const niftyQuote = await this.indexWithChange('NIFTY 50');
    const bankNiftyQuote = await this.indexWithChange('BANK NIFTY');

    // One batched quote call for the whole universe rather than one per
    // symbol. Dhan allows a single quote request per second, so ~90 separate
    // calls did not merely run slowly — they earned a 429 and a warning that
    // further requests could get the account blocked.
    const rawQuotes = await this.market.getMarketQuotes(FNO_STOCK_UNIVERSE);
    logger.info({ requested: FNO_STOCK_UNIVERSE.length, returned: rawQuotes.size }, 'Universe quotes fetched');

    const skipped: Array<{ symbol: string; reason: string }> = [];

    // Phase 1 — history per symbol, and the day's move derived from it.
    // Sector performance depends on every constituent's move, so it cannot be
    // computed until this pass finishes.
    interface Prepared { quote: QuoteWithChange; candles: Candle[] }
    const prepared = new Map<string, Prepared>();

    for (const symbol of FNO_STOCK_UNIVERSE) {
      try {
        const rawQuote = rawQuotes.get(symbol);
        if (!rawQuote) {
          skipped.push({ symbol, reason: 'Dhan returned no quote for this symbol.' });
          continue;
        }

        const history = await this.market.getDailyCandles(symbol, 200);
        // History ends at yesterday, so its last close is the previous close.
        const quote = withChangeFromHistory(rawQuote, history);
        if (quote.changePercent === null || quote.previousClose === null) {
          skipped.push({ symbol, reason: "No previous close available, so the day's move cannot be computed." });
          continue;
        }

        prepared.set(symbol, {
          quote: quote as QuoteWithChange,
          candles: withTodaysBar(history, quote),
        });
      } catch (err: any) {
        skipped.push({ symbol, reason: err?.message ?? String(err) });
        logger.warn({ symbol, error: err?.message }, 'Symbol skipped during scan');
      }
    }

    const changeBySymbol = new Map<string, number>(
      [...prepared].map(([sym, p]) => [sym, p.quote.changePercent])
    );
    const sectorPerformances = this.sectorPerformanceFrom(changeBySymbol);

    // Phase 2 — indicators, then the framework's stages in order.
    const candidates: StockCandidateData[] = [];
    const rejected: StockCandidateData[] = [];

    for (const [symbol, { quote, candles }] of prepared) {
      try {
        const technical = TechnicalIndicatorService.analyze(candles, {
          week52High: quote.week52High,
          week52Low: quote.week52Low,
        });

        const sectorName = SECTOR_BY_SYMBOL.get(symbol) ?? 'NIFTY 50';
        const sectorObj = sectorPerformances.find((s) => s.sector === sectorName);
        // Null, not the Nifty's move. A missing sector reading is unknown, and
        // the sector stage treats unknown as "cannot confirm" rather than
        // quietly substituting the index and calling it sector confirmation.
        const sectorChangePercent = sectorObj ? sectorObj.changePercent : null;

        const relativeStrength = RelativeStrengthService.calculate(
          quote.changePercent,
          niftyQuote.changePercent,
          sectorChangePercent ?? niftyQuote.changePercent
        );

        const fno = FnoAnalysisService.analyze(quote.changePercent, quote.oiChangePercent, quote.openInterest);
        const news = NewsCatalystService.getNewsForSymbol(symbol);
        const turnoverCr = Number(((quote.lastPrice * quote.volume) / 1e7).toFixed(2));

        let candidateBias: StockCandidateData['candidateBias'] = 'NEUTRAL';
        if (quote.changePercent > 0 && technical.closingStrength >= 0.5) candidateBias = 'LONG';
        else if (quote.changePercent < 0 && technical.closingStrength <= 0.5) candidateBias = 'SHORT';

        const candidate: StockCandidateData = {
          quote, sectorName, turnoverCr, technical, relativeStrength, fno, news, candidateBias,
          filters: {
            symbol, tier: 'REJECTED', stages: [], rejectedBy: null, reason: null, concerns: [], volumeCharacter: null,
          },
        };

        candidate.filters = runFramework(candidate, {
          sectorChangePercent,
          niftyChangePercent: niftyQuote.changePercent,
        });

        (candidate.filters.tier === 'REJECTED' ? rejected : candidates).push(candidate);
      } catch (err: any) {
        skipped.push({ symbol, reason: err?.message ?? String(err) });
        logger.warn({ symbol, error: err?.message }, 'Symbol skipped during analysis');
      }
    }

    if (skipped.length > FNO_STOCK_UNIVERSE.length / 2) {
      throw new DataUnavailableError(
        `Scan aborted: ${skipped.length} of ${FNO_STOCK_UNIVERSE.length} symbols could not be evaluated.`,
        skipped.slice(0, 10)
      );
    }

    const funnel = STAGE_ORDER.map((stage) => ({
      stage,
      part: STAGE_PART[stage],
      rejected: rejected.filter((r) => r.filters.rejectedBy === stage).length,
    }));

    logger.info(
      {
        high: candidates.filter((c) => c.filters.tier === 'HIGH').length,
        watchlist: candidates.filter((c) => c.filters.tier === 'WATCHLIST').length,
        rejected: rejected.length,
        skipped: skipped.length,
        dhanCalls: DhanRateLimiter.stats(),
      },
      'Scan complete'
    );

    return {
      candidates, rejected, stageOrder: STAGE_ORDER, funnel,
      niftyQuote, bankNiftyQuote, sectorPerformances, skipped,
    };
  }

  /** An index quote with its day's move filled in from its own history. */
  private async indexWithChange(name: string): Promise<QuoteWithChange> {
    const quote = await this.market.getIndexQuote(name);
    const history = await this.market.getIndexCandles(name, 30);
    const withChange = withChangeFromHistory(quote, history);
    if (withChange.changePercent === null) {
      throw new DataUnavailableError(
        `Could not determine today's move for ${name}; relative strength and market bias depend on it.`
      );
    }
    return withChange as QuoteWithChange;
  }

  /** Sector move, averaged over constituents present in the quote batch. */
  private sectorPerformanceFrom(changeBySymbol: Map<string, number>): Array<{ sector: string; changePercent: number }> {
    const out: Array<{ sector: string; changePercent: number }> = [];
    for (const sec of SECTOR_MAPPINGS) {
      const changes = sec.symbols
        .map((sym) => changeBySymbol.get(sym))
        .filter((v): v is number => typeof v === 'number');
      // A sector with no constituent data is omitted, not reported as flat 0%.
      if (!changes.length) continue;
      out.push({
        sector: sec.sector,
        changePercent: Number((changes.reduce((a, b) => a + b, 0) / changes.length).toFixed(2)),
      });
    }
    return out.sort((a, b) => b.changePercent - a.changePercent);
  }

}
