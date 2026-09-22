export interface NewsCatalystResult {
  hasNews: boolean;
  headline?: string;
  sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
  score: number; // 0 to 5 points
}

export class NewsCatalystService {
  /**
   * Fetch or evaluate news catalysts for a stock
   */
  public static getNewsForSymbol(symbol: string): NewsCatalystResult {
    // Known stock specific catalysts for testing
    if (['RELIANCE', 'TATAMOTORS'].includes(symbol)) {
      return {
        hasNews: true,
        headline: 'Strong quarterly volume growth and positive margin guidance',
        sentiment: 'BULLISH',
        score: 5,
      };
    }
    if (['SBIN', 'SUNPHARMA'].includes(symbol)) {
      return {
        hasNews: true,
        headline: 'Regulatory inquiry update and margin pressure warnings',
        sentiment: 'BEARISH',
        score: 1,
      };
    }

    return {
      hasNews: false,
      headline: 'No major price-sensitive news declared',
      sentiment: 'NEUTRAL',
      score: 3,
    };
  }
}
