import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import { env } from '../../config/env.js';
import { logger } from '../../utils/logger.js';
import { NotConfiguredError, UpstreamError } from '../../utils/errors.js';

/**
 * One interface, two providers, so the analyst can be swapped without
 * touching the fact sheet, the prompt, the merge logic or the validation.
 *
 * Both return the parsed JSON object the framework prompt asks for. Neither
 * is asked to calculate anything: the caller recomputes risk-reward and
 * position size from the levels it returns.
 */
export interface AnalystResult {
  json: any;
  /** Provider-reported usage, for the log view and cost tracking. */
  usage: { inputTokens: number | null; outputTokens: number | null };
  /** Sources the analyst consulted, when it had web search. */
  citations: Array<{ title: string; url: string }>;
  model: string;
}

export type ProviderName = 'anthropic' | 'openai';

export function activeProvider(): ProviderName | null {
  if (env.LLM_PROVIDER === 'anthropic') return env.ANTHROPIC_API_KEY ? 'anthropic' : null;
  if (env.LLM_PROVIDER === 'openai') return env.OPENAI_API_KEY ? 'openai' : null;
  // 'auto': whichever is configured, Anthropic first.
  if (env.ANTHROPIC_API_KEY) return 'anthropic';
  if (env.OPENAI_API_KEY) return 'openai';
  return null;
}

function extractJson(text: string): any {
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // A model with a web-search tool often narrates before the JSON.
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start === -1 || end <= start) throw new Error('response contained no JSON object');
    return JSON.parse(trimmed.slice(start, end + 1));
  }
}

/**
 * Claude, with web search so the analyst can research catalysts.
 *
 * The manual runs of this framework were done in a chat product with
 * browsing, which is how Part 8 ever got answered — the reference scan cites
 * Business Standard, Moneycontrol and ET Now, and marks one catalyst
 * "verified". Without search, Part 8 is permanently UNKNOWN and the catalyst
 * factor drops out of every score. Search restores that, scoped to the
 * handful of names that cleared the Part 2 screen.
 */
async function runAnthropic(system: string, userPayload: string, allowSearch: boolean): Promise<AnalystResult> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY as string });
  const model = env.ANTHROPIC_MODEL;

  const tools = allowSearch
    ? [{
        type: 'web_search_20260209' as const,
        name: 'web_search' as const,
        max_uses: env.ANALYST_MAX_SEARCHES,
      }]
    : undefined;

  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: userPayload }];

  // Server tools can pause the turn; resume by replaying the assistant content.
  for (let turn = 0; turn < 4; turn++) {
    const response = await client.messages.create({
      model,
      max_tokens: 16000,
      system,
      // The framework is exactly the kind of multi-step judgement adaptive
      // thinking exists for: thirteen stages, conflicting signals, and a
      // standing instruction to decline rather than force a trade.
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high' },
      ...(tools ? { tools } : {}),
      messages,
    });

    if (response.stop_reason === 'refusal') {
      throw new UpstreamError('Claude', `declined the request (${response.stop_details?.category ?? 'unspecified'})`);
    }

    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('\n');

    if (!text.trim()) throw new Error('response contained no text');

    const citations: Array<{ title: string; url: string }> = [];
    for (const block of response.content as any[]) {
      if (block.type === 'web_search_tool_result' && Array.isArray(block.content)) {
        for (const r of block.content) {
          if (r?.url) citations.push({ title: String(r.title ?? r.url), url: String(r.url) });
        }
      }
    }

    return {
      json: extractJson(text),
      usage: {
        inputTokens: response.usage?.input_tokens ?? null,
        outputTokens: response.usage?.output_tokens ?? null,
      },
      citations,
      model,
    };
  }

  throw new Error('analyst did not finish within the allowed tool turns');
}

/** OpenAI, kept because the framework's month of real use came from ChatGPT. */
async function runOpenAI(system: string, userPayload: string): Promise<AnalystResult> {
  const client = new OpenAI({ apiKey: env.OPENAI_API_KEY as string });
  const model = env.OPENAI_MODEL;

  const response = await client.chat.completions.create({
    model,
    response_format: { type: 'json_object' },
    temperature: 0.2,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: userPayload },
    ],
  });

  const text = response.choices[0]?.message?.content;
  if (!text) throw new Error('empty response');

  return {
    json: extractJson(text),
    usage: {
      inputTokens: response.usage?.prompt_tokens ?? null,
      outputTokens: response.usage?.completion_tokens ?? null,
    },
    citations: [],
    model,
  };
}

export async function runAnalyst(system: string, userPayload: string): Promise<AnalystResult> {
  const provider = activeProvider();
  if (!provider) {
    throw new NotConfiguredError('An analyst model (ANTHROPIC_API_KEY or OPENAI_API_KEY)');
  }

  logger.info({ provider }, 'Calling analyst');

  try {
    return provider === 'anthropic'
      ? await runAnthropic(system, userPayload, env.ANALYST_WEB_SEARCH)
      : await runOpenAI(system, userPayload);
  } catch (err: any) {
    if (err instanceof UpstreamError || err instanceof NotConfiguredError) throw err;

    // Typed SDK errors carry far more than a message string.
    if (err instanceof Anthropic.RateLimitError) {
      throw new UpstreamError('Claude', 'rate limited. Retry shortly.', err.message);
    }
    if (err instanceof Anthropic.AuthenticationError) {
      throw new UpstreamError('Claude', 'rejected the API key. Check ANTHROPIC_API_KEY.', err.message);
    }
    if (err instanceof Anthropic.APIError) {
      throw new UpstreamError('Claude', `API error ${err.status}: ${err.message}`);
    }
    throw err;
  }
}
