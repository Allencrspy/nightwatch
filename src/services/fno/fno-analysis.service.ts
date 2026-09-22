export type FnOPositioningType =
  | 'UNKNOWN'
  | 'LONG_BUILDUP'
  | 'SHORT_BUILDUP'
  | 'SHORT_COVERING'
  | 'LONG_UNWINDING'
  | 'NEUTRAL';

export interface FnoAnalysisResult {
  positioning: FnOPositioningType;
  interpretation: string;
  /** False when open interest was not available at all. */
  available: boolean;
  isBullish: boolean;
  isBearish: boolean;
  oiChangePercent: number | null;
  openInterest: number | null;
}

export class FnoAnalysisService {
  /**
   * Interpret Price Change + Open Interest (OI) Change
   */
  public static analyze(
    priceChangePercent: number,
    oiChangePercent: number | null,
    openInterest: number | null
  ): FnoAnalysisResult {
    // Cash-equity quotes carry no OI. Previously this received a number derived
    // from a hash of the ticker and produced confident prose from it.
    if (oiChangePercent === null || openInterest === null) {
      return {
        positioning: 'UNKNOWN',
        interpretation: 'Open interest unavailable for this instrument; positioning not assessed.',
        available: false,
        isBullish: false,
        isBearish: false,
        oiChangePercent: null,
        openInterest: null,
      };
    }

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
      available: true,
      isBullish,
      isBearish,
      oiChangePercent,
      openInterest,
    };
  }
}
