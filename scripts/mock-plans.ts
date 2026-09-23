/**
 * Adds mock analyst runs to the plan history, built from the latest real
 * brief's exchange data, so the Compare view can be tried before there are
 * several real runs. Every mock is labelled as one in the dashboard.
 *
 *   npx tsx scripts/mock-plans.ts          add 3 mock runs
 *   npx tsx scripts/mock-plans.ts --clear  remove all mock runs
 */
import fs from 'node:fs';
import path from 'node:path';
import { readPlan } from '../src/services/ai/plan-reader.js';
import type { UniverseRow } from '../src/services/ai/universe.js';

const HISTORY = path.resolve(process.cwd(), '.plan-history.json');
const BRIEFS = path.resolve(process.cwd(), '.briefs.json');
const history: any[] = fs.existsSync(HISTORY) ? JSON.parse(fs.readFileSync(HISTORY, 'utf8')) : [];
const real = history.filter((r) => !String(r.briefId).startsWith('MOCK-'));

if (process.argv.includes('--clear')) {
  fs.writeFileSync(HISTORY, JSON.stringify(real), { mode: 0o600 });
  console.log(`Removed ${history.length - real.length} mock runs.`);
  process.exit(0);
}

const b = JSON.parse(fs.readFileSync(BRIEFS, 'utf8'));
const briefs: any[] = (Array.isArray(b) ? b : Object.values(b.briefs ?? b)).filter((x: any) => x.input?.universe?.length);
briefs.sort((x, y) => y.createdAt.localeCompare(x.createdAt));
if (!briefs.length) throw new Error('No brief with market data found — generate a brief first.');
const universe: UniverseRow[] = briefs[0].input.universe;
const capital = briefs[0].input.capital ?? 200000;
const riskPercent = briefs[0].input.riskPercent ?? 0.5;

// Seeded random, so the mock runs are the same each time.
let seed = 42;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const r2 = (n: number) => Math.round(n * 100) / 100;

const longs = universe.filter((u) => u.fno && u.changePct > 1.5 && u.rvol > 1.2).sort((a, c) => c.changePct - a.changePct).slice(0, 10);
const shorts = universe.filter((u) => u.fno && u.changePct < -1.5).sort((a, c) => a.changePct - c.changePct).slice(0, 4);

function setup(u: UniverseRow, bias: 'LONG' | 'SHORT', variant: number) {
  const dir = bias === 'LONG' ? 1 : -1;
  const trigger = variant % 2 ? (bias === 'LONG' ? u.high : u.low) : (bias === 'LONG' ? u.swingHigh20 : u.swingLow20);
  const entry = r2(Math.abs(trigger - u.close) > 1.5 * u.atr14 ? u.close + dir * 0.3 * u.atr14 : trigger);
  const stopMult = [0.6, 0.8, 1][variant % 3];
  const stop = r2(entry - dir * stopMult * u.atr14);
  const risk = Math.abs(entry - stop);
  return {
    symbol: u.symbol, bias, setup: bias === 'LONG' ? 'Breakout continuation' : 'Breakdown continuation',
    score: Math.round(70 + rnd() * 20),
    entryTrigger: entry, stopLoss: stop,
    targets: [r2(entry + dir * risk * 1.5), r2(entry + dir * risk * 2.5)],
    riskReward: '1.5:1 to T1, 2.5:1 to T2',
    why: `MOCK: ${u.changePct.toFixed(2)}% move on ${u.rvol}x volume, closePos ${u.closePos}.`,
    catalyst: 'MOCK: no real news search was done for this run.',
    invalidation: `${bias === 'LONG' ? 'Falls back below' : 'Reclaims'} ${stop} with volume.`,
    bullishScenario: 'MOCK scenario.', bearishScenario: 'MOCK scenario.',
    gapPlan: [{ condition: 'Opens near close', action: `Wait for a 5-minute close ${bias === 'LONG' ? 'above' : 'below'} ${entry}.` }],
  };
}

const runs = [0, 1, 2].map((v) => {
  const pickL = [...longs].sort(() => rnd() - 0.5).slice(0, 3 + v % 2);
  const pickS = v === 2 ? shorts.slice(0, 1) : [];
  const setups = [...pickL.map((u) => setup(u, 'LONG', v)), ...pickS.map((u) => setup(u, 'SHORT', v))]
    .sort((a, c) => c.score - a.score);
  const watch = [...setups.map((s) => s.symbol), ...longs.filter((u) => !pickL.includes(u)).slice(0, 3).map((u) => u.symbol)];
  const avoid = longs.filter((u) => !watch.includes(u.symbol)).slice(0, 2);
  return {
    briefId: `MOCK-${v + 1}`,
    dataAsOf: 'MOCK',
    marketBias: v === 2 ? 'NEUTRAL' : 'BULLISH',
    marketStrength: ['Moderately bullish', 'Bullish', 'Neutral with a bullish tilt'][v],
    marketRead: `MOCK run ${v + 1} — generated from the latest exchange data for testing the Compare view. Not a real analysis.`,
    strongestSectors: ['METAL'], weakestSectors: ['IT'],
    noHighQualitySetup: false,
    watchlist: watch.map((sym, i) => {
      const u = universe.find((x) => x.symbol === sym)!;
      const s = setups.find((x) => x.symbol === sym);
      return { rank: i + 1, symbol: sym, bias: s?.bias ?? 'LONG', setup: s?.setup ?? 'Momentum', score: s?.score ?? 65,
        keyLevel: s?.entryTrigger ?? u.high, note: `MOCK: ${u.changePct.toFixed(2)}% on ${u.rvol}x volume.` };
    }),
    setups,
    top3: setups.slice(0, 3).map((s) => s.symbol),
    stocksToAvoid: avoid.map((u) => ({ symbol: u.symbol, reason: `MOCK: extended after ${u.run4dPct}% in four sessions.` })),
    bestLong: `${setups.find((s) => s.bias === 'LONG')?.symbol} — MOCK.`,
    bestShort: pickS.length ? `${pickS[0].symbol} — MOCK.` : null,
    noTradeConditions: ['MOCK: NIFTY gaps more than 1% against the trade.'],
    checklist900to915: ['MOCK: check GIFT Nifty.'],
    selfCritique: 'MOCK run — not produced by ChatGPT.',
  };
});

const now = Date.now();
const mocks = runs.map((raw, i) => {
  const plan = readPlan(raw, { briefId: raw.briefId, promptVersion: 'mock', source: 'pasted', universe, capital, riskPercent });
  plan.acceptedAt = new Date(now - (i + 1) * 60_000).toISOString();
  plan.warnings.unshift('MOCK analysis — generated for testing the Compare view, not from ChatGPT.');
  return { briefId: raw.briefId, acceptedAt: plan.acceptedAt, universeSize: universe.length, plan };
});

const out = [...real, ...mocks].sort((a, c) => c.acceptedAt.localeCompare(a.acceptedAt));
fs.writeFileSync(HISTORY, JSON.stringify(out), { mode: 0o600 });
for (const m of mocks) console.log(m.briefId, m.plan.setups.map((s) => `${s.symbol}(${s.bias[0]})`).join(' '), '| top3', m.plan.top3.join(','));
console.log(`Added ${mocks.length} mock runs from brief ${briefs[0].id} (${universe.length} stocks).`);
