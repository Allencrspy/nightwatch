import type { StockCandidateData } from './candidate-scanner.js';
import { FILTER_THRESHOLDS, SCANNER_THRESHOLDS } from '../../config/constants.js';

/**
 * The Night-Before NSE Intraday Stock Selection framework, executed in its
 * own order. Each stage corresponds to a numbered part of the framework and
 * carries that part's rules, including the ones that say what NOT to conclude.
 *
 *   2  priceMovement      approx +/-1.5% — identification, never selection
 *   2  volume             RVOL >= 1.5x, and what the volume accompanied
 *   3  priceStructure     swing levels, support and resistance must exist
 *   3  trend              EMA position; never an automatic buy/sell signal
 *   4  setup              must classify, against a meaningful prior level
 *   5  closingStrength    where the candle closed in its range
 *   6  relativeStrength   versus NIFTY 50 and versus its sector
 *   7  sector             confirms or conflicts
 *   8  newsCatalyst       stated when unknown, never invented
 *   9  fnoPositioning     supporting evidence only, never standalone
 *   10 liquidity          turnover and average volume
 *   13 riskReward         room to reach T1 at 2R
 *   19 extension          too extended to chase
 *
 * A stage returns PASS, DEMOTE (stays on the watchlist, loses the top tier)
 * or REJECT. The run stops at the first REJECT and records which stage fired,
 * so every excluded name carries the reason the framework asks for in Part 19.
 */

export type StageName =
  | 'priceMovement'
  | 'volume'
  | 'priceStructure'
  | 'trend'
  | 'setup'
  | 'closingStrength'
  | 'relativeStrength'
  | 'sector'
  | 'newsCatalyst'
  | 'fnoPositioning'
  | 'liquidity'
  | 'riskReward'
  | 'extension';

/** Framework order. Changing this changes the order of analysis. */
export const STAGE_ORDER: readonly StageName[] = [
  'priceMovement',
  'volume',
  'priceStructure',
  'trend',
  'setup',
  'closingStrength',
  'relativeStrength',
  'sector',
  'newsCatalyst',
  'fnoPositioning',
  'liquidity',
  'riskReward',
  'extension',
] as const;

export const STAGE_PART: Record<StageName, string> = {
  priceMovement: 'Part 2 — price movement',
  volume: 'Part 2 — volume',
  priceStructure: 'Part 3 — price structure',
  trend: 'Part 3 — trend',
  setup: 'Part 4 — setup identification',
  closingStrength: 'Part 5 — closing strength',
  relativeStrength: 'Part 6 — relative strength',
  sector: 'Part 7 — sector analysis',
  newsCatalyst: 'Part 8 — news and catalysts',
  fnoPositioning: 'Part 9 — F&O data',
  liquidity: 'Part 10 — liquidity',
  riskReward: 'Part 13 — risk/reward',
  extension: 'Part 19 — too extended',
};

export type Verdict =
  | { outcome: 'PASS'; note?: string }
  | { outcome: 'DEMOTE'; reason: string }
  | { outcome: 'REJECT'; reason: string };

export interface StageContext {
  /** The candidate's sector move today, or null when it could not be read. */
  sectorChangePercent: number | null;
  niftyChangePercent: number;
}

export interface StageResult {
  stage: StageName;
  part: string;
  outcome: 'PASS' | 'DEMOTE' | 'REJECT';
  note: string | null;
}

export interface FilterTrace {
  symbol: string;
  tier: 'HIGH' | 'WATCHLIST' | 'REJECTED';
  /** Every stage that ran, in framework order, with what it concluded. */
  stages: StageResult[];
  rejectedBy: StageName | null;
  reason: string | null;
  /** What the volume actually accompanied — Part 2 insists this is answered. */
  volumeCharacter: string | null;
}

const pass = (note?: string): Verdict => ({ outcome: 'PASS', note });
const demote = (reason: string): Verdict => ({ outcome: 'DEMOTE', reason });
const reject = (reason: string): Verdict => ({ outcome: 'REJECT', reason });
const n = (v: number, d = 2) => v.toFixed(d);
const inr = (v: number) => v.toLocaleString('en-IN');

