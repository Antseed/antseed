import { describe, expect, it } from 'vitest';
import { MAX_SERVICES_PER_PROVIDER } from '@antseed/node';
import { isImageModelId, isSpeechModelId, parseFallbackUpstreamsJson, parseServiceCapabilitiesJson, parseServiceUnitBillingModelsJson } from './config-utils.js';

describe('isSpeechModelId', () => {
  it('matches OpenAI and Venice text-to-speech models only', () => {
    for (const model of ['tts-1', 'tts-1-hd', 'gpt-4o-mini-tts', 'tts-kokoro', 'tts-elevenlabs-turbo-v2-5', 'venice/tts-minimax-speech-02-hd']) {
      expect(isSpeechModelId(model)).toBe(true);
    }
    for (const model of ['gpt-4o', 'gpt-4o-mini', 'whisper-1', 'gpt-4o-transcribe', 'stts-model']) {
      expect(isSpeechModelId(model)).toBe(false);
    }
  });
});

describe('isImageModelId: flux-3', () => {
  it('matches the flux-3 image model but not the flux-3 video models', () => {
    expect(isImageModelId('flux-3-image')).toBe(true);
    expect(isImageModelId('flux-3-image-to-video')).toBe(false);
    expect(isImageModelId('flux-3-text-to-video')).toBe(false);
  });
});

describe('parseServiceCapabilitiesJson speech', () => {
  it('keeps and validates speech options', () => {
    expect(parseServiceCapabilitiesJson(JSON.stringify({ 'tts-kokoro': { speech: { voices: ['af_sky'], customVoices: false } } })))
      .toEqual({ 'tts-kokoro': { speech: { voices: ['af_sky'], customVoices: false } } });
    expect(() => parseServiceCapabilitiesJson(JSON.stringify({ 'tts-kokoro': { speech: { voices: [] } } }))).toThrow(/speech.voices/);
  });
});

describe('isImageModelId', () => {
  it.each([
    'gpt-image-2',
    'openai/gpt-image-1-5',
    'dall-e-3',
    'grok-imagine-image-2-0',
    'venice-sd35',
    'krea-2-turbo',
    'krea-v2-large',
    'flux-2-pro',
    'hunyuan-image-v3',
    'ideogram-v4',
    'imagineart-1.5-pro',
    'luma-uni-1-max',
    'nano-banana-pro',
    'recraft-v4-pro',
    'seedream-v5-lite',
    'qwen-image-3-pro',
    'wan-2-7-pro-text-to-image',
    'lustify-v8',
    'wai-Illustrious',
    'z-image-turbo',
    'chroma',
  ])('recognizes image model %s', (model) => {
    expect(isImageModelId(model)).toBe(true);
  });

  it.each([
    'gpt-5.5',
    'flux-capacitor-chat',
    'qwen3-vl-235b',
    'recraft-v3-text',
    'seedream-chat',
    'acme/chroma-chat',
    'my-flux-2-pro-wrapper',
  ])('does not classify text model %s as an image model', (model) => {
    expect(isImageModelId(model)).toBe(false);
  });
});

describe('parseServiceUnitBillingModelsJson', () => {
  it('accepts completed requests in the existing priceUsd component format', () => {
    const models = { route: { 'irp-suggest': { version: 1, components: [{ unit: 'completed_requests', priceUsd: 0.001 }] } } };
    expect(parseServiceUnitBillingModelsJson(JSON.stringify(models))).toEqual(models);
  });

  it('rejects unknown service API protocol keys', () => {
    expect(() => parseServiceUnitBillingModelsJson(JSON.stringify({
      'gpt-image-1': {
        'not-a-protocol': {
          version: 1,
          components: [],
        },
      },
    }))).toThrow(/known service API protocol/);
  });

  it('rejects units that are not registered for the protocol', () => {
    expect(() => parseServiceUnitBillingModelsJson(JSON.stringify({
      'gpt-image-1': {
        'openai-images': {
          version: 1,
          components: [{ unit: 'video_seconds', priceUsd: 0.1 }],
        },
      },
    }))).toThrow(/video_seconds is not supported for openai-images/);
  });

  it('accepts known service API protocol keys', () => {
    expect(parseServiceUnitBillingModelsJson(JSON.stringify({
      'gpt-image-1': {
        'openai-images': {
          version: 1,
          components: [],
        },
      },
    }))).toEqual({
      'gpt-image-1': {
        'openai-images': {
          version: 1,
          components: [],
        },
      },
    });
  });
});

