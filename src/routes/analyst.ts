import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { IntradayAnalysisRequestSchema } from '../schemas/analysis-request.schema.js';
import { IntradayAnalysisResponseSchema } from '../schemas/analysis-response.schema.js';
import { AiAnalystService } from '../services/ai/ai-analyst.service.js';
import { BriefStore } from '../services/ai/brief-store.js';
import { requireSession } from '../plugins/require-session.js';
import { AppError } from '../utils/errors.js';
import { buildAnalystInput } from '../services/scanner/run-scan.js';
import { logger } from '../utils/logger.js';

/**
 * Delivery instructions for the paste bridge only.
 *
 * Kept out of the shared framework prompt on purpose: over the API there is
 * no file to download and no clipboard to mangle, so this would be noise
 * there. Here it earns its place — a file avoids the typographic quotes chat
 * clients substitute into JSON, which is the single most common way a reply
 * arrives unparseable.
 */
function deliveryInstructions(briefId: string): string {
  return `## HOW TO DELIVER YOUR ANSWER

This is brief \`${briefId}\`. Make \`"briefId": "${briefId}"\` the first field of your JSON, so the reply can be matched to the facts you analysed.

Save the JSON object as a downloadable file named \`nightwatch-reply-${briefId}.json\`, containing the JSON and nothing else — no commentary before or after, no code fences. I will upload that file directly.

If you cannot produce a file, print the raw JSON instead, and use only straight quotes (") — not typographic quotes (" ") — or it will not parse.

Analyse only the candidates in the fact sheet below. If this conversation contains an earlier brief, ignore it entirely: tonight's candidates are different.`;
}

const AnalystResponseSchema = z.object({
  briefId: z.string().min(1),
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
  const analyst = new AiAnalystService();

  /** Run the scan and produce a brief to paste. */
  fastify.post('/api/v1/analyst/brief', { preHandler: requireSession }, async (request, reply) => {
    const { capital, riskPercent, maxTrades } = IntradayAnalysisRequestSchema.parse(request.body || {});

    const input = await buildAnalystInput(request, { capital, riskPercent, maxTrades });
    const base = analyst.synthesizeRuleBased(input);
    const { prompt, factSheet } = analyst.buildBrief(input);
    const brief = BriefStore.save(input, base);

    logger.info({ briefId: brief.id, candidates: brief.candidateCount }, 'Analyst brief issued');

    return reply.send({
      success: true,
      data: {
        briefId: brief.id,
        createdAt: brief.createdAt,
        candidateCount: brief.candidateCount,
        screenedOutCount: factSheet.screenedOut.length,
        prompt,
        factSheet,
        // Ready to paste in one go.
        pasteText: [
          prompt,
          '---',
          deliveryInstructions(brief.id),
          '---',
          'FACT SHEET (use only these numbers):',
          JSON.stringify(factSheet, null, 2),
        ].join('\n\n'),
      },
    });
  });

  /** Accept the analyst's reply and turn it into a validated plan. */
  fastify.post('/api/v1/analyst/response', { preHandler: requireSession }, async (request, reply) => {
    const { briefId, response } = AnalystResponseSchema.parse(request.body);

    const brief = BriefStore.get(briefId);
    if (!brief) {
      throw new AppError(
        404,
        'BRIEF_NOT_FOUND',
        'That brief is unknown or older than 18 hours. Generate a new one — a plan must be checked against the facts the analyst actually read.'
      );
    }

    const out = extractJson(response);
    const briefSymbols = brief.input.scoredCandidates.map((sc) => sc.candidate.quote.symbol);
    const replySymbols: string[] = (Array.isArray(out.setups) ? out.setups : [])
      .map((x: any) => String(x?.symbol ?? ''))
      .filter(Boolean);

    // A reply that names its brief can be checked directly.
    if (typeof out.briefId === 'string' && out.briefId !== briefId) {
      throw new AppError(
        409,
        'WRONG_BRIEF',
        `This reply was written for brief ${out.briefId}, but the current brief is ${briefId}. ` +
          'Upload the reply that matches tonight\'s brief.'
      );
    }

    // One that does not can still be recognised as stale: if it proposes
    // setups and not one of them is among tonight's candidates, it is almost
    // certainly an earlier night's reply. Accepting it would record an empty
    // plan and leave the monitor watching nothing, with no sign anything went
    // wrong.
    if (replySymbols.length && !replySymbols.some((sym) => briefSymbols.includes(sym))) {
      throw new AppError(
        409,
        'STALE_REPLY',
        `This reply analyses ${replySymbols.join(', ')} — none of which are in tonight's brief ` +
          `(${briefSymbols.slice(0, 6).join(', ')}${briefSymbols.length > 6 ? `, +${briefSymbols.length - 6} more` : ''}). ` +
          'It looks like a reply to an earlier brief. Paste tonight\'s brief into a new chat and upload that reply.'
      );
    }

    const plan = analyst.mergeAnalystOutput(out, brief.input, brief.base, {
      model: typeof out.model === 'string' ? out.model : 'pasted',
      sources: Array.isArray(out.sources) ? out.sources.filter((s: any) => s?.url) : [],
    });

    const parsed = IntradayAnalysisResponseSchema.safeParse(plan);
    if (!parsed.success) {
      logger.warn({ briefId, issues: parsed.error.issues.length }, 'Pasted plan failed validation');
      throw new AppError(
        422,
        'INVALID_PLAN',
        'The pasted analysis failed validation and was withheld.',
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`)
      );
    }

    BriefStore.attachPlan(briefId, parsed.data);
    logger.info({ briefId, setups: parsed.data.setups.length }, 'Pasted plan accepted');
    return reply.send({ success: true, data: parsed.data });
  });

  /** Briefs still inside their window, so the dashboard can resume one. */
  fastify.get('/api/v1/analyst/briefs', { preHandler: requireSession }, async (_request, reply) => {
    return reply.send({ success: true, data: BriefStore.list() });
  });
};
