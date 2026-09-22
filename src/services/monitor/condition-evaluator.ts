import { DhanMarketDataService, type Candle } from '../dhan/dhan-market-data.service.js';
import { SECTOR_MAPPINGS } from '../../config/constants.js';
import { logger } from '../../utils/logger.js';
import type { IntradaySetup } from '../../schemas/analysis-response.schema.js';

/**
 * Evaluates a setup's entry conditions against live intraday data.
 *
 * This is the piece that turns a plan into something that watches the market.
 * Until now a condition was a sentence the dashboard could display but never
 * test, because the nightly scan contains none of what a condition depends
 * on: VWAP, 5-minute closes, per-bar volume, the live index level, the live
 * sector move. All five come from here.
 *
 * A condition that cannot be evaluated reports UNKNOWN. It never reports a
 * pass — a monitor that quietly treats missing data as confirmation is worse
 * than one that says nothing, because it will green-light an entry on facts
 * it does not have.
 */

export type ConditionState = 'MET' | 'NOT_MET' | 'UNKNOWN' | 'MANUAL';

export interface EvaluatedCondition {
  text: string;
  required: boolean;
  state: ConditionState;
  /** What the check actually saw, so a verdict can be argued with. */
  observed: string;
}

export interface SetupMonitorResult {
  symbol: string;
  bias: 'LONG' | 'SHORT';
  entryTrigger: number;
  lastPrice: number | null;
  vwap: number | null;
  conditions: EvaluatedCondition[];
  requiredMet: number;
  requiredTotal: number;
  /** True only when every required condition is MET. */
  entryValid: boolean;
  /** Set when the stop or a target has already been reached. */
  outcome: 'PENDING' | 'TRIGGERED' | 'STOPPED' | 'T1_HIT' | 'T2_HIT' | null;
}

export interface MarketSnapshot {
  indexLevels: Map<string, number>;
  sectorChanges: Map<string, number>;
}

const n = (v: number, d = 2) => v.toFixed(d);

/** The session's VWAP and 5-minute bars, fetched once per symbol. */
async function loadIntraday(market: DhanMarketDataService, symbol: string) {
  const candles = await market.getIntradayCandles(symbol, '5');
  if (!candles.length) return { candles, vwap: null, last: null };

  let pv = 0;
  let vol = 0;
  for (const c of candles) {
    pv += ((c.high + c.low + c.close) / 3) * c.volume;
    vol += c.volume;
  }
  return {
    candles,
    vwap: vol > 0 ? Number((pv / vol).toFixed(2)) : null,
    last: candles[candles.length - 1],
  };
}

function evaluateOne(
  condition: IntradaySetup['conditions'][number],
  ctx: { candles: Candle[]; vwap: number | null; last: Candle | null; snapshot: MarketSnapshot }
): EvaluatedCondition {
  const { check, text, required } = condition;
  const { candles, vwap, last, snapshot } = ctx;

  const unknown = (observed: string): EvaluatedCondition => ({ text, required, state: 'UNKNOWN', observed });
  const verdict = (ok: boolean, observed: string): EvaluatedCondition =>
    ({ text, required, state: ok ? 'MET' : 'NOT_MET', observed });

  switch (check.type) {
    case 'manual':
      return { text, required, state: 'MANUAL', observed: check.note || 'Needs a human judgement.' };

    case 'price_close_above':
    case 'price_close_below': {
      if (!last) return unknown('No intraday candles yet — the session may not have opened.');
      const above = last.close > check.value;
      return verdict(
        check.type === 'price_close_above' ? above : last.close < check.value,
        `Last ${check.timeframe} close ${n(last.close)} vs ${n(check.value)}`
      );
    }

    case 'above_vwap':
    case 'below_vwap': {
      if (vwap === null || !last) return unknown('VWAP needs traded volume; none yet this session.');
      return verdict(
        check.type === 'above_vwap' ? last.close > vwap : last.close < vwap,
        `Price ${n(last.close)} vs VWAP ${n(vwap)}`
      );
    }

    case 'volume_expansion': {
      // The latest bar against the mean of the preceding ones, which is what
      // "expansion versus recent bars" means in the framework.
      if (candles.length < 4) return unknown(`Only ${candles.length} bars so far; too few to judge expansion.`);
      const recent = candles.slice(-7, -1);
      const avg = recent.reduce((a, c) => a + c.volume, 0) / recent.length;
      if (avg <= 0) return unknown('Recent bars carry no volume.');
      const ratio = candles[candles.length - 1].volume / avg;
      return verdict(
        ratio >= check.multiple,
        `Latest bar ${ratio.toFixed(2)}x the last ${recent.length} bars (needs ${check.multiple}x)`
      );
    }

    case 'index_above':
    case 'index_below': {
      const level = snapshot.indexLevels.get(check.index);
      if (level === undefined) return unknown(`No live level for ${check.index}.`);
      return verdict(
        check.type === 'index_above' ? level > check.value : level < check.value,
        `${check.index} at ${n(level)} vs ${n(check.value)}`
      );
    }

    case 'sector_positive':
    case 'sector_negative': {
      const move = snapshot.sectorChanges.get(check.sector);
      if (move === undefined) return unknown(`No live reading for ${check.sector}.`);
      return verdict(
        check.type === 'sector_positive' ? move > 0 : move < 0,
        `${check.sector} ${move > 0 ? '+' : ''}${n(move)}% today`
      );
    }

    default:
      return unknown('Unrecognised check type.');
  }
}

