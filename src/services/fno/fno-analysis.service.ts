export type FnOPositioningType =
  | 'LONG_BUILDUP'
  | 'SHORT_BUILDUP'
  | 'SHORT_COVERING'
  | 'LONG_UNWINDING'
  | 'NEUTRAL';

export interface FnoAnalysisResult {
  positioning: FnOPositioningType;
  interpretation: string;
  isBullish: boolean;
  isBearish: boolean;
  oiChangePercent: number;
  openInterest: number;
}

export class FnoAnalysisService {
  /**
   * Interpret Price Change + Open Interest (OI) Change
   */
  public static analyze(
    priceChangePercent: number,
    oiChangePercent: number,
    openInterest: number
  ): FnoAnalysisResult {
    const isPriceUp = priceChangePercent > 0.3;
    const isPriceDown = priceChangePercent < -0.3;
    const isOiUp = oiChangePercent > 1.0;
    const isOiDown = oiChangePercent < -1.0;

    let positioning: FnOPositioningType = 'NEUTRAL';
    let interpretation = 'No significant OI expansion or contraction observed.';
    let isBullish = false;
    let isBearish = false;

    if (isPriceUp && isOiUp) {
      positioning = 'LONG_BUILDUP';
      interpretation = `Strong buyers entering fresh long contracts (+${priceChangePercent}% price, +${oiChangePercent}% OI).`;
      isBullish = true;
    } else if (isPriceDown && isOiUp) {
      positioning = 'SHORT_BUILDUP';
      interpretation = `Aggressive sellers adding short contracts (${priceChangePercent}% price, +${oiChangePercent}% OI).`;
      isBearish = true;
    } else if (isPriceUp && isOiDown) {
      positioning = 'SHORT_COVERING';
      interpretation = `Short sellers rushing to cover positions driving price higher (+${priceChangePercent}% price, ${oiChangePercent}% OI).`;
      isBullish = true;
    } else if (isPriceDown && isOiDown) {
      positioning = 'LONG_UNWINDING';
      interpretation = `Long holders exiting positions (${priceChangePercent}% price, ${oiChangePercent}% OI).`;
      isBearish = true;
    }

    return {
      positioning,
      interpretation,
      isBullish,
      isBearish,
      oiChangePercent,
      openInterest,
    };
  }
}
