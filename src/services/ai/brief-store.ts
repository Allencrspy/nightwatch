import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../utils/logger.js';
import type { AnalystInput } from './ai-analyst.service.js';
import type { IntradayAnalysisResponse } from '../../schemas/analysis-response.schema.js';

/**
 * Holds a session's scan between issuing a brief and receiving the analyst's
 * answer back.
 *
 * The paste bridge is two round trips with a human in the middle, so the scan
 * has to survive the gap. Re-running it on paste-back is not an option: it
 * would spend another minute of Dhan calls and, worse, could return different
 * numbers from the ones the analyst actually read — the plan would then be
 * validated against facts nobody analysed.
 */

export interface StoredBrief {
  id: string;
  createdAt: string;
  /** The scan, exactly as the brief was built from it. */
  input: AnalystInput;
  /** The rule-engine baseline the analyst's answer is merged onto. */
  base: IntradayAnalysisResponse;
  candidateCount: number;
}

const TTL_MS = 18 * 60 * 60 * 1000; // an overnight window, and no longer
const FILE = '.briefs.json';

export class BriefStore {
  private static briefs = new Map<string, StoredBrief>();
  private static loaded = false;

  private static get file(): string {
    return path.resolve(process.cwd(), FILE);
  }

  public static save(input: AnalystInput, base: IntradayAnalysisResponse): StoredBrief {
    this.load();
    this.prune();

    const brief: StoredBrief = {
      id: crypto.randomBytes(9).toString('base64url'),
      createdAt: new Date().toISOString(),
      input,
      base,
      candidateCount: input.scoredCandidates.length,
    };
    this.briefs.set(brief.id, brief);
    this.persist();
    return brief;
  }

  public static get(id: string): StoredBrief | null {
    this.load();
    this.prune();
    return this.briefs.get(id) ?? null;
  }

  public static list(): Array<{ id: string; createdAt: string; candidateCount: number }> {
    this.load();
    this.prune();
    return [...this.briefs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map(({ id, createdAt, candidateCount }) => ({ id, createdAt, candidateCount }));
  }

  private static prune(): void {
    const cutoff = Date.now() - TTL_MS;
    let changed = false;
    for (const [id, b] of this.briefs) {
      if (new Date(b.createdAt).getTime() < cutoff) {
        this.briefs.delete(id);
        changed = true;
      }
    }
    if (changed) this.persist();
  }

  private static load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as StoredBrief[];
      for (const b of raw) this.briefs.set(b.id, b);
      logger.info({ count: this.briefs.size }, 'Restored analyst briefs');
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Could not read brief store; starting empty');
    }
  }

  private static persist(): void {
    try {
      fs.writeFileSync(this.file, JSON.stringify([...this.briefs.values()]), { mode: 0o600 });
    } catch (err: any) {
      logger.warn({ error: err.message }, 'Could not write brief store');
    }
  }
}
