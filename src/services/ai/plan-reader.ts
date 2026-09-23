import type { UniverseRow } from './universe.js';

/**
 * Reads the analyst's summary file into a plan the dashboard and monitor use.
 *
 * It filters nothing. Every watchlist name and every setup the analyst wrote
 * comes through, because the method is the user's prompt and it has a month
 * of real results behind it — this code has none. Earlier versions dropped
 * setups for a risk-reward below 1.5:1, for stops that were not on a fixed
 * menu of levels, and for names outside a pre-screen; each of those replaced
 * the analyst's judgement with this code's, and quietly changed the output.
 *
 * What it adds is arithmetic and warnings. It computes risk-reward and
 * position size per the prompt's own Part 18 formula, and where something
 * looks internally inconsistent — a stop on the wrong side of the entry, a
 * symbol with no exchange data — it says so next to the setup. The user sees
 * exactly what the analyst said, plus anything worth a second look, and
 * decides.
 */

export interface PlanCondition {
  text: string;
  required: boolean;
  check: { type: string; [k: string]: unknown };
}

export interface PlanSetup {
  symbol: string;
  bias: 'LONG' | 'SHORT';
  setup: string;
  score: number | null;
  entryTrigger: number;
  stopLoss: number;
  targets: number[];
  riskRewardStated: string | null;
  /** Reward to T1 over risk, computed from the analyst's own levels. */
  riskRewardComputed: number | null;
  why: string;
  catalyst: string;
  invalidation: string;
  bullishScenario: string;
  bearishScenario: string;
  gapPlan: Array<{ condition: string; action: string }>;
  conditions: PlanCondition[];
  /** Part 18: maximum acceptable loss ÷ stop-loss distance. */
  positionSizing: { maxRiskRupees: number; shares: number | null; positionValue: number | null };
  inTop3: boolean;
  /** 1-3, the analyst's order in its Part 19 top 3; null when not in it. */
  top3Rank: number | null;
  /** Present when there is exchange data, so the monitor can watch it live. */
  monitorable: boolean;
  warnings: string[];
}

export interface PlanWatchItem {
  rank: number | null;
  symbol: string;
  bias: string;
  setup: string;
  score: number | null;
  keyLevel: number | null;
  note: string;
  warnings: string[];
}

export interface Plan {
  briefId: string;
  promptVersion: string;
  source: 'pasted' | 'api';
  acceptedAt: string;
  dataAsOf: string | null;
  market: {
    bias: string | null;
    strength: string | null;
    read: string;
    strongestSectors: string[];
    weakestSectors: string[];
  };
  noHighQualitySetup: boolean;
  watchlist: PlanWatchItem[];
  setups: PlanSetup[];
  top3: string[];
  stocksToAvoid: Array<{ symbol: string; reason: string }>;
  bestLong: string | null;
  bestShort: string | null;
  noTradeConditions: string[];
  checklist900to915: string[];
  selfCritique: string | null;
  /** Anything about the file as a whole worth flagging. */
  warnings: string[];
}

const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[₹,\s]/g, ''));
    return Number.isFinite(n) && v.trim() !== '' ? n : null;
  }
  return null;
};
// ChatGPT's web citations leak into text as private-use markers such as
// "\ue200cite\ue202turn0news12\ue201"; with the markers lost, "citeturn0news12".
const CITATION = /[\ue200-\ue2ff]?cite(?:[\ue200-\ue2ff]?turn\d+[a-z]+\d+)+[\ue200-\ue2ff]?/gi;
const str = (v: unknown): string =>
  v === null || v === undefined ? '' : String(v).replace(CITATION, '').replace(/[\ue200-\ue2ff]/g, '').replace(/\s+([.,;])/g, '$1').trim();
const strArr = (v: unknown): string[] => (Array.isArray(v) ? v.map(str).filter(Boolean) : []);
const bias = (v: unknown): 'LONG' | 'SHORT' => (/short/i.test(str(v)) ? 'SHORT' : 'LONG');

