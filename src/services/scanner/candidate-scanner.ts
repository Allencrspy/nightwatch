import { FNO_STOCK_UNIVERSE, SCANNER_THRESHOLDS, SECTOR_MAPPINGS } from '../../config/constants.js';
import { DhanMarketDataService, type MarketQuote } from '../dhan/dhan-market-data.service.js';
import { TechnicalIndicatorService, type TechnicalMetrics } from '../technical/indicators.js';
import { RelativeStrengthService, type RelativeStrengthMetrics } from '../technical/relative-strength.js';
import { FnoAnalysisService, type FnoAnalysisResult } from '../fno/fno-analysis.service.js';
import { NewsCatalystService, type NewsCatalystResult } from '../news/news-catalyst.service.js';
import { logger } from '../../utils/logger.js';

export interface StockCandidateData {
  quote: MarketQuote;
  technical: TechnicalMetrics;
  relativeStrength: RelativeStrengthMetrics;
  fno: FnoAnalysisResult;
  news: NewsCatalystResult;
  candidateBias: 'LONG' | 'SHORT' | 'NEUTRAL';
}

export class CandidateScannerService {
  private marketDataService: DhanMarketDataService;

  constructor() {
    this.marketDataService = DhanMarketDataService.getInstance();
  }

  /**
   * Scan F&O Universe and select candidates passing volume, price change, & RVOL thresholds
   */
  public async scanUniverse(): Promise<{
    candidates: StockCandidateData[];
    niftyQuote: MarketQuote;
    bankNiftyQuote: MarketQuote;
    sectorPerformances: Array<{ sector: string; changePercent: number }>;
  }> {
    logger.info('Starting NSE F&O Universe Candidate Scan...');

    const niftyQuote = await this.marketDataService.getIndexQuote('NIFTY 50');
    const bankNiftyQuote = await this.marketDataService.getIndexQuote('BANK NIFTY');

    // Calculate sector performance
    const sectorPerformances = await this.calculateSectorPerformances();

    const candidates: StockCandidateData[] = [];

    // Scan top universe symbols
    for (const symbol of FNO_STOCK_UNIVERSE) {
      try {
        const quote = await this.marketDataService.getMarketQuote(symbol);
        const candles = await this.marketDataService.getDailyCandles(symbol, 200);

        if (candles.length < 50) continue;

        const technical = TechnicalIndicatorService.analyze(candles);
        
        // Find matching sector performance
        const sectorObj = sectorPerformances.find((s) => s.sector === quote.sectorName);
        const sectorChangePercent = sectorObj ? sectorObj.changePercent : niftyQuote.changePercent;

        const relativeStrength = RelativeStrengthService.calculate(
          quote.changePercent,
          niftyQuote.changePercent,
          sectorChangePercent
        );

        const fno = FnoAnalysisService.analyze(
          quote.changePercent,
          quote.oiChangePercent,
          quote.openInterest
        );

        const news = NewsCatalystService.getNewsForSymbol(symbol);

        // Candidate filter criteria:
        // 1. |changePercent| >= 1.5 OR rvol >= 1.5
        // 2. Liquidity (tradedValueCr >= 10 Cr)
        const passesAbsChange = Math.abs(quote.changePercent) >= SCANNER_THRESHOLDS.minAbsPriceChangePercent;
        const passesRvol = technical.rvol >= SCANNER_THRESHOLDS.minRvol;

        if ((passesAbsChange || passesRvol) && quote.totalTradedValueCr >= 10) {
          let candidateBias: 'LONG' | 'SHORT' | 'NEUTRAL' = 'NEUTRAL';
          if (quote.changePercent > 0 && technical.closingStrength >= 0.5) {
            candidateBias = 'LONG';
          } else if (quote.changePercent < 0 && technical.closingStrength <= 0.5) {
            candidateBias = 'SHORT';
          }

          candidates.push({
            quote,
            technical,
            relativeStrength,
            fno,
            news,
            candidateBias,
          });
        }
      } catch (err: any) {
        logger.warn({ symbol, error: err.message }, 'Error scanning symbol');
      }
    }

    logger.info({ candidateCount: candidates.length }, 'Candidate scan complete');

    return {
      candidates,
      niftyQuote,
      bankNiftyQuote,
      sectorPerformances,
    };
  }

  private async calculateSectorPerformances(): Promise<Array<{ sector: string; changePercent: number }>> {
    const results: Array<{ sector: string; changePercent: number }> = [];

    for (const sec of SECTOR_MAPPINGS) {
      let totalChange = 0;
      let count = 0;

      for (const sym of sec.symbols.slice(0, 4)) {
        try {
          const q = await this.marketDataService.getMarketQuote(sym);
          totalChange += q.changePercent;
          count++;
        } catch {
          // ignore
        }
      }

      const avgChange = count > 0 ? Number((totalChange / count).toFixed(2)) : 0;
      results.push({
        sector: sec.sector,
        changePercent: avgChange,
      });
    }

    return results.sort((a, b) => b.changePercent - a.changePercent);
  }
}
