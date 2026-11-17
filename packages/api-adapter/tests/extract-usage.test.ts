import { describe, it, expect } from 'vitest';
import { extractImageRequestFacts, extractProviderResponseFacts, extractRequestBodyFields, extractUsage } from '../src/utils.js';

describe('extractUsage', () => {
  it('returns zeros for empty usage', () => {
    const result = extractUsage({});
    expect(result).toEqual({ inputTokens: 0, outputTokens: 0, freshInputTokens: 0, cachedInputTokens: 0 });
  });

  it('parses OpenAI-style usage (no cache)', () => {
    const result = extractUsage({
      usage: { prompt_tokens: 100, completion_tokens: 50 },
    });
    expect(result).toEqual({ inputTokens: 100, outputTokens: 50, freshInputTokens: 100, cachedInputTokens: 0 });
  });

  it('parses Anthropic-style usage (no cache)', () => {
    const result = extractUsage({
      usage: { input_tokens: 100, output_tokens: 50 },
    });
    expect(result).toEqual({ inputTokens: 100, outputTokens: 50, freshInputTokens: 100, cachedInputTokens: 0 });
  });

  it('parses OpenAI-style cached tokens (prompt_tokens includes cached subset)', () => {
    const result = extractUsage({
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 200,
        prompt_tokens_details: { cached_tokens: 800 },
      },
    });
    expect(result).toEqual({
      inputTokens: 1000,
      outputTokens: 200,
      freshInputTokens: 200,  // 1000 - 800
      cachedInputTokens: 800,
    });
  });

  it('parses Anthropic-style cached tokens (input_tokens is fresh-only)', () => {
    const result = extractUsage({
      usage: {
        input_tokens: 200,      // fresh-only
        output_tokens: 100,
        cache_read_input_tokens: 800,
      },
    });
    expect(result).toEqual({
      inputTokens: 1000,        // total logical input = fresh + cached
      outputTokens: 100,
      freshInputTokens: 200,    // already fresh-only
      cachedInputTokens: 800,
    });
  });

  it('parses Anthropic prompt_cache_hit_tokens (alternative field name)', () => {
    const result = extractUsage({
      usage: {
        input_tokens: 150,
        output_tokens: 75,
        prompt_cache_hit_tokens: 600,
      },
    });
    expect(result).toEqual({
      inputTokens: 750,
      outputTokens: 75,
      freshInputTokens: 150,
      cachedInputTokens: 600,
    });
  });

  it('counts Anthropic cache creation tokens as fresh input', () => {
    const result = extractUsage({
      usage: {
        input_tokens: 150,
        cache_creation_input_tokens: 50,
        cache_read_input_tokens: 600,
        output_tokens: 75,
      },
    });
    expect(result).toEqual({
      inputTokens: 800,
      outputTokens: 75,
      freshInputTokens: 200,
      cachedInputTokens: 600,
    });
  });

  it('OpenAI cached tokens never produce negative freshInputTokens', () => {
    // Edge case: cached_tokens > prompt_tokens (shouldn't happen but be safe)
    const result = extractUsage({
      usage: {
        prompt_tokens: 50,
        completion_tokens: 10,
        prompt_tokens_details: { cached_tokens: 100 },
      },
    });
    expect(result.freshInputTokens).toBe(0);
    expect(result.cachedInputTokens).toBe(100);
  });

  it('unwraps OpenAI Responses SSE shape (response.completed event)', () => {
    // The Codex backend's `response.completed` event nests usage under
    // `response`, not at the top level. Without unwrapping, every Responses
    // request was metered as zero tokens.
    const result = extractUsage({
      type: 'response.completed',
      response: {
        id: 'resp_abc',
        model: 'gpt-5.5',
        usage: {
          input_tokens: 22,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 20,
          output_tokens_details: { reasoning_tokens: 12 },
          total_tokens: 42,
        },
      },
    });
    expect(result).toEqual({
      inputTokens: 22,
      outputTokens: 20,
      freshInputTokens: 22,
      cachedInputTokens: 0,
    });
  });

  it('reads input_tokens_details.cached_tokens (OpenAI Responses cached subset)', () => {
    const result = extractUsage({
      type: 'response.completed',
      response: {
        usage: {
          input_tokens: 1000,
          input_tokens_details: { cached_tokens: 750 },
          output_tokens: 100,
        },
      },
    });
    expect(result).toEqual({
      inputTokens: 1000,
      outputTokens: 100,
      freshInputTokens: 250,    // 1000 - 750
      cachedInputTokens: 750,
    });
  });

  it('handles Venice hybrid shape (prompt_tokens + duplicate cache_read_input_tokens)', () => {
    // Venice's /v1/chat/completions emits both shapes for the same cache hit:
    //   prompt_tokens (total, includes cached)
    //   prompt_tokens_details.cached_tokens (subset)
    //   cache_read_input_tokens (duplicate of the subset)
    // Treating cache_read_input_tokens as an Anthropic-style separate count
    // would double-bill the cached portion at the full input rate.
    const result = extractUsage({
      usage: {
        prompt_tokens: 15926,
        completion_tokens: 6,
        total_tokens: 15932,
        prompt_tokens_details: { cached_tokens: 15616 },
        cache_read_input_tokens: 15616,
      },
    });
    expect(result).toEqual({
      inputTokens: 15926,
      outputTokens: 6,
      freshInputTokens: 310,    // 15926 - 15616, NOT 15926
      cachedInputTokens: 15616,
    });
  });

  it('unwraps Anthropic Messages streaming message_start (message.usage)', () => {
    // Anthropic streaming SSE: `message_start` nests usage under `message`.
    // Without unwrapping, the cached/cache-creation counts vanish and only the
    // fresh tail from message_delta survives — producing absurdly low
    // on-chain inputTokens for Anthropic agents.
    const result = extractUsage({
      type: 'message_start',
      message: {
        id: 'msg_123',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5',
        usage: {
          input_tokens: 23,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 15000,
          output_tokens: 1,
        },
      },
    });
    expect(result).toEqual({
      inputTokens: 15023,        // fresh + cached (Anthropic separate-shape)
      outputTokens: 1,
      freshInputTokens: 23,
      cachedInputTokens: 15000,
    });
  });

  it('takes the larger cached count when subset and separate disagree', () => {
    // Defensive: if a provider reports mismatched values, prefer the larger one
    // and still apply subset semantics (since prompt_tokens is present).
    const result = extractUsage({
      usage: {
        prompt_tokens: 1000,
        completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 600 },
        cache_read_input_tokens: 800,
      },
    });
    expect(result.freshInputTokens).toBe(200);   // 1000 - 800
    expect(result.cachedInputTokens).toBe(800);
  });
});