/** Trigger and stop implied by structure, shared by several stages. */
function levels(c: StockCandidateData) {
  const long = c.candidateBias === 'LONG';
  const trigger = long
    ? Math.max(c.technical.resistanceLevel, c.quote.high)
    : Math.min(c.technical.supportLevel, c.quote.low);
  const stop = long
    ? Math.min(c.quote.low, c.technical.supportLevel)
    : Math.max(c.quote.high, c.technical.resistanceLevel);
  return { long, trigger, stop, risk: long ? trigger - stop : stop - trigger };
}

/**
 * Part 2 — price movement. Identification only.
 *
 * The framework asks for roughly +/-1.5% to decide what deserves investigation,
 * and in the same breath says not to select the biggest movers automatically.
 * So this stage opens the door and contributes nothing to the ranking; the
 * score in Part 11 never reads it.
 */
export function priceMovementStage(c: StockCandidateData): Verdict {
  const move = c.quote.changePercent;
  const magnitude = Math.abs(move);

  if (magnitude < SCANNER_THRESHOLDS.minAbsPriceChangePercent) {
    return reject(
      `Moved ${n(move)}%, inside the +/-${SCANNER_THRESHOLDS.minAbsPriceChangePercent}% band that marks a stock worth investigating.`
    );
  }
  if (c.candidateBias === 'NEUTRAL') {
    return reject(
      `Moved ${n(move)}% but closed at ${n(c.technical.closingStrength)} of the day's range, giving no directional bias.`
    );
  }
  return pass(`${move > 0 ? 'Up' : 'Down'} ${n(magnitude)}%, a ${c.candidateBias.toLowerCase()} candidate for investigation.`);
}

/**
 * Part 2 — volume. "High volume by itself is NOT bullish."
 *
 * Magnitude alone passes nothing. The stage also has to say what the volume
 * accompanied: buying, selling, a breakout, a breakdown or a reversal.
 */
export function volumeStage(c: StockCandidateData): Verdict {
  const { technical: t, quote: q } = c;

  if (t.rvol < SCANNER_THRESHOLDS.minRvol) {
    if (t.rvol < FILTER_THRESHOLDS.minRvolForConviction) {
      return reject(
        `Volume ${inr(t.todayVolume)} against a 20-day average of ${inr(t.avgVolume20)} is ${n(t.rvol)}x — the move ran on below-average participation.`
      );
    }
    return demote(
      `Relative volume ${n(t.rvol)}x is short of the ${SCANNER_THRESHOLDS.minRvol}x the framework prefers (${inr(t.todayVolume)} against ${inr(t.avgVolume20)}).`
    );
  }
  return pass(`Volume ${inr(t.todayVolume)} is ${n(t.rvol)}x the 20-day average of ${inr(t.avgVolume20)}.`);
}

/** What the volume accompanied. Part 2 requires this to be answered explicitly. */
export function describeVolumeCharacter(c: StockCandidateData): string {
  const { technical: t, quote: q } = c;
  const up = q.changePercent > 0;
  const closedStrong = t.closingStrength >= 0.7;
  const closedWeak = t.closingStrength <= 0.3;

  if (t.breakoutType === 'BREAKOUT' && up && closedStrong) {
    return `Breakout: cleared the 20-day swing high of ${n(t.swingHigh20)} and closed at ${n(t.closingStrength)} of the range.`;
  }
  if (t.breakoutType === 'BREAKDOWN' && !up && closedWeak) {
    return `Breakdown: lost the 20-day swing low of ${n(t.swingLow20)} and closed at ${n(t.closingStrength)} of the range.`;
  }
  if (up && closedWeak) {
    return `Reversal against the move: finished up ${n(q.changePercent)}% but closed at ${n(t.closingStrength)} of the range, so sellers took it back.`;
  }
  if (!up && closedStrong) {
    return `Reversal against the move: finished down ${n(q.changePercent)}% but closed at ${n(t.closingStrength)} of the range, so buyers recovered it.`;
  }
  if (up) return `Buying: closed at ${n(t.closingStrength)} of the range on ${n(t.rvol)}x volume, with no prior level cleared.`;
  return `Selling: closed at ${n(t.closingStrength)} of the range on ${n(t.rvol)}x volume, with no prior level lost.`;
}

