import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { IntradayAnalysisRequestSchema } from '../schemas/analysis-request.schema.js';
import { BriefStore } from '../services/ai/brief-store.js';
import { pasteBrief, PROMPT_VERSION } from '../services/ai/framework-prompt.js';
import { readPlan } from '../services/ai/plan-reader.js';
import { marketContext } from '../services/ai/ai-analyst.service.js';
import { requireSession } from '../plugins/require-session.js';
import { AppError } from '../utils/errors.js';
import { buildAnalystInput } from '../services/scanner/run-scan.js';
import { logger } from '../utils/logger.js';
import { PlanHistory, planContext } from '../services/ai/plan-history.js';
import { reviewPlan, trackRecord, ReviewNotReadyError } from '../services/monitor/review.js';
import { DhanMarketDataService } from '../services/dhan/dhan-market-data.service.js';
import { DhanAuthService } from '../services/auth/dhan-auth.service.js';
import { NotAuthenticatedError } from '../utils/errors.js';

const AnalystResponseSchema = z.object({
  /** Optional: when absent (e.g. after a page reload) the reply's own briefId is used. */
  briefId: z.string().min(1).optional(),
  /** The analyst's reply. JSON object, or text with a JSON object inside it. */
  response: z.string().min(2),
});

/**
 * Chat clients mangle JSON on the way to a clipboard in predictable ways:
 * they wrap it in prose or code fences, and — the one that actually bites —
 * they typographically "correct" straight quotes into curly ones, which is
 * no longer valid JSON. Normalising here beats asking a person to repair
 * punctuation by hand.
 *
 * Curly quotes are converted everywhere, including inside string values. A
 * value that legitimately contained a typographic quote comes back with a
 * straight one — a cosmetic change to prose, and the alternative is refusing
 * the whole response.
 */
function normaliseFromChat(raw: string): string {
  return raw
    .replace(/[\u201C\u201D\u201E\u201F\u2033]/g, '"')   // curly double quotes
    .replace(/[\u2018\u2019\u201A\u201B\u2032]/g, "'")   // curly single quotes
    .replace(/\u00A0/g, ' ')                              // non-breaking space
    .replace(/[\u200B-\u200D\uFEFF]/g, '');              // zero-width junk
}

function extractJson(raw: string): any {
  const text = normaliseFromChat(raw)
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '');
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) {
      throw new AppError(400, 'NO_JSON_FOUND', 'No JSON object was found in that response. Paste the analyst\'s full reply, including the braces.');
    }
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch (err: any) {
      throw new AppError(400, 'INVALID_JSON', `The JSON in that response could not be parsed: ${err.message}`);
    }
  }
}

/**
 * The paste bridge.
 *
 * Runs the scan and hands back the framework prompt plus tonight's computed
 * facts, for pasting into whichever assistant the user already pays for. The
 * answer comes back through the second route and is merged and validated by
 * exactly the same code the API path uses — a pasted plan earns no more trust
 * than a generated one.
 */
