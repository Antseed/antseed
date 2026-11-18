import { describe, it, expect } from 'vitest';
import { encodeHttpResponse } from '@antseed/protocol/request-codec';
import { extractUsage } from '@antseed/api-adapter';
import { promptTokensOfBody } from './tokenizer-usage.js';
import { responseBodyInputUsage, signedResponseInputUsage } from './tokenizer-signed-usage.js';

const encoder = new TextEncoder();

describe('promptTokensOfBody', () => {
  const read = (body: string) => promptTokensOfBody(encoder.encode(body));

  it('reads OpenAI prompt_tokens, with or without spaces', () => {
    expect(read('{"usage":{"prompt_tokens":15,"completion_tokens":3}}')).toBe(15);
    expect(read('{"usage": {"prompt_tokens" :  67, "total_tokens": 70}}')).toBe(67);
  });

  it('adds Anthropic cache tokens to input_tokens', () => {
    expect(read('{"usage":{"input_tokens":12,"cache_read_input_tokens":3,"cache_creation_input_tokens":1}}')).toBe(16);
    expect(read('{"usage":{"input_tokens":12,"input_tokens_details":{"cached_tokens":4}}}')).toBe(12);
  });

  it('ignores usage keys quoted inside answer text', () => {
    expect(read('{"choices":[{"message":{"content":"\\"prompt_tokens\\": 999"}}],"usage":{"prompt_tokens":15}}')).toBe(15);
  });

  it('reads only the top-level usage object, as a Responses answer needs', () => {
    expect(read('{"object":"response","output":[{"content":[{"text":"{\\"usage\\":{\\"input_tokens\\":7}}"}]}],"usage":{"input_tokens":12,"input_tokens_details":{"cached_tokens":4},"output_tokens":3,"items":{"m":{"input_tokens":2}}},"tool_usage":{"image_gen":{"input_tokens":0}},"x":{"prompt_tokens":20}}')).toBe(12);
  });

  it('reads cache tokens as the buyer does (extractUsage)', () => {
    expect(read('{"usage":{"input_tokens":150,"output_tokens":75,"prompt_cache_hit_tokens":600}}')).toBe(750);
    expect(read('{"usage":{"input_tokens":150,"cache_read_input_tokens":600,"prompt_cache_hit_tokens":600}}')).toBe(750);
    expect(read('{"usage":{"input_tokens":12,"input_tokens_details":{"cached_tokens":4},"cache_read_input_tokens":4}}')).toBe(12);
    expect(read('{"usage":{"input_tokens":12,"input_tokens_details":{"cached_tokens":null},"cache_read_input_tokens":4}}')).toBe(12);
    expect(read('{"usage":{"input_tokens":50,"cache_read_input_tokens":70,"input_tokens_details":{"reasoning":1}}}')).toBe(120);
    expect(read('{"usage":{"input_tokens":100,"prompt_tokens_details":{"cached_tokens":30},"cache_read_input_tokens":20}}')).toBe(130);
  });

  it('agrees with the buyer (extractUsage) on every usage shape it reads', () => {
    const shapes = [
      { prompt_tokens: 67, prompt_tokens_details: { cached_tokens: 10 } },
      { input_tokens: 12, input_tokens_details: { cached_tokens: 4 }, output_tokens: 3 },
      { input_tokens: 200, cache_read_input_tokens: 800 },
      { input_tokens: 150, prompt_cache_hit_tokens: 600 },
      { input_tokens: 150, cache_creation_input_tokens: 50, cache_read_input_tokens: 600 },
      { input_tokens: 50, cache_read_input_tokens: 70, input_tokens_details: {} },
      { input_tokens: 100, prompt_tokens_details: { cached_tokens: 30 }, cache_read_input_tokens: 20 },
    ];
    for (const usage of shapes) {
      expect(read(JSON.stringify({ usage }))).toBe(extractUsage({ usage }).inputTokens);
    }
  });

  it('reads whole integer token counts only', () => {
    expect(read('{"usage":{"prompt_tokens": 1000 }}')).toBe(1000);
    expect(read('{"usage":{"prompt_tokens":1e3}}')).toBeNull();
    expect(read('{"usage":{"prompt_tokens":15.0,"completion_tokens":2}}')).toBeNull();
    expect(read('{"usage":{"input_tokens":12x}}')).toBeNull();
  });

  it('refuses usage JSON.parse could read differently: escaped member names', () => {
    expect(read('{"\\u0075sage":{"prompt_tokens":10}}')).toBeNull();
    expect(read('{"usage":{"prompt_tokens":10},"\\u0075sage":{"prompt_tokens":20}}')).toBeNull();
    expect(read('{"usage":{"input_tokens":10,"\\u0063ache_read_input_tokens":5}}')).toBeNull();
    // The buyer reads 110 (input_tokens includes the cache); the raw bytes alone would give 200.
    const escapedSubset = '{"usage":{"input_tokens":110,"cache_read_input_tokens":90,"input_tokens_details":{"\\u0063ached_tokens":90}}}';
    expect(extractUsage(JSON.parse(escapedSubset)).inputTokens).toBe(110);
    expect(read(escapedSubset)).toBeNull();
    expect(read('{"model":"a\\"b","choices":[{"message":{"content":"\\u0075sage"}}],"usage":{"prompt_tokens":10}}')).toBe(10);
  });

  it('refuses usage values other than whole numbers, and reads null as absent', () => {
    expect(read('{"usage":{"prompt_tokens":10,"prompt_tokens":2e1}}')).toBeNull();
    expect(read('{"usage":{"prompt_tokens":"20"}}')).toBeNull();
    expect(read('{"usage":{"input_tokens":10,"cache_read_input_tokens":true}}')).toBeNull();
    expect(read('{"usage":{"input_tokens":12,"input_tokens_details":{"cached_tokens":"4"}}}')).toBeNull();
    expect(read('{"usage":{"prompt_tokens":null,"input_tokens":7}}')).toBe(7);
    expect(read('{"usage":{"input_tokens":7,"cache_read_input_tokens":null,"prompt_cache_hit_tokens":3}}')).toBe(10);
    for (const body of ['{"usage":{"prompt_tokens":null,"input_tokens":7}}', '{"usage":{"input_tokens":7,"cache_read_input_tokens":null,"prompt_cache_hit_tokens":3}}']) {
      expect(read(body)).toBe(extractUsage(JSON.parse(body)).inputTokens);
    }
  });

  it('refuses a repeated usage member whatever its values, since JSON.parse keeps the last', () => {
    // The buyer reads 10 here; a reader that only counted numeric values would read 15.
    const lastWins = '{"usage":{"input_tokens":10,"prompt_tokens":15,"prompt_tokens":null}}';
    expect(extractUsage(JSON.parse(lastWins)).inputTokens).toBe(10);
    for (const body of [
      lastWins,
      '{"usage":{"prompt_tokens":null,"prompt_tokens":15}}',
      '{"usage":{"prompt_tokens":15,"cache_read_input_tokens":1,"cache_read_input_tokens":null}}',
      '{"usage":{"prompt_tokens":15},"usage":null}',
      '{"usage":"none","usage":{"prompt_tokens":15}}',
      '{"usage":{"input_tokens":12,"cache_read_input_tokens":4,"input_tokens_details":{"cached_tokens":4},"input_tokens_details":null}}',
      '{"usage":{"input_tokens":12,"cache_read_input_tokens":4,"input_tokens_details":{"cached_tokens":4,"cached_tokens":null}}}',
      '{"usage":{"input_tokens":100,"prompt_tokens_details":{"cached_tokens":30},"prompt_tokens_details":7}}',
    ]) {
      expect(read(body), body).toBeNull();
    }
  });

  it('refuses ambiguous or missing usage', () => {
    expect(read('{"usage":{"prompt_tokens":15,"prompt_tokens":20}}')).toBeNull();
    expect(read('{"usage":{"prompt_tokens":15},"usage":{"prompt_tokens":20}}')).toBeNull();
    expect(read('{"x":{"usage":{"prompt_tokens":15}}}')).toBeNull();
    expect(read('{"usage":{"completion_tokens":15}}')).toBeNull();
    expect(read('{"usage":{"prompt_tokens":1234567890123456}}')).toBeNull();
  });
});

