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
    symbols: ['TCS', 'INFY', 'WIPRO', 'HCLTECH', 'TECHM', 'LTIM', 'PERSISTENT', 'COFORGE', 'MPHASIS'],
  },
  {
    sector: 'NIFTY AUTO',
    symbols: ['TATAMOTORS', 'MARUTI', 'M&M', 'BAJAJ-AUTO', 'HEROMOTOCO', 'EICHERMOT', 'TVSMOTOR', 'BHARATFORG'],
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

export const FNO_STOCK_UNIVERSE = [
  'RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK', 'SBIN', 'AXISBANK', 'KOTAKBANK',
  'LT', 'BHARTIARTL', 'ITC', 'HINDUNILVR', 'BAJFINANCE', 'TATASTEEL', 'TATAMOTORS', 'MARUTI',
  'SUNPHARMA', 'CIPLA', 'DRREDDY', 'NTPC', 'POWERGRID', 'M&M', 'TITAN', 'ULTRACEMCO',
  'ADANIENT', 'ADANIPORTS', 'JINDALSTEL', 'HINDALCO', 'WIPRO', 'HCLTECH', 'TECHM', 'LTIM',
  'BAJAJ-AUTO', 'HEROMOTOCO', 'EICHERMOT', 'TVSMOTOR', 'NESTLEIND', 'BRITANNIA', 'DABUR',
  'GODREJCP', 'DIVISLAB', 'LUPIN', 'APOLLOHOSP', 'TORNTPHARM', 'JSWSTEEL', 'SAIL', 'VEDL',
  'ONGC', 'BPCL', 'IOC', 'GAIL', 'TATAPOWER', 'COALINDIA', 'BANKBARODA', 'PNB', 'FEDERALBNK',
  'IDFCFIRSTB', 'INDUSINDBK', 'PERSISTENT', 'COFORGE', 'MPHASIS', 'BHARATFORG', 'TATACONSUM',
  'COLPAL', 'VBL', 'BIOCON', 'MANKIND', 'NMDC', 'NATIONALUM', 'DLF', 'GODREJPROP', 'OBEROIRAL',
  'TRENT', 'BEL', 'HAL', 'RECLTD', 'PFC', 'CHOLAFIN', 'SHRIRAMFIN', 'MUTHOOTFIN', 'BAJAJFINSV'
];

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

export const SCANNER_THRESHOLDS = {
  minAbsPriceChangePercent: 1.5,
  minRvol: 1.5,
  minAvgDailyVolume: 500000, // minimum volume
  minLiquidityAmountInCr: 50, // minimum 50 Cr daily turnover
};
