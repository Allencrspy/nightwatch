import fs from 'node:fs';
import path from 'node:path';
import { universeTable, type UniverseRow } from './universe.js';
import { outputContract } from './output-contract.js';

/**
 * The Night-Before NSE Intraday Stock Selection prompt, used verbatim.
 *
 * It lives in prompts/night-before.md exactly as it was run by hand for a
 * month with good results, and it is not paraphrased here. An earlier version
 * of this file rewrote it, and in doing so added rules the original never had
 * — a hard 1.5:1 risk-reward floor, stops restricted to a fixed menu of
 * levels, full trade plans required for every watchlist name — which changed
 * what the analyst produced. The method is the user's; this code supplies
 * data and reads the answer back, and adds no filters of its own.
 *
 * Two things are added around the prompt, neither of which alters the method:
 *   - exchange data for the F&O universe, so prices and volumes are exact
 *     rather than scraped. Web search stays on for news, catalysts and F&O.
 *   - a request to save a summary file at the end, so the app can read it.
 */
export const PROMPT_VERSION = 'night-before-v7';

function promptPath(): string {
  const candidates = [
    path.resolve(__dirname, '../../../prompts/night-before.md'),
    path.resolve(process.cwd(), 'prompts/night-before.md'),
  ];
  const found = candidates.find((p) => fs.existsSync(p));
  if (!found) throw new Error('prompts/night-before.md not found');
  return found;
}

const RAW_PROMPT = fs.readFileSync(promptPath(), 'utf8');

/** The user's prompt, with capital and risk filled into Part 18. */
export function userPrompt(opts: { capital: number; riskPercent: number }): string {
  return RAW_PROMPT
    .replace('{{CAPITAL}}', opts.capital.toLocaleString('en-IN'))
    .replace('{{RISK_PERCENT}}', String(opts.riskPercent));
}

export interface MarketContext {
  asOf: string;
  nifty: { lastPrice: number; changePercent: number; open: number; high: number; low: number };
  bankNifty: { lastPrice: number; changePercent: number; open: number; high: number; low: number };
  sectors: Array<{ sector: string; changePercent: number }>;
  universe: UniverseRow[];
}

const sign = (n: number) => `${n > 0 ? '+' : ''}${n.toFixed(2)}%`;

/** The exchange data, and how to use it alongside the prompt's own sources. */
export function dataSection(ctx: MarketContext): string {
  const f = (n: number) => n.toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const sectors = ctx.sectors
    .map((s) => `${s.sector.replace(/^NIFTY /, '')} ${sign(s.changePercent)}`)
    .join(' · ');

  return `## MARKET DATA — NSE exchange feed via Dhan, session of ${ctx.asOf}

These figures come straight from the exchange feed and are exact. Use them for prices, volumes and technical levels in preference to figures on news or broker sites, which often round or lag.

This table is not your only source. Before you decide anything, search the web for everything the table does not contain — Part 8 news and catalysts for every stock you shortlist, corporate announcements, open interest and other F&O data, GIFT Nifty and global cues — and name the source in each catalyst. "No catalyst in the supplied data" is not an acceptable answer; say what you searched and what you found.

Use only the rules in the prompt above. Ignore any rules you may remember from earlier Nightwatch briefs or conversations: there is no fixed minimum risk-reward, stops and targets do not have to be levels from this table, and there is no "fact sheet" — choose levels as the prompt tells you to.

NIFTY 50    close ${f(ctx.nifty.lastPrice)} (${sign(ctx.nifty.changePercent)})  open ${f(ctx.nifty.open)}  high ${f(ctx.nifty.high)}  low ${f(ctx.nifty.low)}
BANK NIFTY  close ${f(ctx.bankNifty.lastPrice)} (${sign(ctx.bankNifty.changePercent)})  open ${f(ctx.bankNifty.open)}  high ${f(ctx.bankNifty.high)}  low ${f(ctx.bankNifty.low)}
Sectors (average of constituents): ${sectors}

${ctx.universe.some((u) => !u.fno)
  ? `Stock universe — ${ctx.universe.length} stocks: the F&O list plus the ${ctx.universe.filter((u) => !u.fno).length} most liquid non-F&O NSE stocks by today's turnover, included at my request. The fno column marks which is which (Y = F&O, N = non-F&O); treat non-F&O names as eligible, and mention it where liquidity or shorting constraints matter.`
  : `F&O universe — ${ctx.universe.length} stocks.`} Sorted by today's move. closePos is where the close sat in the day's range (0 = at the low, 1 = at the high). rvol is today's volume over the 20-day average. atr14 is the 14-day average true range in rupees. run4d% is the return over the last four sessions. vsNifty% is the stock's move minus NIFTY's.

${universeTable(ctx.universe)}`;
}

interface BriefOptions {
  briefId: string;
  capital: number;
  riskPercent: number;
  context: MarketContext;
}

/** The full brief for pasting into a chat assistant. */
export function pasteBrief(opts: BriefOptions): string {
  return [userPrompt(opts), '⸻', dataSection(opts.context), '⸻', outputContract(opts.briefId, 'file')].join('\n\n');
}

/** The same brief for the API path, where the reply must be the JSON alone. */
export function apiBrief(opts: BriefOptions): { system: string; user: string } {
  return {
    system: userPrompt(opts),
    user: [dataSection(opts.context), outputContract(opts.briefId, 'json-only')].join('\n\n'),
  };
}