/** Part 3 — price structure. Swing levels and a usable support/resistance pair. */
export function priceStructureStage(c: StockCandidateData): Verdict {
  const { technical: t } = c;

  if (!Number.isFinite(t.swingHigh20) || !Number.isFinite(t.swingLow20) || t.swingHigh20 <= t.swingLow20) {
    return reject('No usable 20-day swing range could be measured from the daily candles.');
  }
  if (t.resistanceLevel <= 0 || t.supportLevel <= 0) {
    return reject('No identifiable support and resistance pair on the daily chart.');
  }
  return pass(
    `20-day range ${n(t.swingLow20)} to ${n(t.swingHigh20)}; support ${n(t.supportLevel)}, resistance ${n(t.resistanceLevel)}.`
  );
}

/**
 * Part 3 — trend. "Do NOT treat moving averages as automatic buy/sell signals."
 *
 * So this stage never rejects. A trade against the EMA structure is allowed
 * through, noted, and costs the top tier.
 */
export function trendStage(c: StockCandidateData): Verdict {
  const { technical: t, quote: q, candidateBias } = c;
  const long = candidateBias === 'LONG';
  const above20 = q.lastPrice > t.ema20;
  const above50 = q.lastPrice > t.ema50;

  const position = `Price ${above20 ? 'above' : 'below'} the 20-EMA (${n(t.ema20)}) and ${above50 ? 'above' : 'below'} the 50-EMA (${n(t.ema50)}); trend reads ${t.trendAlignment.replace('_', ' ').toLowerCase()}.`;

  const withTrend = long ? above20 && above50 : !above20 && !above50;
  if (withTrend) return pass(position);

  return demote(`${position} The daily trend does not back this ${candidateBias.toLowerCase()}.`);
}

/**
 * Part 4 — setup identification. "Do not call something a breakout merely
 * because price rose. Confirm that there is a meaningful prior level."
 */
export function setupStage(c: StockCandidateData): Verdict {
  const { technical: t, quote: q, candidateBias } = c;
  const { long, trigger } = levels(c);

  if (t.breakoutType === 'NONE') {
    return reject('No breakout, breakdown, pullback or consolidation structure to trade against.');
  }

  const clearedPriorLevel = long
    ? q.lastPrice >= t.swingHigh20 || q.high >= t.swingHigh20
    : q.lastPrice <= t.swingLow20 || q.low <= t.swingLow20;
  const nearEma = Math.abs(q.lastPrice - t.ema20) / t.ema20 < 0.01;

  if (!clearedPriorLevel && !nearEma) {
    return demote(
      `Price moved but did not engage a prior level: ${long ? `20-day high ${n(t.swingHigh20)} still above` : `20-day low ${n(t.swingLow20)} still below`}. The trigger at ${n(trigger)} is a level to watch, not a completed setup.`
    );
  }

  const kind = long
    ? t.breakoutType === 'BREAKOUT' ? 'Breakout' : nearEma ? 'Pullback in an uptrend' : 'Breakout continuation'
    : t.breakoutType === 'BREAKDOWN' ? 'Breakdown' : nearEma ? 'Pullback in a downtrend' : 'Resistance rejection';

  return pass(`${kind} against ${n(trigger)}, a level that has mattered on the daily chart.`);
}

