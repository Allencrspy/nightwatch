export interface SectorMapping {
  sector: string;
  symbols: string[];
}

export const SECTOR_MAPPINGS: SectorMapping[] = [
  {
    sector: 'NIFTY BANK',
    symbols: ['HDFCBANK', 'ICICIBANK', 'SBIN', 'AXISBANK', 'KOTAKBANK', 'INDUSINDBK', 'BANKBARODA', 'PNB', 'FEDERALBNK', 'IDFCFIRSTB'],
  },
  {
    sector: 'NIFTY IT',
    symbols: ['TCS', 'INFY', 'WIPRO', 'HCLTECH', 'TECHM', 'LTTS', 'PERSISTENT', 'COFORGE', 'MPHASIS'],
  },
  {
    sector: 'NIFTY AUTO',
    symbols: ['TMPV', 'TMCV', 'MARUTI', 'M&M', 'BAJAJ-AUTO', 'HEROMOTOCO', 'EICHERMOT', 'TVSMOTOR', 'BHARATFORG'],
  },
  {
    sector: 'NIFTY FMCG',
    symbols: ['ITC', 'HINDUNILVR', 'NESTLEIND', 'BRITANNIA', 'TATACONSUM', 'DABUR', 'GODREJCP', 'COLPAL', 'VBL'],
  },
  {
    sector: 'NIFTY PHARMA',
    symbols: ['SUNPHARMA', 'CIPLA', 'DRREDDY', 'DIVISLAB', 'LUPIN', 'APOLLOHOSP', 'TORNTPHARM', 'BIOCON', 'MANKIND'],
  },
  {
    sector: 'NIFTY METAL',
    symbols: ['TATASTEEL', 'JSWSTEEL', 'HINDALCO', 'JINDALSTEL', 'NMDC', 'SAIL', 'NATIONALUM', 'VEDL'],
  },
  {
    sector: 'NIFTY ENERGY',
    symbols: ['RELIANCE', 'NTPC', 'POWERGRID', 'ONGC', 'BPCL', 'IOC', 'GAIL', 'TATAPOWER', 'ADANIENT', 'COALINDIA'],
  },
];

/**
 * Symbols change with corporate actions — TATAMOTORS demerged into TMPV and
 * TMCV, OBEROIRAL was renamed OBEROIRLTY. Run `npm run check:universe` after
 * any corporate action to catch stale entries against Dhan's live scrip
 * master rather than discovering them mid-scan.
 */
export const FNO_STOCK_UNIVERSE = [
  'RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'SBIN', 'AXISBANK', 'KOTAKBANK',
  'LT', 'BHARTIARTL', 'ITC', 'HINDUNILVR', 'BAJFINANCE', 'TATASTEEL', 'TMPV', 'TMCV', 'MARUTI',
  'SUNPHARMA', 'CIPLA', 'DRREDDY', 'NTPC', 'POWERGRID', 'M&M', 'TITAN', 'ULTRACEMCO',
  'ADANIENT', 'ADANIPORTS', 'JINDALSTEL', 'HINDALCO', 'WIPRO', 'HCLTECH', 'TECHM', 'LTTS',
  'BAJAJ-AUTO', 'HEROMOTOCO', 'EICHERMOT', 'TVSMOTOR', 'NESTLEIND', 'BRITANNIA', 'DABUR',
  'GODREJCP', 'DIVISLAB', 'LUPIN', 'APOLLOHOSP', 'TORNTPHARM', 'JSWSTEEL', 'SAIL', 'VEDL',
  'ONGC', 'BPCL', 'IOC', 'GAIL', 'TATAPOWER', 'COALINDIA', 'BANKBARODA', 'PNB', 'FEDERALBNK',
  'IDFCFIRSTB', 'INDUSINDBK', 'PERSISTENT', 'COFORGE', 'MPHASIS', 'BHARATFORG', 'TATACONSUM',
  'COLPAL', 'VBL', 'BIOCON', 'MANKIND', 'NMDC', 'NATIONALUM', 'DLF', 'GODREJPROP', 'OBEROIRLTY',
  'TRENT', 'BEL', 'HAL', 'RECLTD', 'PFC', 'CHOLAFIN', 'SHRIRAMFIN', 'MUTHOOTFIN', 'BAJAJFINSV'
];

/**
 * Dhan index securityIds live in the IDX_I segment, not NSE_EQ.
 * VERIFY against the scrip master before trusting these two.
 */
export const INDEX_SECURITY_IDS: Record<string, string> = {
  'NIFTY 50': '13',
  'BANK NIFTY': '25',
};

export const SCORING_WEIGHTS = {
  priceStructure: 20,
  volume: 20,
  relativeStrength: 15,
  breakoutQuality: 15,
  trend: 10,
  sector: 10,
  liquidity: 5,
  news: 5,
};

/**
 * Thresholds for the framework pipeline in framework-filters.ts. Calibrated
 * against the worked example in the night-before scan, where they reproduce
 * its verdicts: the pharma long clears at the top tier, the relative-strength
 * long in a weak sector is watchlist-only, the 8%-on-top-of-15% gainer is
 * demoted for extension, and the short with support immediately below it is
 * rejected for risk/reward.
 */
export const FILTER_THRESHOLDS = {
  /** Close must sit in the upper (long) or lower (short) half of the day. */
  minClosingStrength: 0.5,
  /** "Near the day's high" for Part 5. Between this and 0.5 is a demotion. */
  strongCloseStrength: 0.7,
  /** An intraday stop further than this is not an intraday stop. */
  maxStopDistancePercent: 5,
  /** A trigger further than this from the close may not come into play. */
  maxTriggerDistancePercent: 3,
  /** Below this, today's volume did not confirm the move. */
  minRvolForConviction: 1.0,
  /** A sector moving this hard against the trade rejects it outright. */
  sectorOpposingRejectPercent: 1.5,
  /** T1 sits at this multiple of risk, so room-to-move is measured against it. */
  targetRiskMultiple: 2,
  /**
   * Room beyond T1 by this factor is "comfortable" rather than "marginal".
   * Calibrated so the framework's worked example — room the scan itself calls
   * "acceptable" — clears rather than being demoted.
   */
  comfortableRoomMultiple: 1.2,

  extensionModerateAtrMultiple: 2,
  extensionSevereAtrMultiple: 3,
  extensionModerateRunPercent: 10,
  extensionSevereRunPercent: 18,
  extensionModerateEmaPercent: 7,
  extensionSevereEmaPercent: 12,
};

export const SCANNER_THRESHOLDS = {
  minAbsPriceChangePercent: 1.5,
  minRvol: 1.5,
  minAvgDailyVolume: 500_000,
  /** Single source of truth for the liquidity gate. The scanner reads this. */
  minLiquidityAmountInCr: 50,
};
