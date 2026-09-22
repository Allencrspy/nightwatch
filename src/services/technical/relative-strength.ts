export interface RelativeStrengthMetrics {
  vsNiftyPercent: number; // Stock return minus Nifty return
  vsSectorPercent: number; // Stock return minus Sector return
  outperformingNifty: boolean;
  outperformingSector: boolean;
}

export class RelativeStrengthService {
  /**
   * Calculate Relative Strength performance versus benchmark and sector
   */
  public static calculate(
    stockChangePercent: number,
    niftyChangePercent: number,
    sectorChangePercent: number
  ): RelativeStrengthMetrics {
    const vsNiftyPercent = Number((stockChangePercent - niftyChangePercent).toFixed(2));
    const vsSectorPercent = Number((stockChangePercent - sectorChangePercent).toFixed(2));

    return {
      vsNiftyPercent,
      vsSectorPercent,
      outperformingNifty: vsNiftyPercent > 0,
      outperformingSector: vsSectorPercent > 0,
    };
  }
}