/** Part 5 — closing strength. Where the candle finished inside its own range. */
export function closingStrengthStage(c: StockCandidateData): Verdict {
  const { technical: t, quote: q, candidateBias } = c;
  const long = candidateBias === 'LONG';
  const cs = t.closingStrength;

  if (long && cs < FILTER_THRESHOLDS.minClosingStrength) {
    return reject(
      `Closed at ${n(cs)} of the day's range (${n(q.low)}–${n(q.high)}): sellers pushed it back off the highs.`
    );
  }
  if (!long && cs > 1 - FILTER_THRESHOLDS.minClosingStrength) {
    return reject(
      `Closed at ${n(cs)} of the day's range (${n(q.low)}–${n(q.high)}): buyers recovered it off the lows.`
    );
  }
  if (long && cs < FILTER_THRESHOLDS.strongCloseStrength) {
    return demote(`Closed at ${n(cs)} of the range — in the upper half, but not near the high.`);
  }
  if (!long && cs > 1 - FILTER_THRESHOLDS.strongCloseStrength) {
    return demote(`Closed at ${n(cs)} of the range — in the lower half, but not near the low.`);
  }
  return pass(`Closed at ${n(cs)} of the day's range, ${long ? 'near the high' : 'near the low'}.`);
}

/** Part 6 — relative strength against NIFTY 50 and against its own sector. */
export function relativeStrengthStage(c: StockCandidateData, ctx: StageContext): Verdict {
  const { relativeStrength: rs, candidateBias, quote: q } = c;
  const long = candidateBias === 'LONG';

  const vsNifty = rs.vsNiftyPercent;
  const beatsNifty = long ? vsNifty > 0 : vsNifty < 0;
  const summary = `Stock ${n(q.changePercent)}%, NIFTY ${n(ctx.niftyChangePercent)}%${ctx.sectorChangePercent === null ? '' : `, sector ${n(ctx.sectorChangePercent)}%`}.`;

  if (!beatsNifty) {
    return reject(
      `${summary} It did not ${long ? 'outperform' : 'underperform'} the index, so there is no relative ${long ? 'strength' : 'weakness'} to trade.`
    );
  }
  return pass(`${summary} Relative ${long ? 'strength' : 'weakness'} of ${n(Math.abs(vsNifty))} points against the index.`);
}

/** Part 7 — sector. Support or conflict, and how the stock compares to it. */
export function sectorStage(c: StockCandidateData, ctx: StageContext): Verdict {
  const { candidateBias, sectorName, relativeStrength: rs } = c;
  const sector = ctx.sectorChangePercent;

  if (sector === null) {
    return demote(`${sectorName} performance was unavailable, so the sector can neither confirm nor conflict.`);
  }

  const long = candidateBias === 'LONG';
  if (long ? sector > 0 : sector < 0) {
    return pass(`${sectorName} moved ${n(sector)}%, confirming the ${candidateBias.toLowerCase()}.`);
  }

  const outperformsSector = long ? rs.vsSectorPercent > 0 : rs.vsSectorPercent < 0;
  if (Math.abs(sector) >= FILTER_THRESHOLDS.sectorOpposingRejectPercent && !outperformsSector) {
    return reject(
      `${sectorName} moved ${n(sector)}% against the ${candidateBias.toLowerCase()} and the stock did not stand apart from it.`
    );
  }
  return demote(
    `${sectorName} moved ${n(sector)}%, conflicting with the ${candidateBias.toLowerCase()}. The stock's own momentum has to carry it.`
  );
}

/**
 * Part 8 — news. "If there is no obvious catalyst, say so. Do not invent a
 * reason."
 *
 * Absence is stated, not penalised. An unexplained move is still a tradeable
 * structure — the framework's own worked example rates a setup top-tier while
 * recording that no catalyst was verified. Only a catalyst pointing against
 * the trade costs a tier. The scoring model handles the missing factor by
 * excluding it from the denominator rather than scoring it as mediocre.
 */
export function newsCatalystStage(c: StockCandidateData): Verdict {
  const { news, candidateBias } = c;

  if (!news.available) {
    return pass('No news source configured, so today\'s move has no verified explanation. Not treated as a negative.');
  }
  if (!news.hasNews) {
    return pass('No price-sensitive announcement found to explain today\'s move.');
  }

  const against =
    (candidateBias === 'LONG' && news.sentiment === 'BEARISH') ||
    (candidateBias === 'SHORT' && news.sentiment === 'BULLISH');
  if (against) {
    return demote(`Catalyst runs against the ${candidateBias.toLowerCase()}: ${news.headline}`);
  }
  return pass(`Catalyst: ${news.headline}`);
}

