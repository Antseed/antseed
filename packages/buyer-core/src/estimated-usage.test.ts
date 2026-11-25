import { describe, expect, it } from 'vitest';
import { estimatePromptTokensForChecks, usageForBilling } from './estimated-usage.js';
import { estimateTokensFromBytes, estimateTokensFromBytesSampled } from './pricing.js';

const encoder = new TextEncoder();
const IMAGE_DATA = 'A'.repeat(500_000);

/** A request parsed and the bytes it was parsed from, as a seller holds them. */
const request = (written: Record<string, unknown>) => {
  const body = encoder.encode(JSON.stringify(written));
  return { value: JSON.parse(new TextDecoder().decode(body)) as Record<string, unknown>, body };
};
const estimate = ({ value, body }: { value: Record<string, unknown>; body: Uint8Array }) => estimatePromptTokensForChecks(value, body);

describe('estimatePromptTokensForChecks', () => {
  it('estimates a request without images from its bytes, as before', () => {
    const plain = request({ model: 'm', messages: [{ role: 'user', content: 'seed '.repeat(50_000) }] });
    expect(estimate(plain)).toBe(estimateTokensFromBytesSampled(plain.body));
  });

  it('counts each image as the flat allowance in place of its data, wherever it sits', () => {
    const image = { type: 'image_url', image_url: { url: `data:image/png;base64,${IMAGE_DATA}` } };
    const withImages = request({ model: 'm', messages: [
      { role: 'user', content: [{ type: 'text', text: 'Compare these.' }, image] },
      { role: 'tool', tool_call_id: 't', content: [{ type: 'text', text: 'Screenshot:' }, image] },
    ] });
    const withoutData = request({ model: 'm', messages: [
      { role: 'user', content: [{ type: 'text', text: 'Compare these.' }, { type: 'image_url' }] },
      { role: 'tool', tool_call_id: 't', content: [{ type: 'text', text: 'Screenshot:' }, { type: 'image_url' }] },
    ] });
    expect(estimate(withImages)).toBe(estimateTokensFromBytesSampled(withoutData.body) + 2 * 1_290);
  });

  it('counts an image-shaped object outside a content part as text', () => {
    const toolInput = request({ model: 'm', messages: [
      { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'f', input: { type: 'image', source: { type: 'base64', data: IMAGE_DATA } } }] },
    ] });
    expect(estimate(toolInput)).toBe(estimateTokensFromBytesSampled(toolInput.body));
  });

  it('counts a part typed as an image without image fields as text', () => {
    const malformed = request({ model: 'm', messages: [{ role: 'user', content: [{ type: 'image_url', text: IMAGE_DATA }] }] });
    expect(estimate(malformed)).toBe(estimateTokensFromBytesSampled(malformed.body));
  });

  it('counts a document by its bytes', () => {
    const document = request({ model: 'm', messages: [{ role: 'user', content: [
      { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: IMAGE_DATA } },
    ] }] });
    expect(estimate(document)).toBe(estimateTokensFromBytesSampled(document.body));
  });

  it('reads a request too wide to spread into one call', () => {
    const wide = request({ model: 'm', input: Array.from({ length: 200_000 }, () => 1) });
    expect(estimate(wide)).toBe(estimateTokensFromBytesSampled(wide.body));
  });
});

describe('usageForBilling of an answer with no usage figure and encrypted reasoning', () => {
  /** A made-up encrypted reasoning item: base64-like text the model never wrote as such. */
  const sealed = (() => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    let seed = 7;
    return Array.from({ length: 2_400 }, () => alphabet[(seed = (seed * 1_103_515_245 + 12_345) % 2_147_483_648) % 64]).join('');
  })();
  const visible = 'The sky is blue.';
  const zeroUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const requestBody = encoder.encode(JSON.stringify({ model: 'test-model', messages: [{ role: 'user', content: 'What colour is the sky?' }] }));
  const visibleTokens = estimateTokensFromBytes(encoder.encode(visible));
  const message = {
    role: 'assistant',
    content: visible,
    reasoning_content: `__ENCRYPTED_REASONING__${sealed}`,
    reasoning_encrypted: true,
    reasoning_details: [{ type: 'reasoning.encrypted', format: 'openai-responses-v1', index: 0, data: sealed }],
  };

  it.each([
    ['sent whole', encoder.encode(JSON.stringify({ id: 'x', object: 'chat.completion', choices: [{ index: 0, message, finish_reason: 'stop' }], usage: zeroUsage }))],
    ['streamed', encoder.encode([
      `data: ${JSON.stringify({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: { reasoning_content: message.reasoning_content, reasoning_encrypted: true } }] })}\n\n`,
      `data: ${JSON.stringify({ object: 'chat.completion.chunk', choices: [{ index: 0, delta: { content: visible }, finish_reason: 'stop' }], usage: zeroUsage })}\n\n`,
      'data: [DONE]\n\n',
    ].join(''))],
  ])('does not bill the encrypted reasoning as output text (%s)', (_shape, body) => {
    const { usage, estimated } = usageForBilling(requestBody, { statusCode: 200, body });
    expect(estimated).toBe(true);
    expect(usage.outputTokens, `billed ${usage.outputTokens} output tokens for a ${visibleTokens}-token answer`).toBe(visibleTokens);
  });

  it('never bills more output than the request allowed', () => {
    const capped = encoder.encode(JSON.stringify({ model: 'test-model', max_tokens: 16, messages: [{ role: 'user', content: 'What colour is the sky?' }] }));
    const body = encoder.encode(JSON.stringify({ choices: [{ index: 0, message: { ...message, content: null }, finish_reason: 'length' }], usage: zeroUsage }));
    const { usage } = usageForBilling(capped, { statusCode: 200, body });
    expect(usage.outputTokens, `billed ${usage.outputTokens} output tokens on a 16-token cap`).toBeLessThanOrEqual(16);
  });

  it('caps a long visible answer at the request\'s limit', () => {
    const capped = encoder.encode(JSON.stringify({ model: 'test-model', max_tokens: 4, messages: [{ role: 'user', content: 'Tell me about seeds.' }] }));
    const body = encoder.encode(JSON.stringify({ choices: [{ index: 0, message: { role: 'assistant', content: 'Seeds store a young plant, its food and a coat. '.repeat(4) }, finish_reason: 'length' }], usage: zeroUsage }));
    expect(usageForBilling(capped, { statusCode: 200, body }).usage.outputTokens).toBe(4);
  });

  it('allows the larger of the two chat limits for each of the n answers', () => {
    const answerText = 'Seeds store a young plant, its food and a coat. '.repeat(4);
    const answerTokens = estimateTokensFromBytes(encoder.encode(answerText));
    const body = encoder.encode(JSON.stringify({ choices: [0, 1].map((index) => ({ index, message: { role: 'assistant', content: answerText } })), usage: zeroUsage }));
    const limits = { max_completion_tokens: 1, max_tokens: answerTokens, n: 2 };
    const { usage } = usageForBilling(encoder.encode(JSON.stringify({ model: 'test-model', ...limits, messages: [] })), { statusCode: 200, body });
    expect(usage.outputTokens).toBe(estimateTokensFromBytes(encoder.encode(answerText + answerText)));
  });
});
