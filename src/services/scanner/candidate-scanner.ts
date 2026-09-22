import { FNO_STOCK_UNIVERSE, SCANNER_THRESHOLDS, SECTOR_MAPPINGS } from '../../config/constants.js';
import { DhanMarketDataService, type MarketQuote } from '../dhan/dhan-market-data.service.js';
import { TechnicalIndicatorService, type TechnicalMetrics } from '../technical/indicators.js';
import { RelativeStrengthService, type RelativeStrengthMetrics } from '../technical/relative-strength.js';
import { FnoAnalysisService, type FnoAnalysisResult } from '../fno/fno-analysis.service.js';
import { NewsCatalystService, type NewsCatalystResult } from '../news/news-catalyst.service.js';
import { runFramework, STAGE_ORDER, STAGE_PART, type FilterTrace } from './framework-filters.js';
import { DataUnavailableError } from '../../utils/errors.js';
import { logger } from '../../utils/logger.js';

export interface StockCandidateData {
  quote: MarketQuote;
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
  niftyQuote: MarketQuote;
  bankNiftyQuote: MarketQuote;
  sectorPerformances: Array<{ sector: string; changePercent: number }>;
  /** Symbols the scan could not evaluate, with the reason. Surfaced, not hidden. */
  skipped: Array<{ symbol: string; reason: string }>;
}

const SECTOR_BY_SYMBOL = new Map<string, string>();
for (const s of SECTOR_MAPPINGS) for (const sym of s.symbols) SECTOR_BY_SYMBOL.set(sym, s.sector);

export class CandidateScannerService {
  /** Takes the session-scoped Dhan client; there is no ambient singleton now. */
  constructor(private market: DhanMarketDataService) {}

  public async scanUniverse(): Promise<ScanResult> {
    logger.info({ universe: FNO_STOCK_UNIVERSE.length }, 'Starting NSE F&O universe scan');

    // Index quotes gate the whole scan: relative strength is meaningless without them.
    const niftyQuote = await this.market.getIndexQuote('NIFTY 50');
    const bankNiftyQuote = await this.market.getIndexQuote('BANK NIFTY');

    const sectorPerformances = await this.calculateSectorPerformances();
    const candidates: StockCandidateData[] = [];
    const rejected: StockCandidateData[] = [];
    const skipped: Array<{ symbol: string; reason: string }> = [];

    for (const symbol of FNO_STOCK_UNIVERSE) {
      try {
        const quote = await this.market.getMarketQuote(symbol);
        const candles = await this.market.getDailyCandles(symbol, 200);

        const technical = TechnicalIndicatorService.analyze(candles);
        const sectorName = SECTOR_BY_SYMBOL.get(symbol) ?? 'NIFTY 50';
        const sectorObj = sectorPerformances.find((s) => s.sector === sectorName);
        // Null, not the Nifty's move. A missing sector reading is unknown, and
        // the sector filter treats unknown as "cannot confirm" rather than
        // quietly substituting the index and calling it sector confirmation.
        const sectorChangePercent = sectorObj ? sectorObj.changePercent : null;

        const relativeStrength = RelativeStrengthService.calculate(
          quote.changePercent,
          niftyQuote.changePercent,
          sectorChangePercent ?? niftyQuote.changePercent
        );

        const fno = FnoAnalysisService.analyze(
          quote.changePercent,
          quote.oiChangePercent,
          quote.openInterest
        );
        const news = NewsCatalystService.getNewsForSymbol(symbol);
        const turnoverCr = Number(((quote.lastPrice * quote.volume) / 1e7).toFixed(2));

        let candidateBias: StockCandidateData['candidateBias'] = 'NEUTRAL';
        if (quote.changePercent > 0 && technical.closingStrength >= 0.5) candidateBias = 'LONG';
        else if (quote.changePercent < 0 && technical.closingStrength <= 0.5) candidateBias = 'SHORT';

        const candidate: StockCandidateData = {
          quote, sectorName, turnoverCr, technical, relativeStrength, fno, news, candidateBias,
          filters: {
            symbol, tier: 'REJECTED', stages: [], rejectedBy: null, reason: null, volumeCharacter: null,
          },
        };

        // The framework's stages, in the framework's order.
        candidate.filters = runFramework(candidate, {
          sectorChangePercent,
          niftyChangePercent: niftyQuote.changePercent,
        });

        if (candidate.filters.tier === 'REJECTED') {
          rejected.push(candidate);
          continue;
        }
        candidates.push(candidate);
      } catch (err: any) {
        // One bad symbol must not fabricate a result, but must not kill the scan.
        skipped.push({ symbol, reason: err?.message ?? String(err) });
        logger.warn({ symbol, error: err?.message }, 'Symbol skipped during scan');
      }
    }

    // If most of the universe failed, the scan is not trustworthy — say so.
    if (skipped.length > FNO_STOCK_UNIVERSE.length / 2) {
      throw new DataUnavailableError(
        `Scan aborted: ${skipped.length} of ${FNO_STOCK_UNIVERSE.length} symbols could not be fetched.`,
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
        funnel,
      },
      'Scan complete'
    );

    return {
      candidates,
      rejected,
      stageOrder: STAGE_ORDER,
      funnel,
      niftyQuote,
      bankNiftyQuote,
      sectorPerformances,
      skipped,
    };
  }

  /** Sector move, averaged over constituents that actually returned a quote. */
  private async calculateSectorPerformances(): Promise<Array<{ sector: string; changePercent: number }>> {
    const results: Array<{ sector: string; changePercent: number }> = [];

    for (const sec of SECTOR_MAPPINGS) {
      const symbols = sec.symbols.slice(0, 5);
      try {
        const quotes = await this.market.getMarketQuotes(symbols);
        const changes = [...quotes.values()].map((q) => q.changePercent);
        if (changes.length === 0) continue;
        results.push({
          sector: sec.sector,
          changePercent: Number((changes.reduce((a, b) => a + b, 0) / changes.length).toFixed(2)),
        });
      } catch (err: any) {
        // A sector with no data is omitted rather than reported as flat at 0%.
        logger.warn({ sector: sec.sector, error: err?.message }, 'Sector performance unavailable');
      }
    }

    return results.sort((a, b) => b.changePercent - a.changePercent);
  }
}