/** Part 9 — F&O. "Do NOT use OI as a standalone signal." Never rejects. */
export function fnoPositioningStage(c: StockCandidateData): Verdict {
  const { fno, candidateBias } = c;
  if (!fno.available) {
    return pass('Open interest unavailable on cash quotes; F&O positioning not used as evidence.');
  }
  const agrees = candidateBias === 'LONG' ? fno.isBullish : fno.isBearish;
  return agrees
    ? pass(`Supporting evidence only: ${fno.interpretation}`)
    : demote(`F&O positioning reads ${fno.positioning.replace('_', ' ').toLowerCase()}, which does not support the ${candidateBias.toLowerCase()}.`);
}

/** Part 10 — liquidity. Execution has to be possible, not just profitable. */
export function liquidityStage(c: StockCandidateData): Verdict {
  const { turnoverCr, technical: t } = c;

  if (turnoverCr < SCANNER_THRESHOLDS.minLiquidityAmountInCr) {
    return reject(`Turnover ${n(turnoverCr)} Cr is below the ${SCANNER_THRESHOLDS.minLiquidityAmountInCr} Cr floor for comfortable intraday execution.`);
  }
  if (t.avgVolume20 < SCANNER_THRESHOLDS.minAvgDailyVolume) {
    return reject(`20-day average volume ${inr(t.avgVolume20)} is below the ${inr(SCANNER_THRESHOLDS.minAvgDailyVolume)} floor.`);
  }
  return pass(`Turnover ${n(turnoverCr)} Cr on a 20-day average volume of ${inr(t.avgVolume20)}.`);
}

/**
 * Part 13 — risk/reward, measured as room to move.
 *
 * T1 sits at 2R, so the next structural barrier has to be at least that far
 * away. This is the stage that rejects a genuinely weak stock whose support
 * sits immediately below it: real weakness, nowhere for the trade to go.
 */
export function riskRewardStage(c: StockCandidateData): Verdict {
  const { technical: t } = c;
  const { long, trigger, risk } = levels(c);

  if (!Number.isFinite(risk) || risk <= 0) {
    return reject(`Stop is not on the correct side of the trigger at ${n(trigger)}.`);
  }
  const riskPercent = (risk / trigger) * 100;
  if (riskPercent > FILTER_THRESHOLDS.maxStopDistancePercent) {
    return reject(`Structural stop is ${n(riskPercent)}% away; beyond ${FILTER_THRESHOLDS.maxStopDistancePercent}% it is not an intraday stop.`);
  }

  const required = risk * FILTER_THRESHOLDS.targetRiskMultiple;
  const barrier = long ? t.high52w : t.low52w;
  const available = long ? barrier - trigger : trigger - barrier;

  if (available <= 0) {
    return demote(`Trigger ${n(trigger)} is already at the 52-week ${long ? 'high' : 'low'} of ${n(barrier)}; no measured room remains.`);
  }
  if (available < required) {
    return reject(
      `Only ${n(available)} of room to the 52-week ${long ? 'high' : 'low'} at ${n(barrier)}, but T1 needs ${n(required)} (${FILTER_THRESHOLDS.targetRiskMultiple}R on ${n(risk)} of risk). Poor risk/reward.`
    );
  }
  if (available < required * FILTER_THRESHOLDS.comfortableRoomMultiple) {
    return demote(`Room of ${n(available)} against a ${n(required)} requirement — enough for T1, marginal past it.`);
  }
  if (t.yearWindowIncomplete) {
    return demote('Fewer than 250 sessions of history, so the 52-week barrier used here is approximate.');
  }
  return pass(`${n(available)} of room to ${n(barrier)} against ${n(required)} needed for T1.`);
}

