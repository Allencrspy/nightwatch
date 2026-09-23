import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../utils/logger.js';
import type { Plan } from './plan-reader.js';

/**
 * Every accepted plan, kept so past nights can be reviewed.
 *
 * Briefs expire after 18 hours because they exist to check a reply against
 * the data it was written from. A plan, once accepted, is a record of what
 * the analyst said that night and is worth keeping — it is small, and the
 * scan behind it is not kept.
 */

export interface PlanRecord {
  briefId: string;
  acceptedAt: string;
  universeSize: number;
  plan: Plan;
}

export interface PlanSummary {
  briefId: string;
  acceptedAt: string;
  dataAsOf: string | null;
  universeSize: number;
  marketBias: string | null;
  setups: number;
  top3: string[];
}

const FILE = '.plan-history.json';
const MAX = 500;

export class PlanHistory {
  private static records: PlanRecord[] = [];
  private static loaded = false;

  private static get file(): string {
    return path.resolve(process.cwd(), process.env.PLAN_HISTORY_PATH || FILE);
  }

  private static load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (fs.existsSync(this.file)) this.records = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      logger.warn({ err }, 'Could not read plan history; starting empty');
      this.records = [];
    }
  }

  private static persist(): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify(this.records), { mode: 0o600 });
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
    }));
  }

  public static get(briefId: string): PlanRecord | null {
    this.load();
    return this.records.find((r) => r.briefId === briefId) ?? null;
  }

  public static latest(): PlanRecord | null {
    this.load();
    return this.records[0] ?? null;
  }
}
