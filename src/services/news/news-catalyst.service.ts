export interface NewsCatalystResult {
  /** False when no news source is configured — distinct from "no news found". */
  available: boolean;
  hasNews: boolean;
  headline?: string;
  sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL' | 'UNKNOWN';
  /** 0–5, or null when unknown. Null must not be scored as a middling value. */
  score: number | null;
  note: string;
}

/**
 * No news provider is wired up yet, so this reports "unknown" for every symbol.
 *
 * It previously returned hardcoded headlines for a handful of tickers —
 * including an invented regulatory story attached to a real listed company —
 * and scored a fabricated 5/5 or 1/5 off the back of them. That is removed.
 * Until a real feed is connected, the catalyst factor is excluded from the
 * assessable score rather than defaulted to a neutral 3/5, which quietly
 * inflated every candidate that simply had no news attached.
 */
export class NewsCatalystService {
  public static getNewsForSymbol(_symbol: string): NewsCatalystResult {
    return {
      available: false,
      hasNews: false,
      sentiment: 'UNKNOWN',
      score: null,
      note: 'No news source configured. Catalyst is unassessed, not neutral.',
    };
  }
}