/** Part 19 — too extended. Has the move already happened? */
export function extensionStage(c: StockCandidateData): Verdict {
  const { technical: t, quote: q, candidateBias } = c;
  const long = candidateBias === 'LONG';

  const move = Math.abs(q.changePercent);
  const atrMultiple = t.atrPercent > 0 ? move / t.atrPercent : 0;
  const run = long ? t.return4Session : -t.return4Session;
  const fromEma = long ? t.distanceFromEma20Percent : -t.distanceFromEma20Percent;

  const severe: string[] = [];
  const moderate: string[] = [];

  if (atrMultiple >= FILTER_THRESHOLDS.extensionSevereAtrMultiple) {
    severe.push(`today's ${n(move)}% move is ${n(atrMultiple, 1)}x ATR(14) of ${n(t.atrPercent)}%`);
  } else if (atrMultiple >= FILTER_THRESHOLDS.extensionModerateAtrMultiple) {
    moderate.push(`today's ${n(move)}% move is ${n(atrMultiple, 1)}x ATR(14)`);
  }

  if (run >= FILTER_THRESHOLDS.extensionSevereRunPercent) severe.push(`${n(run)}% across the last four sessions`);
  else if (run >= FILTER_THRESHOLDS.extensionModerateRunPercent) moderate.push(`${n(run)}% across the last four sessions`);

  if (fromEma >= FILTER_THRESHOLDS.extensionSevereEmaPercent) severe.push(`${n(fromEma)}% from the 20-EMA`);
  else if (fromEma >= FILTER_THRESHOLDS.extensionModerateEmaPercent) moderate.push(`${n(fromEma)}% from the 20-EMA`);

  if (severe.length) return reject(`Too extended to chase: ${severe.join('; ')}.`);
  if (moderate.length) return demote(`Extended: ${moderate.join('; ')}. Watch rather than chase.`);
  return pass(`Not extended: ${n(move)}% against ATR(14) of ${n(t.atrPercent)}%, ${n(t.return4Session)}% over four sessions.`);
}

const STAGES: Record<StageName, (c: StockCandidateData, ctx: StageContext) => Verdict> = {
  priceMovement: (c) => priceMovementStage(c),
  volume: (c) => volumeStage(c),
  priceStructure: (c) => priceStructureStage(c),
  trend: (c) => trendStage(c),
  setup: (c) => setupStage(c),
  closingStrength: (c) => closingStrengthStage(c),
  relativeStrength: (c, ctx) => relativeStrengthStage(c, ctx),
  sector: (c, ctx) => sectorStage(c, ctx),
  newsCatalyst: (c) => newsCatalystStage(c),
  fnoPositioning: (c) => fnoPositioningStage(c),
  liquidity: (c) => liquidityStage(c),
  riskReward: (c) => riskRewardStage(c),
  extension: (c) => extensionStage(c),
};

/** Runs every stage in framework order, stopping at the first rejection. */
export function runFramework(candidate: StockCandidateData, ctx: StageContext): FilterTrace {
  const trace: FilterTrace = {
    symbol: candidate.quote.symbol,
    tier: 'HIGH',
    stages: [],
    rejectedBy: null,
    reason: null,
    volumeCharacter: null,
  };

  for (const stage of STAGE_ORDER) {
    const verdict = STAGES[stage](candidate, ctx);
    trace.stages.push({
      stage,
      part: STAGE_PART[stage],
      outcome: verdict.outcome,
      note: verdict.outcome === 'PASS' ? verdict.note ?? null : verdict.reason,
    });

    // Part 2 owes an explicit answer on what the volume accompanied.
    if (stage === 'volume' && verdict.outcome !== 'REJECT') {
      trace.volumeCharacter = describeVolumeCharacter(candidate);
    }

    if (verdict.outcome === 'REJECT') {
      trace.tier = 'REJECTED';
      trace.rejectedBy = stage;
      trace.reason = verdict.reason;
      return trace;
    }
    if (verdict.outcome === 'DEMOTE') trace.tier = 'WATCHLIST';
  }

  return trace;
}