describe('parseServiceCapabilitiesJson', () => {
  it('returns undefined for empty input', () => {
    expect(parseServiceCapabilitiesJson(undefined)).toBeUndefined();
    expect(parseServiceCapabilitiesJson('{}')).toBeUndefined();
  });

  it('parses a full capabilities map', () => {
    expect(parseServiceCapabilitiesJson(JSON.stringify({
      'gpt-5.5': {
        contextWindow: 200000,
        maxOutputTokens: 16384,
        inputs: ['text', 'image'],
        reasoning: true,
        toolUse: false,
      },
      'gpt-image-1': {
        outputs: ['image'],
        supportedParameters: ['background', 'output_format', 'size'],
      },
    }))).toEqual({
      'gpt-5.5': {
        contextWindow: 200000,
        maxOutputTokens: 16384,
        inputs: ['text', 'image'],
        reasoning: true,
        toolUse: false,
      },
      'gpt-image-1': {
        outputs: ['image'],
        supportedParameters: ['background', 'output_format', 'size'],
      },
    });
  });

  it('rejects duplicate input modalities (same as the metadata validator)', () => {
    expect(() => parseServiceCapabilitiesJson(JSON.stringify({
      'gpt-5.5': { inputs: ['text', 'image', 'text'] },
    }))).toThrow(/Duplicate input modality/);
  });

  it('rejects unknown input modalities', () => {
    expect(() => parseServiceCapabilitiesJson(JSON.stringify({
      'gpt-5.5': { inputs: ['text', 'hologram'] },
    }))).toThrow(/Unsupported input modality "hologram"/);
  });

  it('rejects unknown output modalities', () => {
    expect(() => parseServiceCapabilitiesJson(JSON.stringify({
      'gpt-image-1': { outputs: ['hologram'] },
    }))).toThrow(/Unsupported output modality "hologram"/);
  });

  it('rejects malformed supported parameters', () => {
    expect(() => parseServiceCapabilitiesJson(JSON.stringify({
      'gpt-image-1': { supportedParameters: ['Output-Format'] },
    }))).toThrow(/must be lowercase snake_case/);
    expect(() => parseServiceCapabilitiesJson(JSON.stringify({
      'gpt-image-1': { supportedParameters: ['seed', 'seed'] },
    }))).toThrow(/Duplicate supported parameter "seed"/);
    expect(() => parseServiceCapabilitiesJson(JSON.stringify({
      'gpt-image-1': { supportedParameters: Array.from({ length: 33 }, (_, i) => `param_${i}`) },
    }))).toThrow(/exceeds max 32/);
  });

  it('rejects token counts above the announce-time wire ceiling', () => {
    expect(() => parseServiceCapabilitiesJson(JSON.stringify({
      'gpt-5.5': { contextWindow: 2_000_000_000 },
    }))).toThrow(/positive integer <= 1000000000/);
  });

  it('rejects more services than the metadata validator allows', () => {
    const many = Object.fromEntries(
      Array.from({ length: MAX_SERVICES_PER_PROVIDER + 1 }, (_, i) => [`svc-${i}`, { contextWindow: 1000 }]),
    );
    expect(() => parseServiceCapabilitiesJson(JSON.stringify(many)))
      .toThrow(`must not define more than ${MAX_SERVICES_PER_PROVIDER} services`);
  });

  it('rejects non-integer token counts', () => {
    expect(() => parseServiceCapabilitiesJson(JSON.stringify({
      'gpt-5.5': { contextWindow: -1 },
    }))).toThrow(/positive integer/);
    expect(() => parseServiceCapabilitiesJson(JSON.stringify({
      'gpt-5.5': { maxOutputTokens: 1.5 },
    }))).toThrow(/positive integer/);
  });

  it('rejects non-boolean flags', () => {
    expect(() => parseServiceCapabilitiesJson(JSON.stringify({
      'gpt-5.5': { reasoning: 'yes' },
    }))).toThrow(/must be a boolean/);
  });
});

describe('parseFallbackUpstreamsJson', () => {
  it('parses upstreams and lowercases service aliases but not paths', () => {
    expect(parseFallbackUpstreamsJson(JSON.stringify([
      {
        baseUrl: 'https://openrouter.ai/api',
        apiKey: ' or-key ',
        services: ['Kimi-K3.1-Pro'],
        serviceAliasMap: { 'Kimi-K3.1-Pro': 'moonshotai/kimi-k3.1-pro' },
        pathRewrite: { '/v1/Chat': '/v2/Chat' },
      },
      { baseUrl: 'https://mirror.example.com' },
    ]))).toEqual([
      {
        baseUrl: 'https://openrouter.ai/api',
        apiKey: 'or-key',
        services: ['Kimi-K3.1-Pro'],
        serviceAliasMap: { 'kimi-k3.1-pro': 'moonshotai/kimi-k3.1-pro' },
        pathRewrite: { '/v1/Chat': '/v2/Chat' },
      },
      { baseUrl: 'https://mirror.example.com' },
    ]);
  });

  it('returns undefined for missing or empty input', () => {
    expect(parseFallbackUpstreamsJson(undefined)).toBeUndefined();
    expect(parseFallbackUpstreamsJson('[]')).toBeUndefined();
  });

  it.each([
    ['{}', 'must be an array'],
    ['[{"baseUrl":"ftp://x"}]', '[0].baseUrl must be an http(s) URL'],
    ['[{"baseUrl":"https://x.example","apiKey":""}]', '[0].apiKey must be a non-empty string'],
    ['[{"baseUrl":"https://x.example","services":[]}]', '[0].services must be a non-empty array'],
    ['[{"baseUrl":"https://x.example","serviceAliasMap":{"a":1}}]', '[0].serviceAliasMap must be an object of non-empty strings'],
  ])('rejects %s', (raw, message) => {
    expect(() => parseFallbackUpstreamsJson(raw)).toThrow(message);
  });
});
