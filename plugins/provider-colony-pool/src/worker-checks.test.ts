import { describe, expect, it } from 'vitest';
import { checkRequestBody } from './worker.js';

const messages = [{ role: 'user', content: 'Reply with the single word: ready' }];

describe('pool check budget', () => {
  it('runs one completion of at most 16 tokens', () => {
    expect(checkRequestBody({ messages, max_tokens: 4096 })).toEqual({ messages, max_tokens: 16 });
    expect(checkRequestBody({ messages, max_tokens: 8 })).toEqual({ messages, max_tokens: 8 });
    expect(checkRequestBody({ messages })).toEqual({ messages, max_tokens: 16 });
    expect(checkRequestBody({ messages, max_completion_tokens: 2000 })).toEqual({ messages, max_tokens: 16 });
  });

  it('never keeps a zero, negative or non-numeric budget', () => {
    expect(checkRequestBody({ messages, max_tokens: -5 })['max_tokens']).toBe(1);
    expect(checkRequestBody({ messages, max_tokens: 0 })['max_tokens']).toBe(1);
    expect(checkRequestBody({ messages, max_tokens: 2.9 })['max_tokens']).toBe(2);
    expect(checkRequestBody({ messages, max_tokens: Number.NaN })['max_tokens']).toBe(16);
    expect(checkRequestBody({ messages, max_tokens: '100000' })['max_tokens']).toBe(16);
    expect(checkRequestBody({ messages, max_tokens: -1, max_completion_tokens: 9999 })['max_tokens']).toBe(1);
  });

  it('drops every field that multiplies work', () => {
    const body = checkRequestBody({
      messages, max_tokens: 16, stream: true, n: 64, best_of: 64, logprobs: true, top_logprobs: 20,
      tools: [{ type: 'function', function: { name: 'f' } }], tool_choice: 'required', response_format: { type: 'json_schema' },
    });
    expect(body).toEqual({ messages, max_tokens: 16, stream: true });
  });

  it('refuses a check without messages', () => {
    expect(() => checkRequestBody({ prompt: 'x'.repeat(100) })).toThrow(/need messages/);
  });
});