export function readPlan(
  raw: any,
  ctx: {
    briefId: string;
    promptVersion: string;
    source: 'pasted' | 'api';
    universe: UniverseRow[];
    capital: number;
    riskPercent: number;
  }
): Plan {
  const bySymbol = new Map(ctx.universe.map((u) => [u.symbol, u]));
  const maxRiskRupees = Number(((ctx.capital * ctx.riskPercent) / 100).toFixed(2));
  const top3 = strArr(raw.top3 ?? raw.top3BestSetups).map((s) => s.toUpperCase());
  const warnings: string[] = [];

  const setups: PlanSetup[] = (Array.isArray(raw.setups) ? raw.setups : []).map((s: any) => {
    const symbol = str(s.symbol).toUpperCase().trim();
    const b = bias(s.bias);
    const entry = num(s.entryTrigger ?? s.entry);
    const stop = num(s.stopLoss ?? s.stop ?? s.sl);
    const targets = (Array.isArray(s.targets) ? s.targets : [s.target, s.target2])
      .map(num)
      .filter((v: number | null): v is number => v !== null);
    const w: string[] = [];

    const row = bySymbol.get(symbol);
    if (!row) w.push(`${symbol || 'This setup'} is not in the exchange data table, so it can't be monitored live. Check the symbol.`);

    if (entry === null) w.push('No entry trigger given.');
    if (stop === null) w.push('No stop loss given.');
    if (!targets.length) w.push('No target given.');

    let rr: number | null = null;
    let shares: number | null = null;
    let positionValue: number | null = null;

    if (entry !== null && stop !== null) {
      const risk = b === 'LONG' ? entry - stop : stop - entry;
      if (risk <= 0) {
        w.push(`Stop ${stop} is on the wrong side of entry ${entry} for a ${b.toLowerCase()} — worth checking.`);
      } else {
        if (targets.length) {
          const reward = b === 'LONG' ? targets[0] - entry : entry - targets[0];
          rr = Number((reward / risk).toFixed(2));
          if (reward <= 0) w.push(`Target ${targets[0]} is on the wrong side of entry ${entry} — worth checking.`);
        }
        // Part 18, as written: maximum acceptable loss ÷ stop-loss distance.
        shares = Math.floor(maxRiskRupees / risk);
        positionValue = Number((shares * entry).toFixed(2));
        if (positionValue > ctx.capital) {
          w.push(
            `Position size from Part 18 (₹${maxRiskRupees.toLocaleString('en-IN')} ÷ ₹${risk.toFixed(2)} stop distance = ${shares} shares) ` +
            `is worth ₹${Math.round(positionValue).toLocaleString('en-IN')}, more than your capital. The stop may be very tight.`
          );
        }
      }
    }

    // A level that matches another stock's figure but none of this stock's
    // is almost always a misread row in the table.
    if (row) {
      const LEVELS: Array<keyof UniverseRow> = ['close', 'prevClose', 'open', 'high', 'low',
        'swingHigh20', 'swingLow20', 'swingHigh50', 'swingLow50', 'ema20', 'ema50', 'ema200', 'high52w', 'low52w'];
      const labelled: Array<[string, number | null]> = [
        ['entry', entry], ['stop', stop], ...targets.map((t: number, i: number): [string, number] => [`T${i + 1}`, t]),
      ];
      for (const [label, v] of labelled) {
        if (v === null) continue;
        const own = LEVELS.some((k) => Math.abs((row[k] as number) - v) < 0.011);
        if (own) continue;
        // Levels built as entry ± n × ATR belong to this stock, whatever else they match.
        const anchors = [entry, stop, ...LEVELS.map((k) => row[k] as number)].filter((a): a is number => a !== null);
        const fromAtr = row.atr14 > 0 && anchors.some((a) =>
          [0.5, 1, 1.5, 2, 2.5, 3].some((n) => Math.abs(Math.abs(v - a) - n * row.atr14) < 0.011));
        if (fromAtr) continue;
        const other = ctx.universe.find((u) => u.symbol !== symbol &&
          LEVELS.some((k) => Math.abs((u[k] as number) - v) < 0.011));
        if (other) {
          w.push(`${label} ${v} matches ${other.symbol}'s data, not ${symbol}'s — it may have been read from the wrong row.`);
        }
      }

      if (entry !== null) {
        if (b === 'LONG' && entry < row.close) {
          w.push(`Long trigger ${entry} is already below today's close of ${row.close}, so it would be hit at the open.`);
        }
        if (b === 'SHORT' && entry > row.close) {
          w.push(`Short trigger ${entry} is already above today's close of ${row.close}, so it would be hit at the open.`);
        }
      }
    }

    if (row && entry !== null && row.atr14 > 0) {
      const away = Math.abs(entry - row.close) / row.atr14;
      if (away > 1.5) {
        w.push(`Entry ${entry} is ${away.toFixed(1)}× ATR (${(Math.abs(entry - row.close) / row.close * 100).toFixed(1)}%) from today's close of ${row.close} — it may not trigger in one session.`);
      }
    }

    if (row && entry !== null && Math.abs(entry - row.close) / row.close > 0.1) {
      w.push(`Entry ${entry} is more than 10% from today's close of ${row.close} — check it refers to the right stock.`);
    }

    const conditions: PlanCondition[] = Array.isArray(s.conditions) && s.conditions.length
      ? s.conditions.filter((c: any) => c && c.check && c.check.type).map((c: any) => ({
          text: str(c.text) || str(c.check.type),
          required: c.required !== false,
          check: c.check,
        }))
      : entry !== null
        // No confirmations listed: the trigger is still worth watching.
        ? [{
            text: `5-minute close ${b === 'LONG' ? 'above' : 'below'} ${entry}`,
            required: true,
            check: { type: b === 'LONG' ? 'price_close_above' : 'price_close_below', value: entry, timeframe: '5m' },
          }]
        : [];

    return {
      symbol,
      bias: b,
      setup: str(s.setup ?? s.setupType) || '—',
      score: num(s.score),
      entryTrigger: entry ?? 0,
      stopLoss: stop ?? 0,
      targets,
      riskRewardStated: s.riskReward !== undefined ? str(s.riskReward) : null,
      riskRewardComputed: rr,
      why: str(s.why),
      catalyst: str(s.catalyst),
      invalidation: str(s.invalidation),
      bullishScenario: str(s.bullishScenario),
      bearishScenario: str(s.bearishScenario),
      gapPlan: (Array.isArray(s.gapPlan) ? s.gapPlan : [])
        .filter((g: any) => g && (g.condition || g.action))
        .map((g: any) => ({ condition: str(g.condition), action: str(g.action) })),
      conditions,
      positionSizing: { maxRiskRupees, shares, positionValue },
      inTop3: top3.includes(symbol),
      top3Rank: top3.includes(symbol) ? top3.indexOf(symbol) + 1 : null,
      monitorable: Boolean(row) && entry !== null && stop !== null,
      warnings: w,
    };
  });

  const watchlist: PlanWatchItem[] = (Array.isArray(raw.watchlist) ? raw.watchlist : []).map((x: any) => {
    const symbol = str(x.symbol ?? x.stock).toUpperCase().trim();
    const w: string[] = [];
    if (symbol && !bySymbol.has(symbol)) w.push('Not in the exchange data table — check the symbol.');
    return {
      rank: num(x.rank),
      symbol,
      bias: str(x.bias).toUpperCase() || '—',
      setup: str(x.setup ?? x.setupType) || '—',
      score: num(x.score),
      keyLevel: num(x.keyLevel ?? x.level),
      note: str(x.note ?? x.why),
      warnings: w,
    };
  });

  const avoided = new Map((Array.isArray(raw.stocksToAvoid) ? raw.stocksToAvoid : [])
    .map((a: any) => [str(a?.symbol ?? a?.stock).toUpperCase(), str(a?.reason)] as [string, string]));
  for (const s of setups) {
    if (avoided.has(s.symbol)) s.warnings.push(`Also listed under stocks to avoid: ${avoided.get(s.symbol)}`);
  }

  if (!setups.length && !watchlist.length && !raw.noHighQualitySetup) {
    warnings.push('The file has no setups, no watchlist, and does not say there is no high-quality setup. It may be incomplete.');
  }

  return {
    briefId: ctx.briefId,
    promptVersion: ctx.promptVersion,
    source: ctx.source,
    acceptedAt: new Date().toISOString(),
    dataAsOf: raw.dataAsOf ? str(raw.dataAsOf) : null,
    market: {
      bias: raw.marketBias ? str(raw.marketBias).toUpperCase() : null,
      strength: raw.marketStrength ? str(raw.marketStrength) : null,
      read: str(raw.marketRead),
      strongestSectors: strArr(raw.strongestSectors),
      weakestSectors: strArr(raw.weakestSectors),
    },
    noHighQualitySetup: Boolean(raw.noHighQualitySetup),
    watchlist,
    setups,
    top3,
    stocksToAvoid: (Array.isArray(raw.stocksToAvoid) ? raw.stocksToAvoid : []).map((a: any) => ({
      symbol: str(a.symbol ?? a.stock).toUpperCase(),
      reason: str(a.reason),
    })),
    bestLong: raw.bestLong ? str(raw.bestLong) : null,
    bestShort: raw.bestShort ? str(raw.bestShort) : null,
    noTradeConditions: strArr(raw.noTradeConditions),
    checklist900to915: strArr(raw.checklist900to915 ?? raw.checklist),
    selfCritique: raw.selfCritique ? str(raw.selfCritique) : null,
    warnings,
  };
}