describe('image/provider fact extraction', () => {
  it('extracts billable OpenAI image generation request attributes and default output count', () => {
    const facts = extractImageRequestFacts({
      path: '/v1/images/generations',
      method: 'POST',
      body: {
        model: 'gpt-image-1',
        size: '1024x1024',
        quality: 'high',
        background: 'transparent',
        output_format: 'png',
      },
    });
    expect(facts).toEqual({
      model: 'gpt-image-1',
      size: '1024x1024',
      quality: 'high',
      requestedImages: 1,
    });
  });

  it('defaults the image edits path to one output image when n is omitted', () => {
    const facts = extractImageRequestFacts({
      path: '/v1/images/edits',
      method: 'POST',
      body: { model: 'gpt-image-1' },
    });
    expect(facts).toEqual({
      model: 'gpt-image-1',
      size: 'auto',
      quality: 'auto',
      requestedImages: 1,
    });
  });

  it('reads an image path written in other letter case as the same endpoint', () => {
    for (const path of ['/V1/Images/Generations', '/v1/IMAGES/edits']) {
      expect(extractImageRequestFacts({ path, method: 'POST', body: { model: 'gpt-image-1' } })).toEqual({
        model: 'gpt-image-1',
        size: 'auto',
        quality: 'auto',
        requestedImages: 1,
      });
    }
  });

  it('normalizes invalid image counts to the endpoint default', () => {
    for (const n of [0, -1, 1.5, '0', Number.MAX_SAFE_INTEGER + 1]) {
      const facts = extractImageRequestFacts({
        path: '/v1/images/generations',
        method: 'POST',
        body: { model: 'gpt-image-1', n },
      });
      expect(facts.requestedImages).toBe(1);
    }
  });

  it('extracts billing fields from a multipart image edits body, skipping file parts', () => {
    const boundary = '----antseedBoundary123';
    const body = new TextEncoder().encode([
      `--${boundary}`,
      'Content-Disposition: form-data; name="model"',
      '',
      'gpt-image-1',
      `--${boundary}`,
      'Content-Disposition: form-data; name="n"',
      '',
      '2',
      `--${boundary}`,
      'Content-Disposition: form-data; name="size"',
      '',
      '1024x1024',
      `--${boundary}`,
      'Content-Disposition: form-data; name="image"; filename="photo.png"',
      'Content-Type: image/png',
      '',
      '\x89PNG\r\n\x1a\nbinary-bytes-here',
      `--${boundary}--`,
      '',
    ].join('\r\n'));

    const fields = extractRequestBodyFields(
      { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    );
    expect(fields).toEqual({ model: 'gpt-image-1', n: '2', size: '1024x1024' });

    const facts = extractImageRequestFacts({
      path: '/v1/images/edits',
      method: 'POST',
      body: fields ?? undefined,
    });
    expect(facts).toEqual({
      model: 'gpt-image-1',
      size: '1024x1024',
      quality: 'auto',
      requestedImages: 2,
    });
  });

  it('reads multipart text fields as UTF-8, emoji and CJK included', () => {
    const boundary = '----antseedBoundary123';
    const prompt = 'make the sky warmer 🌅 让天空更温暖 €™';
    const body = new TextEncoder().encode([
      `--${boundary}`,
      'Content-Disposition: form-data; name="prompt"',
      '',
      prompt,
      `--${boundary}--`,
      '',
    ].join('\r\n'));
    expect(extractRequestBodyFields({ 'content-type': `multipart/form-data; boundary=${boundary}` }, body)).toEqual({ prompt });
  });

  it('falls back to JSON parsing for non-multipart content types', () => {
    const fields = extractRequestBodyFields(
      { 'content-type': 'application/json' },
      new TextEncoder().encode(JSON.stringify({ model: 'gpt-image-1', n: 3 })),
    );
    expect(fields).toEqual({ model: 'gpt-image-1', n: 3 });
  });

  it('returns null for a multipart body with a malformed boundary', () => {
    expect(
      extractRequestBodyFields(
        { 'content-type': 'multipart/form-data' },
        new TextEncoder().encode('irrelevant'),
      ),
    ).toBeNull();
  });

  it('extracts supported OpenAI image response facts without changing token usage', () => {
    const facts = extractProviderResponseFacts({
      usage: {
        input_tokens: 120,
        output_tokens: 300,
        input_tokens_details: {
          text_tokens: 20,
          image_tokens: 100,
          cached_tokens: 10,
        },
        output_tokens_details: {
          text_tokens: 0,
          image_tokens: 300,
        },
      },
      data: [{ b64_json: 'a' }, { b64_json: 'b' }],
    });
    expect(facts.tokenUsage.inputTokens).toBe(120);
    expect(facts.tokenUsage.cachedInputTokens).toBe(10);
    expect(facts.outputImages).toBe(2);
  });

  it('counts only response entries that contain delivered image data', () => {
    const facts = extractProviderResponseFacts({
      data: [
        {},
        null,
        { b64_json: '' },
        { url: '   ' },
        { b64_json: 'encoded-image' },
        { url: 'https://example.test/image.png' },
      ],
    });
    expect(facts.outputImages).toBe(2);
  });
});