/** Where price has already got to relative to the plan's own levels. */
function classifyOutcome(setup: IntradaySetup, candles: Candle[]): SetupMonitorResult['outcome'] {
  if (!candles.length) return null;
  const long = setup.bias === 'LONG';
  const highs = Math.max(...candles.map((c) => c.high));
  const lows = Math.min(...candles.map((c) => c.low));

  const hit = (level: number) => (long ? highs >= level : lows <= level);
  const stopped = long ? lows <= setup.stopLoss : highs >= setup.stopLoss;
  const triggered = hit(setup.entryTrigger);

  if (!triggered) return 'PENDING';
  if (hit(setup.targets[1])) return 'T2_HIT';
  if (hit(setup.targets[0])) return 'T1_HIT';
  if (stopped) return 'STOPPED';
  return 'TRIGGERED';
}

/**
 * Live index levels and sector moves.
 *
 * Dhan's quote carries no previous close, so a live change percentage cannot
 * be derived from it alone — the scan solved this from daily history, and the
 * monitor reuses those same previous closes rather than spending another
 * eighty historical calls. Without them every sector condition would report
 * unknown.
 */
export async function marketSnapshot(
  market: DhanMarketDataService,
  previousCloses: Map<string, number>
): Promise<MarketSnapshot> {
  const indexLevels = new Map<string, number>();
  for (const name of ['NIFTY 50', 'BANK NIFTY']) {
    try {
      const q = await market.getIndexQuote(name);
      indexLevels.set(name, q.lastPrice);
    } catch (err: any) {
      logger.warn({ index: name, error: err?.message }, 'Live index level unavailable for the monitor');
    }
  }

  const sectorChanges = new Map<string, number>();
  const symbols = [...new Set(SECTOR_MAPPINGS.flatMap((s) => s.symbols.slice(0, 5)))];
  try {
    const quotes = await market.getMarketQuotes(symbols);
    for (const sec of SECTOR_MAPPINGS) {
      const moves: number[] = [];
      for (const sym of sec.symbols) {
        const q = quotes.get(sym);
        const prev = previousCloses.get(sym);
        if (!q || !prev) continue;
        moves.push(((q.lastPrice - prev) / prev) * 100);
      }
      if (moves.length) {
        sectorChanges.set(sec.sector, Number((moves.reduce((a, b) => a + b, 0) / moves.length).toFixed(2)));
      }
    }
  } catch (err: any) {
    // Sector conditions then report UNKNOWN rather than passing by default.
    logger.warn({ error: err?.message }, 'Live sector moves unavailable for the monitor');
  }

  return { indexLevels, sectorChanges };
}

export async function evaluateSetup(
  market: DhanMarketDataService,
  setup: IntradaySetup,
  snapshot: MarketSnapshot
): Promise<SetupMonitorResult> {
  let candles: Candle[] = [];
  let vwap: number | null = null;
  let last: Candle | null = null;

  try {
    const intraday = await loadIntraday(market, setup.symbol);
    candles = intraday.candles;
    vwap = intraday.vwap;
    last = intraday.last;
  } catch (err: any) {
    logger.warn({ symbol: setup.symbol, error: err?.message }, 'Intraday data unavailable; conditions report unknown');
  }

  const conditions = setup.conditions.map((c) => evaluateOne(c, { candles, vwap, last, snapshot }));
  const required = conditions.filter((c) => c.required);
  const requiredMet = required.filter((c) => c.state === 'MET').length;

  return {
    symbol: setup.symbol,
    bias: setup.bias,
    entryTrigger: setup.entryTrigger,
    lastPrice: last?.close ?? null,
    vwap,
    conditions,
    requiredMet,
    requiredTotal: required.length,
    // Every required condition must be MET. UNKNOWN is not a pass.
    entryValid: required.length > 0 && requiredMet === required.length,
    outcome: classifyOutcome(setup, candles),
  };
}