export const analystRoutes: FastifyPluginAsync = async (fastify) => {
  /** Run the scan and produce a brief to paste. */
  fastify.post('/api/v1/analyst/brief', { preHandler: requireSession }, async (request, reply) => {
    const { capital, riskPercent, maxTrades, universe } = IntradayAnalysisRequestSchema.parse(request.body || {});

    const started = Date.now();
    const input = await buildAnalystInput(request, { capital, riskPercent, maxTrades, universe });
    const brief = BriefStore.save(input, { scanMs: Date.now() - started });
    const text = pasteBrief({ briefId: brief.id, capital, riskPercent, context: marketContext(input) });

    logger.info({ briefId: brief.id, universe: input.universe.length, chars: text.length }, 'Analyst brief issued');

    return reply.send({
      success: true,
      data: {
        briefId: brief.id,
        createdAt: brief.createdAt,
        universeCount: input.universe.length,
        nonFnoCount: input.universe.filter((u) => !u.fno).length,
        promptVersion: PROMPT_VERSION,
        pasteText: text,
      },
    });
  });

  /** Accept the analyst's reply and turn it into a validated plan. */
  fastify.post('/api/v1/analyst/response', { preHandler: requireSession }, async (request, reply) => {
    const { briefId: requested, response } = AnalystResponseSchema.parse(request.body);

    const out = extractJson(response);
    if (!out || typeof out !== 'object' || Array.isArray(out)) {
      throw new AppError(400, 'INVALID_JSON', 'The reply is not a JSON object.');
    }

    const briefId = requested ?? (typeof out.briefId === 'string' ? out.briefId : '');
    if (!briefId) {
      throw new AppError(400, 'NO_BRIEF_ID', 'The reply has no briefId, and no brief is open. Generate a brief first.');
    }

    const brief = BriefStore.get(briefId);
    if (!brief) {
      throw new AppError(
        404,
        'BRIEF_NOT_FOUND',
        'That brief is unknown or older than 18 hours. Generate a new one — a plan must be checked against the facts the analyst actually read.'
      );
    }

    // Identity only: is this the reply to this brief? Nothing here judges
    // the analysis itself.
    if (typeof out.briefId === 'string' && out.briefId !== briefId) {
      throw new AppError(
        409,
        'WRONG_BRIEF',
        `This reply was written for brief ${out.briefId}, but the current brief is ${briefId}. ` +
          'Upload the reply that matches tonight\'s brief.'
      );
    }

    const plan = readPlan(out, {
      briefId,
      promptVersion: PROMPT_VERSION,
      source: 'pasted',
      universe: brief.input.universe ?? [],
      capital: brief.input.capital,
      riskPercent: brief.input.riskPercent,
    });

    BriefStore.attachPlan(briefId, plan);
    PlanHistory.add({
      briefId, acceptedAt: plan.acceptedAt, universeSize: brief.input.universe?.length ?? 0, plan,
      context: planContext(brief, plan),
    });
    logger.info(
      { briefId, watchlist: plan.watchlist.length, setups: plan.setups.length,
        warnings: plan.setups.reduce((a, s) => a + s.warnings.length, 0) },
      'Analyst plan accepted'
    );
    return reply.send({ success: true, data: plan });
  });

  /** Briefs still inside their window, so the dashboard can resume one. */
  fastify.get('/api/v1/analyst/briefs', { preHandler: requireSession }, async (_request, reply) => {
    return reply.send({ success: true, data: BriefStore.list() });
  });

  /** The most recent accepted plan, so a page reload does not lose it. */
  fastify.get('/api/v1/analyst/latest', { preHandler: requireSession }, async (_request, reply) => {
    const rec = PlanHistory.latest();
    if (rec) return reply.send({ success: true, data: { ...rec.plan, context: rec.context ?? null, review: rec.review ?? null } });
    return reply.send({ success: true, data: BriefStore.latestWithPlan()?.plan ?? null });
  });

  /** Every past plan, newest first, as a short summary each. */
  fastify.get('/api/v1/analyst/plans', { preHandler: requireSession }, async (_request, reply) => {
    return reply.send({ success: true, data: PlanHistory.list() });
  });

  /** Replays the plan's setups against the session they were for, and saves the result. */
  fastify.post<{ Params: { briefId: string } }>('/api/v1/analyst/plans/:briefId/review', { preHandler: requireSession }, async (request, reply) => {
    const rec = PlanHistory.get(request.params.briefId);
    if (!rec) throw new AppError(404, 'PLAN_NOT_FOUND', 'No saved plan for that brief.');

    const auth = DhanAuthService.getInstance();
    const accessToken = auth.getAccessToken(request.sessionId as string);
    const clientId = auth.getClientId(request.sessionId as string);
    if (!accessToken || !clientId) throw new NotAuthenticatedError();

    try {
      const review = await reviewPlan(new DhanMarketDataService(accessToken, clientId), rec);
      PlanHistory.setReview(rec.briefId, review);
      logger.info({ briefId: rec.briefId, sessionDate: review.sessionDate, final: review.final,
        statuses: review.setups.map((s) => `${s.symbol}:${s.outcome.status}`) }, 'Plan reviewed');
      return reply.send({ success: true, data: review });
    } catch (err) {
      if (err instanceof ReviewNotReadyError) throw new AppError(409, 'SESSION_NOT_STARTED', err.message);
      throw err;
    }
  });

  /** Results across every reviewed plan. */
  fastify.get('/api/v1/track-record', { preHandler: requireSession }, async (_request, reply) => {
    const records = PlanHistory.all();
    return reply.send({
      success: true,
      data: {
        summary: trackRecord(records),
        runs: records.filter((r) => r.review).map((r) => ({
          briefId: r.briefId,
          acceptedAt: r.acceptedAt,
          sessionDate: r.review!.sessionDate,
          final: r.review!.final,
          dataThrough: r.review!.dataThrough ?? null,
          incomplete: Boolean(r.review!.incomplete),
          setups: r.review!.setups,
          summary: trackRecord([r]),
        })),
      },
    });
  });

  fastify.get<{ Params: { briefId: string } }>('/api/v1/analyst/plans/:briefId', { preHandler: requireSession }, async (request, reply) => {
    const rec = PlanHistory.get(request.params.briefId);
    if (!rec) throw new AppError(404, 'PLAN_NOT_FOUND', 'No saved plan for that brief.');
    return reply.send({ success: true, data: { ...rec.plan, context: rec.context ?? null, review: rec.review ?? null } });
  });
};
