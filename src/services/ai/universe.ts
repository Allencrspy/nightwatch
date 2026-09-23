import type { StockCandidateData } from '../scanner/candidate-scanner.js';

/**
 * One row per F&O stock, computed from the exchange feed.
 *
 * The analyst gets the whole universe, not a pre-screened handful. The prompt
 * asks it to scan the F&O universe itself (Part 2) and it did that well when
 * run by hand — what it lacked was exact numbers. A pre-screen here would
 * quietly substitute this code's judgement for the analyst's, which is the
 * one thing the framework's month of real use argues against.
 */
export interface UniverseRow {
  symbol: string;
  /** On the F&O list. Non-F&O names appear only when the user asks for them. */
  fno: boolean;
  sector: string;
  prevClose: number;
  open: number;
  high: number;
  low: number;
  close: number;
  changePct: number;
  volume: number;
  avgVol20: number;
  rvol: number;
  closePos: number;       // where the close sat in the day's range, 0 = low, 1 = high
  swingHigh20: number;
  swingLow20: number;
  swingHigh50: number;
  swingLow50: number;
  ema20: number;
  ema50: number;
  ema200: number;
  atr14: number;
  high52w: number;
  low52w: number;
  run4dPct: number;       // return over the last four sessions
  turnoverCr: number;
  vsNiftyPct: number;
  sectorPct: number | null;
}

const r = (v: number, dp = 2) => Number(v.toFixed(dp));

export function universeRow(c: StockCandidateData, sectorPct: number | null, fno = true): UniverseRow {
  const q = c.quote as any;
  const t = c.technical;
  return {
    symbol: q.symbol,
    fno,
    sector: c.sectorName === 'NIFTY 50' ? 'Other' : c.sectorName.replace(/^NIFTY /, ''),
    prevClose: r(q.previousClose),
    open: r(q.open),
    high: r(q.high),
    low: r(q.low),
    close: r(q.lastPrice),
    changePct: r(q.changePercent),
    volume: q.volume,
    avgVol20: t.avgVolume20,
    rvol: r(t.rvol),
    closePos: r(t.closingStrength),
    swingHigh20: r(t.swingHigh20),
    swingLow20: r(t.swingLow20),
    swingHigh50: r(t.swingHigh50),
    swingLow50: r(t.swingLow50),
    ema20: r(t.ema20),
    ema50: r(t.ema50),
    ema200: r(t.ema200),
    atr14: r(t.atr14),
    high52w: r(t.high52w),
    low52w: r(t.low52w),
    run4dPct: r(t.return4Session),
    turnoverCr: r(c.turnoverCr, 1),
    vsNiftyPct: r(c.relativeStrength.vsNiftyPercent),
    sectorPct: sectorPct === null ? null : r(sectorPct),
  };
}

const COLUMNS: Array<[keyof UniverseRow, string]> = [
  ['symbol', 'symbol'], ['fno', 'fno'], ['sector', 'sector'],
  ['changePct', 'chg%'], ['close', 'close'], ['prevClose', 'prev'],
  ['open', 'open'], ['high', 'high'], ['low', 'low'], ['closePos', 'closePos'],
  ['volume', 'volume'], ['avgVol20', 'avgVol20'], ['rvol', 'rvol'], ['turnoverCr', 'turnoverCr'],
  ['swingHigh20', 'swingHi20'], ['swingLow20', 'swingLo20'],
  ['swingHigh50', 'swingHi50'], ['swingLow50', 'swingLo50'],
  ['ema20', 'ema20'], ['ema50', 'ema50'], ['ema200', 'ema200'],
  ['atr14', 'atr14'], ['high52w', 'hi52w'], ['low52w', 'lo52w'],
  ['run4dPct', 'run4d%'], ['vsNiftyPct', 'vsNifty%'], ['sectorPct', 'sector%'],
];

/**
 * A tab-separated table, sorted by the day's move so the candidates the
 * prompt's Part 2 asks for sit at the two ends. Far fewer tokens than JSON
 * for eighty rows, and every chat assistant reads it cleanly.
 */
export function universeTable(rows: UniverseRow[]): string {
  const sorted = [...rows].sort((a, b) => b.changePct - a.changePct);
  // The symbol is repeated at the end of every row. With 26 columns, reading
  // a value from the neighbouring line is easy — one reply took a stop from
  // SAIL's row for TATASTEEL — and the bookend makes the row boundary explicit.
  const header = [...COLUMNS.map(([, h]) => h), 'symbol'].join('\t');
  const body = sorted.map((row) =>
    [...COLUMNS.map(([k]) => {
      const v = row[k];
      return v === null || v === undefined ? '—' : typeof v === 'boolean' ? (v ? 'Y' : 'N') : String(v);
    }), row.symbol].join('\t')
  );
  return [header, ...body].join('\n');
}