describe('signedResponseInputUsage', () => {
  const preimage = (body: string, statusCode = 200) => encodeHttpResponse({
    requestId: 'request-1', statusCode, headers: { 'content-type': 'application/json' }, body: encoder.encode(body),
  });

  it('reads the input tokens of a signed 200 response', () => {
    expect(signedResponseInputUsage(preimage('{"usage":{"prompt_tokens":143,"completion_tokens":40}}')).inputTokens).toBe(143);
    expect(signedResponseInputUsage(preimage('{"usage":{"input_tokens":26,"output_tokens":9}}')).inputTokens).toBe(26);
  });

  it('reads none from a failed response, a response without usage, or bytes that are no response', () => {
    expect(signedResponseInputUsage(preimage('{"usage":{"prompt_tokens":143}}', 500)).inputTokens).toBeNull();
    expect(signedResponseInputUsage(preimage('{"choices":[]}')).inputTokens).toBeNull();
    expect(signedResponseInputUsage(Uint8Array.from([1, 2, 3])).inputTokens).toBeNull();
  });

  it('reads a zero count as no count: a reply cut off before the upstream reported usage', () => {
    expect(signedResponseInputUsage(preimage('{"usage":{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0}}')).inputTokens).toBeNull();
  });

  it('tells when the usage reports cached input, in every shape upstreams and gateways use', () => {
    const usage = (value: unknown) => signedResponseInputUsage(preimage(JSON.stringify({ usage: value })));
    expect(usage({ prompt_tokens: 143, completion_tokens: 40 })).toEqual({ inputTokens: 143, cachedInput: false });
    expect(usage({ prompt_tokens: 143, prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 } })).toEqual({ inputTokens: 143, cachedInput: false });
    expect(usage({ prompt_tokens: 120, prompt_tokens_details: { cached_tokens: 108, text_tokens: 1279 } })).toEqual({ inputTokens: 120, cachedInput: true });
    expect(usage({ prompt_tokens: 802, prompt_tokens_details: { cached_tokens: 0, cached_creation_tokens: 770, cache_write_tokens: 770 } }).cachedInput).toBe(true);
    expect(usage({ input_tokens: 12, cache_read_input_tokens: 3 })).toEqual({ inputTokens: 15, cachedInput: true });
    expect(usage({ input_tokens: 12, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 })).toEqual({ inputTokens: 12, cachedInput: false });
    expect(usage({ input_tokens: 150, prompt_cache_hit_tokens: 600 }).cachedInput).toBe(true);
    expect(usage({ input_tokens: 12, input_tokens_details: { cached_tokens: 4 } })).toEqual({ inputTokens: 12, cachedInput: true });
    // Not a count, and not where usage is read.
    expect(usage({ prompt_tokens: 143, cache: 'none' }).cachedInput).toBe(false);
    expect(signedResponseInputUsage(preimage('{"cached_tokens":5,"usage":{"prompt_tokens":143}}')).cachedInput).toBe(false);
    expect(signedResponseInputUsage(preimage('{"usage":{"prompt_tokens":143}}', 500))).toEqual({ inputTokens: null, cachedInput: false });
  });

  it('tells cached input also when there is no count to read, so a stored record and its bytes agree', () => {
    for (const body of [
      '{"usage":{"cached_tokens":1}}',
      '{"usage":{"prompt_tokens":0,"completion_tokens":0,"prompt_tokens_details":{"cached_tokens":12}}}',
      '{"usage":{"prompt_tokens":15.0,"prompt_tokens_details":{"cached_tokens":12}}}',
      // Gemini's own usage shape: not one the reader counts.
      '{"usage":{"promptTokenCount":40,"cachedContentTokenCount":30}}',
    ]) {
      expect(signedResponseInputUsage(preimage(body)), body).toEqual({ inputTokens: null, cachedInput: true });
    }
  });

  it('reads no count from a body that is not one JSON object, though the byte scanner alone finds one', () => {
    const complete = '{"id":"1","choices":[],"usage":{"prompt_tokens":15}}';
    expect(signedResponseInputUsage(preimage(complete)).inputTokens).toBe(15);
    for (const body of [
      // Cut off before its last brace.
      '{"usage":{"prompt_tokens":123}',
      // An event-stream line.
      `data: ${complete}`,
      // Text after the object.
      '{"a":"x"}}{"usage":{"prompt_tokens":99}}',
      // A byte-order mark.
      `\uFEFF${complete}`,
    ]) {
      expect(promptTokensOfBody(encoder.encode(body)), body).not.toBeNull();
      expect(signedResponseInputUsage(preimage(body)), body).toEqual({ inputTokens: null, cachedInput: false });
    }
    // Two documents, and a document that is not an object.
    for (const body of [`${complete}\n${complete}`, `[${complete}]`, '15', 'null']) {
      expect(signedResponseInputUsage(preimage(body)), body).toEqual({ inputTokens: null, cachedInput: false });
    }
    // Bytes that are not UTF-8.
    const broken = Uint8Array.from([...encoder.encode('{"note":"'), 0xff, ...encoder.encode('","usage":{"prompt_tokens":15}}')]);
    expect(responseBodyInputUsage(broken)).toEqual({ inputTokens: null, cachedInput: false });
  });

  it('reads no count from an error sent with status 200, whatever usage it carries', () => {
    // Gateways send the status before the upstream answers, so a later failure arrives as a 200 error envelope.
    for (const body of [
      '{"error":{"message":"upstream overloaded","code":502},"usage":{"prompt_tokens":40}}',
      '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"usage":{"input_tokens":40}}',
      '{"error":"rate limited","usage":{"prompt_tokens":40,"prompt_tokens_details":{"cached_tokens":8}}}',
    ]) {
      expect(signedResponseInputUsage(preimage(body)), body).toEqual({ inputTokens: null, cachedInput: false });
    }
    // Nor an error beside an empty list of choices: no first choice, as the reference's reader sees it.
    expect(signedResponseInputUsage(preimage('{"choices":[],"error":{"message":"partial"},"usage":{"prompt_tokens":40}}'))).toEqual({ inputTokens: null, cachedInput: false });
    // Nor beside a first choice that is no choice.
    expect(signedResponseInputUsage(preimage('{"choices":[null],"error":{"message":"partial"},"usage":{"prompt_tokens":40}}'))).toEqual({ inputTokens: null, cachedInput: false });
    // An answer is read whatever else it says: a null error, or an error beside a choice.
    expect(signedResponseInputUsage(preimage('{"object":"response","error":null,"usage":{"input_tokens":40}}')).inputTokens).toBe(40);
    expect(signedResponseInputUsage(preimage('{"choices":[{"message":{"content":"ok"}}],"error":{"message":"partial"},"usage":{"prompt_tokens":40}}')).inputTokens).toBe(40);
  });

  it('reads a body on its own as it reads a signed response', () => {
    expect(responseBodyInputUsage(encoder.encode('{"usage":{"input_tokens":12,"cache_read_input_tokens":3}}'))).toEqual({ inputTokens: 15, cachedInput: true });
    expect(responseBodyInputUsage(encoder.encode('{"usage":{"prompt_tokens":143}}'))).toEqual({ inputTokens: 143, cachedInput: false });
  });
});
