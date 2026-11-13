import test from 'node:test';
import assert from 'node:assert/strict';

import { generateChatImage } from './image-generation.js';
import { convertAssistantMessageForUi } from './message-projection.js';

const ENDPOINT = { mode: 'local' as const, origin: 'http://127.0.0.1:8379', apiKey: 'antseed_test' };

test('generateChatImage calls the gateway with the bearer key and persists the served model', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  globalThis.fetch = (async (input, init) => {
    calls.push({
      url: String(input),
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
    });
    return new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), {
      status: 200,
      headers: {
        'content-type': 'application/json',
        'x-antseed-peer-id': 'routed-peer',
        'x-antseed-service': 'image-model-v2',
      },
    });
  }) as typeof fetch;

  let persistedPrompt = '';
  let persistedMarker = '';
  let persistedService = '';
  let persistedBytes = Buffer.alloc(0);
  try {
    const result = await generateChatImage({
      appendImageGeneration: async (_id, prompt, marker, service) => {
        persistedPrompt = prompt;
        persistedMarker = marker;
        persistedService = service;
        return {
          user: { role: 'user', content: prompt, timestamp: 10 },
          assistant: {
            role: 'assistant', content: [{ type: 'text', text: marker }], api: 'openai-completions',
            provider: 'antseed', model: 'image-model', usage: {
              input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            }, stopReason: 'stop', timestamp: 11,
          },
        };
      },
    }, ENDPOINT, {
      conversationId: 'conversation-1', prompt: 'A tiny ant astronaut', moderation: 'low', service: 'image-model',
    }, {
      persistAttachment: async (_conversationId, _attachmentId, _name, bytes) => {
        persistedBytes = Buffer.from(bytes);
        return '/tmp/generated.png';
      },
    });

    assert.equal(result.ok, true);
    assert.equal(calls[0]?.url, 'http://127.0.0.1:8379/v1/images/generations');
    assert.deepEqual(calls[0]?.body, {
      model: 'image-model', prompt: 'A tiny ant astronaut', n: 1, response_format: 'b64_json', moderation: 'low',
    });
    assert.equal(calls[0]?.headers.get('authorization'), 'Bearer antseed_test');
    assert.equal(calls[0]?.headers.get('x-antseed-required-parameters'), 'moderation');
    assert.equal(persistedPrompt, 'A tiny ant astronaut');
    assert.equal(persistedService, 'image-model-v2');
    assert.match(persistedMarker, /^<generated-image id="([^"]+)" mime="image\/png" name="generated-[a-f0-9]{8}\.png">$/);
    assert.deepEqual(persistedBytes, png);
    assert.equal(result.assistant?.meta?.service, 'image-model-v2');
    assert.equal(result.assistant?.meta?.outputImages, 1);
    assert.equal(Array.isArray(result.assistant?.content), true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generateChatImage edits a prior generated image with multipart routing', async () => {
  const originalFetch = globalThis.fetch;
  const sourcePng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x01]);
  const editedPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x02]);
  let requestUrl = '';
  let requestHeaders = new Headers();
  let requestBody: unknown;
  globalThis.fetch = (async (input, init) => {
    requestUrl = String(input);
    requestHeaders = new Headers(init?.headers);
    requestBody = init?.body;
    return new Response(JSON.stringify({ data: [{ b64_json: editedPng.toString('base64') }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;

  let loadedAttachmentId = '';
  let persistedBytes = Buffer.alloc(0);
  try {
    const result = await generateChatImage({
      appendImageGeneration: async (_id, prompt, marker) => ({
        user: { role: 'user', content: prompt, timestamp: 1 },
        assistant: {
          role: 'assistant', content: [{ type: 'text', text: marker }], api: 'openai-completions',
          provider: 'antseed', model: 'image-model', usage: {
            input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          }, stopReason: 'stop', timestamp: 2,
        },
      }),
    }, ENDPOINT, {
      conversationId: 'conversation-1',
      prompt: 'Now with a blue background',
      moderation: 'low',
      service: 'image-model',
      sourceImageAttachmentId: 'source-image',
    }, {
      loadSourceAttachment: async (_conversationId, attachmentId) => {
        loadedAttachmentId = attachmentId;
        return { bytes: sourcePng, fileName: 'source.png' };
      },
      persistAttachment: async (_conversationId, _attachmentId, _name, bytes) => {
        persistedBytes = Buffer.from(bytes);
        return '/tmp/edited.png';
      },
    });

    assert.equal(result.ok, true, result.error);
    assert.equal(requestUrl, 'http://127.0.0.1:8379/v1/images/edits');
    assert.equal(requestHeaders.get('authorization'), 'Bearer antseed_test');
    assert.equal(requestHeaders.has('x-antseed-pin-peer'), false);
    assert.equal(requestHeaders.get('x-antseed-required-parameters'), 'moderation');
    assert.equal(requestHeaders.has('content-type'), false);
    assert.equal(loadedAttachmentId, 'source-image');
    assert.ok(requestBody instanceof FormData);
    assert.equal(requestBody.get('model'), 'image-model');
    assert.equal(requestBody.get('prompt'), 'Now with a blue background');
    assert.equal(requestBody.get('n'), '1');
    assert.equal(requestBody.get('response_format'), 'b64_json');
    assert.equal(requestBody.get('moderation'), 'low');
    const image = requestBody.get('image');
    assert.ok(image instanceof Blob);
    assert.equal(image.type, 'image/png');
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), sourcePng);
    assert.deepEqual(persistedBytes, editedPng);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generateChatImage rejects empty prompts without calling the proxy', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    throw new Error('unexpected');
  }) as typeof fetch;
  try {
    const result = await generateChatImage({ appendImageGeneration: async () => { throw new Error('unexpected'); } }, ENDPOINT, {
      conversationId: 'conversation-1', prompt: ' ', service: 'image-model',
    });
    assert.equal(result.ok, false);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generateChatImage downloads and validates an HTTPS image response', async () => {
  const originalFetch = globalThis.fetch;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  const calls: string[] = [];
  globalThis.fetch = (async (input) => {
    const url = String(input);
    calls.push(url);
    if (calls.length === 1) {
      return new Response(JSON.stringify({ data: [{ url: 'https://8.8.8.8/generated.png' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(png, { status: 200, headers: { 'content-type': 'image/png' } });
  }) as typeof fetch;

  let persisted = Buffer.alloc(0);
  try {
    const result = await generateChatImage({
      appendImageGeneration: async (_id, prompt, marker) => ({
        user: { role: 'user', content: prompt, timestamp: 1 },
        assistant: {
          role: 'assistant', content: [{ type: 'text', text: marker }], api: 'openai-completions',
          provider: 'antseed', model: 'image-model', usage: {
            input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          }, stopReason: 'stop', timestamp: 2,
        },
      }),
    }, ENDPOINT, {
      conversationId: 'conversation-1', prompt: 'Ant city', service: 'image-model',
    }, {
      persistAttachment: async (_conversationId, _attachmentId, _name, bytes) => {
        persisted = Buffer.from(bytes);
        return '/tmp/generated.png';
      },
    });

    assert.equal(result.ok, true, result.error);
    assert.deepEqual(calls, [
      'http://127.0.0.1:8379/v1/images/generations',
      'https://8.8.8.8/generated.png',
    ]);
    assert.deepEqual(persisted, png);
    const assistantBlock = Array.isArray(result.assistant?.content) ? result.assistant.content[0] : null;
    assert.equal(assistantBlock?.type === 'file' && assistantBlock.generated, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generateChatImage rejects unsafe private image URLs before downloading', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return new Response(JSON.stringify({ data: [{ url: 'https://127.0.0.1/generated.png' }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  try {
    const result = await generateChatImage({ appendImageGeneration: async () => { throw new Error('unexpected'); } }, ENDPOINT, {
      conversationId: 'conversation-1', prompt: 'Ant city', service: 'image-model',
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Image service returned an unsafe image URL.');
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generateChatImage rejects unsupported base64 image formats', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({
    data: [{ b64_json: Buffer.from('not an image').toString('base64') }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  try {
    const result = await generateChatImage({ appendImageGeneration: async () => { throw new Error('unexpected'); } }, ENDPOINT, {
      conversationId: 'conversation-1', prompt: 'Ant city', service: 'image-model',
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Image service returned an unsupported image format.');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('generateChatImage rejects oversized base64 images', async () => {
  const originalFetch = globalThis.fetch;
  const oversized = Buffer.alloc(25 * 1024 * 1024 + 1);
  oversized.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  globalThis.fetch = (async () => new Response(JSON.stringify({
    data: [{ b64_json: oversized.toString('base64') }],
  }), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch;
  try {
    const result = await generateChatImage({ appendImageGeneration: async () => { throw new Error('unexpected'); } }, ENDPOINT, {
      conversationId: 'conversation-1', prompt: 'Ant city', service: 'image-model',
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Generated image exceeds the desktop size limit.');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('persisted generated-image assistant markers project back to image attachments', () => {
  const projected = convertAssistantMessageForUi({
    role: 'assistant',
    content: [{
      type: 'text',
      text: '<generated-image id="attachment-1" mime="image/png" name="generated.png">',
    }],
    api: 'openai-completions',
    provider: 'antseed',
    model: 'image-model',
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: 'stop',
    timestamp: 10,
  });

  assert.deepEqual(projected.content, [{
    type: 'file',
    fileName: 'generated.png',
    mimeType: 'image/png',
    status: 'ready',
    attachmentId: 'attachment-1',
    generated: true,
  }]);
  assert.equal(projected.meta?.outputImages, 1);
});

test('generateChatImage rejects empty upstream image arrays', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: [] }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })) as typeof fetch;
  try {
    const result = await generateChatImage({ appendImageGeneration: async () => { throw new Error('unexpected'); } }, ENDPOINT, {
      conversationId: 'conversation-1', prompt: 'Ant city', service: 'image-model',
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'Image service returned no image.');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('a 402 reports its reason, so a spend limit does not offer Add funds', async () => {
  const originalFetch = globalThis.fetch;
  try {
    const answer = (error: Record<string, unknown>) => {
      globalThis.fetch = (async () => new Response(JSON.stringify({ error }), { status: 402 })) as typeof fetch;
    };
    const store = { appendImageGeneration: async () => { throw new Error('nothing to persist'); } };
    const request = { conversationId: 'conversation-1', prompt: 'An ant', service: 'image-model' };

    answer({ code: 'spend_limit_reached', message: 'This key reached its daily limit of $5.00.' });
    const capped = await generateChatImage(store, ENDPOINT, request);
    assert.equal(capped.ok, false);
    assert.deepEqual(capped.stopReason, { kind: 'payment_required', message: 'This key reached its daily limit of $5.00.', errorCode: 'spend_limit_reached' });

    answer({ message: 'Too low.' });
    assert.deepEqual((await generateChatImage(store, ENDPOINT, request)).stopReason, { kind: 'payment_required', message: 'Too low.' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('no moderation option, no capability requirement', async () => {
  const originalFetch = globalThis.fetch;
  try {
    let headers = new Headers();
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      headers = new Headers(init?.headers);
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    }) as typeof fetch;
    await generateChatImage({ appendImageGeneration: async () => { throw new Error('unused'); } }, ENDPOINT, { conversationId: 'conversation-1', prompt: 'An ant', service: 'image-model' });
    assert.equal(headers.has('x-antseed-required-parameters'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('an image made in Private is saved as Private, so a later edit in Anonymous needs Private too', async () => {
  const originalFetch = globalThis.fetch;
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  globalThis.fetch = (async () => new Response(JSON.stringify({ data: [{ b64_json: png.toString('base64') }] }), {
    status: 200, headers: { 'content-type': 'application/json' },
  })) as typeof fetch;
  const savedMeta: unknown[] = [];
  const store = {
    appendImageGeneration: async (_id: string, prompt: string, marker: string, service: string, meta?: unknown) => {
      savedMeta.push(meta);
      return {
        user: { role: 'user' as const, content: prompt, timestamp: 10 },
        assistant: {
          role: 'assistant' as const, content: [{ type: 'text' as const, text: marker }], api: 'openai-completions' as const,
          provider: 'antseed', model: service, usage: {
            input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          }, stopReason: 'stop' as const, timestamp: 11,
        },
      };
    },
  };
  const request = { conversationId: 'conversation-1', prompt: 'A cat', service: 'image-model' };
  const persistAttachment = async () => '/tmp/generated.png';
  try {
    // Sent with the TEE requirement: saved as Private even if the mode reads Anonymous by now.
    await generateChatImage(store as never, { ...ENDPOINT, requireTee: true }, request, { persistAttachment, privacyMode: () => 'anonymous' });
    await generateChatImage(store as never, ENDPOINT, request, { persistAttachment, privacyMode: () => 'anonymous' });
    assert.deepEqual(savedMeta, [{ privacy: 'private' }, { privacy: 'anonymous' }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
