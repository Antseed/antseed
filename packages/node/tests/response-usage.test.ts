import { describe, it, expect } from 'vitest';
import { parseResponseUsage } from '../src/utils/response-usage.js';

const enc = new TextEncoder();

describe('parseResponseUsage', () => {
  it('extracts usage from a multi-event Responses SSE stream', () => {
    // Mirrors the shape of a real Codex `response.completed` event:
    // usage is nested under `response`, and cached tokens live under
    // `input_tokens_details.cached_tokens`.
    const stream = [
      'event: response.created',
      'data: {"type":"response.created","response":{"id":"r1","model":"gpt-5.5"}}',
      '',
      'event: response.in_progress',
      'data: {"type":"response.in_progress","response":{"id":"r1","model":"gpt-5.5"}}',
      '',
      'event: response.output_text.delta',
      'data: {"type":"response.output_text.delta","delta":"Hi"}',
      '',
      'event: response.completed',
      'data: {"type":"response.completed","response":{"id":"r1","model":"gpt-5.5","usage":{"input_tokens":42,"input_tokens_details":{"cached_tokens":10},"output_tokens":7}}}',
      '',
    ].join('\n');
    const usage = parseResponseUsage(enc.encode(stream));
    expect(usage.inputTokens).toBe(42);
    expect(usage.outputTokens).toBe(7);
    expect(usage.cachedInputTokens).toBe(10);
    expect(usage.freshInputTokens).toBe(32);
  });

  it('extracts total input tokens from Anthropic cached usage', () => {
    const usage = parseResponseUsage(enc.encode(JSON.stringify({
      usage: {
        input_tokens: 200,
        cache_read_input_tokens: 800,
        output_tokens: 100,
      },
    })));
    expect(usage).toEqual({
      inputTokens: 1000,
      outputTokens: 100,
      freshInputTokens: 200,
      cachedInputTokens: 800,
    });
  });

  it('extracts cached + fresh + output from a real Anthropic streaming SSE', () => {
    // Mirrors the shape Anthropic returns when the SDK sends a request that
    // hits prompt cache: `message_start` carries the input/cache counts under
    // `message.usage`, and `message_delta` carries only the running
    // output_tokens. This was the exact failure mode reported on chain:
    // inputTokens=23, outputTokens=21747 — the 15k cached tokens were dropped.
    const stream = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_123","type":"message","role":"assistant","model":"claude-sonnet-4-5","content":[],"stop_reason":null,"stop_sequence":null,"usage":{"input_tokens":23,"cache_creation_input_tokens":0,"cache_read_input_tokens":15000,"output_tokens":1}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"output_tokens":21747}}',
      '',
    ].join('\n');
    const usage = parseResponseUsage(enc.encode(stream));
    expect(usage).toEqual({
      inputTokens: 15023,
      outputTokens: 21747,
      freshInputTokens: 23,
      cachedInputTokens: 15000,
    });
  });

  describe('an event written over several data lines', () => {
    const USAGE = { inputTokens: 3, outputTokens: 2, freshInputTokens: 3, cachedInputTokens: 0 };

    it('joins the data lines of one event into one payload', () => {
      const sse = [
        'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}',
        '',
        'data: {"choices":[],',
        'data: "usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
        '',
        'data: [DONE]',
        '',
      ].join('\n');
      expect(parseResponseUsage(enc.encode(sse))).toEqual(USAGE);
    });

    it('joins them across CRLF line endings and other fields of the event', () => {
      const sse = 'event: message\r\ndata:{"choices":[],\r\nid: 7\r\ndata:"usage":{"prompt_tokens":3,"completion_tokens":2}}\r\n\r\n';
      expect(parseResponseUsage(enc.encode(sse))).toEqual(USAGE);
    });

    it('reads an event whose usage object fills a line of its own', () => {
      const sse = 'data: {"usage":\ndata: {"prompt_tokens":3,"completion_tokens":2}\ndata: }\n\n';
      expect(parseResponseUsage(enc.encode(sse))).toEqual(USAGE);
    });

    it('reads the event at the end of a stream that has no closing blank line', () => {
      const sse = 'data: {"choices":[],\ndata: "usage":{"prompt_tokens":3,"completion_tokens":2}}';
      expect(parseResponseUsage(enc.encode(sse))).toEqual(USAGE);
    });

    it('still reads each line of a stream written with no blank lines between its events', () => {
      const sse = [
        'data: {"choices":[{"index":0,"delta":{"content":"hi"}}]}',
        'data: {"choices":[],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
        'data: [DONE]',
      ].join('\n');
      expect(parseResponseUsage(enc.encode(sse))).toEqual(USAGE);
    });
  });

  it('returns zeros when the body has no usage field', () => {
    const usage = parseResponseUsage(enc.encode(JSON.stringify({ model: 'foo' })));
    expect(usage).toEqual({ inputTokens: 0, outputTokens: 0, freshInputTokens: 0, cachedInputTokens: 0 });
  });
});
