import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../utils/logger.js';
import type { Plan } from './plan-reader.js';
import type { UniverseRow } from './universe.js';
import type { Outcome } from '../monitor/outcome.js';
import type { StoredBrief } from './brief-store.js';

/**
 * Every accepted plan, kept so past nights can be reviewed.
 *
 * Briefs expire after 18 hours because they exist to check a reply against
 * the data it was written from. A plan, once accepted, is a record of what
 * the analyst said that night and is worth keeping — it is small, and the
 * scan behind it is not kept.
 */

interface IndexSnapshot { lastPrice: number; changePercent: number; open: number; high: number; low: number }

/** The market the plan was written against, kept after the brief expires. */
export interface PlanContext {
  /** Session the data describes (YYYY-MM-DD, IST). The plan is for the next one. */
  dataDate: string;
  briefCreatedAt: string;
  scanMs: number | null;
  nifty: IndexSnapshot;
  bankNifty: IndexSnapshot;
  sectors: Array<{ sector: string; changePercent: number }>;
  /** For the live monitor's sector moves. */
  previousCloses: Record<string, number>;
  universeSize: number;
  nonFnoCount: number;
  skipped: Array<{ symbol: string; reason: string }>;
  /** Rows for every stock the plan names, plus the day's biggest movers. */
  rows: UniverseRow[];
  gainers: string[];
  losers: string[];
  capital: number;
  riskPercent: number;
}

export interface SetupReview {
  symbol: string;
  bias: 'LONG' | 'SHORT';
  top3Rank: number | null;
  entryTrigger: number;
  stopLoss: number;
  targets: number[];
  outcome: Outcome;
}

/** How the plan's setups actually played out in the session it was for. */
export interface PlanReview {
  sessionDate: string;
  reviewedAt: string;
  /** False while the session is still running; the review is then provisional. */
  final: boolean;
  setups: SetupReview[];
}

export interface PlanRecord {
  briefId: string;
  acceptedAt: string;
  universeSize: number;
  plan: Plan;
  context?: PlanContext;
  review?: PlanReview;
}

/** Captures what the plan was written against, from its brief. */
export function planContext(brief: StoredBrief, plan: Plan): PlanContext {
  const input = brief.input;
  const universe = input.universe ?? [];
  const named = new Set([
    ...plan.setups.map((s) => s.symbol),
    ...plan.watchlist.map((w) => w.symbol),
    ...plan.stocksToAvoid.map((a) => a.symbol),
  ]);
  const sorted = [...universe].sort((a, b) => b.changePct - a.changePct);
  const gainers = sorted.slice(0, 10).map((u) => u.symbol);
  const losers = sorted.slice(-10).reverse().map((u) => u.symbol);
  const keep = new Set([...named, ...gainers, ...losers]);
  const idx = (q: any): IndexSnapshot => ({
    lastPrice: q?.lastPrice ?? 0, changePercent: q?.changePercent ?? 0, open: q?.open ?? 0, high: q?.high ?? 0, low: q?.low ?? 0,
  });
  return {
    dataDate: new Date(new Date(brief.createdAt).getTime() + 5.5 * 3600 * 1000).toISOString().slice(0, 10),
    briefCreatedAt: brief.createdAt,
    scanMs: brief.scanMs ?? null,
    nifty: idx(input.niftyQuote),
    bankNifty: idx(input.bankNiftyQuote),
    sectors: input.sectorPerformances ?? [],
    previousCloses: input.previousCloses ?? {},
    universeSize: universe.length,
    nonFnoCount: universe.filter((u) => !u.fno).length,
    skipped: input.skipped ?? [],
    rows: universe.filter((u) => keep.has(u.symbol)),
    gainers,
    losers,
    capital: input.capital,
    riskPercent: input.riskPercent,
  };
}

export interface PlanSummary {
  briefId: string;
  acceptedAt: string;
  dataAsOf: string | null;
  universeSize: number;
  marketBias: string | null;
  setups: number;
  top3: string[];
  reviewed: boolean;
  totalR: number | null;
}

const FILE = '.plan-history.json';
const MAX = 500;

export class PlanHistory {
  private static records: PlanRecord[] = [];
  private static loaded = false;
  private static mtime = 0;

  private static get file(): string {
    return path.resolve(process.cwd(), process.env.PLAN_HISTORY_PATH || FILE);
  }

  /** Re-reads the file when something else (e.g. scripts/mock-plans.ts) changed it. */
  private static load(): void {
    const mtime = fs.existsSync(this.file) ? fs.statSync(this.file).mtimeMs : 0;
    if (this.loaded && mtime === this.mtime) return;
    this.loaded = true;
    this.mtime = mtime;
    try {
      this.records = mtime ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : [];
    } catch (err) {
      logger.warn({ err }, 'Could not read plan history; starting empty');
      this.records = [];
    }
  }

  private static persist(): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.records), { mode: 0o600 });
      this.mtime = fs.statSync(this.file).mtimeMs;
    } catch (err) {
      logger.warn({ err }, 'Could not write plan history');
    }
  }

  /** Records a plan; a re-upload for the same brief replaces the earlier one. */
  public static add(record: PlanRecord): void {
    this.load();
    this.records = this.records.filter((r) => r.briefId !== record.briefId);
    this.records.push(record);
    this.records.sort((a, b) => b.acceptedAt.localeCompare(a.acceptedAt));
    this.records = this.records.slice(0, MAX);
    this.persist();
  }

  public static list(): PlanSummary[] {
    this.load();
    return this.records.map((r) => ({
      briefId: r.briefId,
      acceptedAt: r.acceptedAt,
      dataAsOf: r.plan.dataAsOf,
      universeSize: r.universeSize,
      marketBias: r.plan.market.bias,
      setups: r.plan.setups.length,
      top3: r.plan.top3,
      reviewed: Boolean(r.review?.final),
      totalR: r.review
        ? Number(r.review.setups.reduce((a, x) => a + (x.outcome.rMultiple ?? 0), 0).toFixed(2))
        : null,
    }));
  }

  public static get(briefId: string): PlanRecord | null {
    this.load();
    return this.records.find((r) => r.briefId === briefId) ?? null;
  }

  public static setReview(briefId: string, review: PlanReview): PlanRecord | null {
    this.load();
    const rec = this.records.find((r) => r.briefId === briefId);
    if (!rec) return null;
    rec.review = review;
    this.persist();
    return rec;
  }

  public static all(): PlanRecord[] {
    this.load();
    return this.records;
  }

  public static latest(): PlanRecord | null {
    this.load();
    return this.records[0] ?? null;
  }
}
