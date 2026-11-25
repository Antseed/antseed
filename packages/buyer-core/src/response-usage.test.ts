import { describe, expect, it } from 'vitest';
import { computeCostUsdc } from './pricing.js';
import { parseResponseUsage } from './response-usage.js';

const encoder = new TextEncoder();
const stream = (...events: unknown[]): Uint8Array => encoder.encode(`${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('')}data: [DONE]\n\n`);
const chunk = (usage: Record<string, unknown> | null, content = '') => ({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content } }], usage });
/** $1 per million fresh input, $0.10 cached, $2 output: N tokens price to N base units at $1. */
const PRICE = { inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.1, outputUsdPerMillion: 2 };
const price = (usage: { freshInputTokens: number; outputTokens: number; cachedInputTokens: number }) => computeCostUsdc(usage.freshInputTokens, usage.outputTokens, PRICE, usage.cachedInputTokens);

describe('parseResponseUsage on a stream that reports usage more than once', () => {
  it('bills the final usage, not an early estimate mixed with it', () => {
    // An early chunk carries the upstream's estimate (no cache hits counted); the last carries the real usage.
    const body = stream(
      chunk({ prompt_tokens: 2_000, completion_tokens: 1, total_tokens: 2_001, estimated: true }, 'Blue'),
      chunk({ prompt_tokens: 4_000, completion_tokens: 6, total_tokens: 4_006, prompt_tokens_details: { cached_tokens: 3_000 } }, '.'),
    );
    const usage = parseResponseUsage(body);
    const reported = { inputTokens: 4_000, freshInputTokens: 1_000, cachedInputTokens: 3_000, outputTokens: 6 };
    expect(
      usage,
      `fresh ${usage.freshInputTokens} + cached ${usage.cachedInputTokens} for a ${reported.inputTokens}-token prompt: ` +
      `charged ${price(usage)} base units for usage that prices to ${price(reported)}`,
    ).toEqual(reported);
  });

  it('keeps the input and its cache hits from one report', () => {
    // Without any estimate flag: a report of fewer total tokens never lends its fresh count to a larger one.
    const body = stream(
      chunk({ prompt_tokens: 3_500, completion_tokens: 2, total_tokens: 3_502, prompt_tokens_details: { cached_tokens: 0 } }),
      chunk({ prompt_tokens: 4_000, completion_tokens: 6, total_tokens: 4_006, prompt_tokens_details: { cached_tokens: 3_000 } }),
    );
    const usage = parseResponseUsage(body);
    expect(usage.freshInputTokens + usage.cachedInputTokens, `fresh ${usage.freshInputTokens} + cached ${usage.cachedInputTokens}`).toBe(usage.inputTokens);
    expect(usage).toEqual({ inputTokens: 4_000, freshInputTokens: 1_000, cachedInputTokens: 3_000, outputTokens: 6 });
  });

  it('keeps the cache hits of an Anthropic message_start when the message_delta repeats only the fresh input', () => {
    const body = encoder.encode([
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { usage: { input_tokens: 20, cache_read_input_tokens: 15_000, output_tokens: 1 } } })}\n\n`,
      `event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', usage: { input_tokens: 20, output_tokens: 250 } })}\n\n`,
    ].join(''));
    expect(parseResponseUsage(body)).toEqual({ inputTokens: 15_020, freshInputTokens: 20, cachedInputTokens: 15_000, outputTokens: 250 });
  });

  it('reads the estimate mark where the usage is, in a Responses event', () => {
    const body = encoder.encode([
      `event: response.in_progress\ndata: ${JSON.stringify({ type: 'response.in_progress', response: { usage: { input_tokens: 120, output_tokens: 9, estimated: true } } })}\n\n`,
      `event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { usage: { input_tokens: 100, output_tokens: 5 } } })}\n\n`,
    ].join(''));
    expect(parseResponseUsage(body)).toEqual({ inputTokens: 100, freshInputTokens: 100, cachedInputTokens: 0, outputTokens: 5 });
  });

  it('bills an estimate marked as one when the stream reports nothing else', () => {
    const body = stream(chunk({ prompt_tokens: 2_000, completion_tokens: 9, total_tokens: 2_009, estimated: true }, 'Blue.'));
    expect(parseResponseUsage(body)).toEqual({ inputTokens: 2_000, freshInputTokens: 2_000, cachedInputTokens: 0, outputTokens: 9 });
  });
});
