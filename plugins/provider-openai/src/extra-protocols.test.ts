import { expect, it } from 'vitest';
import plugin from './index.js';

const config = { OPENAI_API_KEY: 'unit-test-only', ANTSEED_ALLOWED_SERVICES: 'text,other' };
const extras = (protocols: string[]) => ({ ANTSEED_SERVICE_EXTRA_PROTOCOLS_JSON: JSON.stringify({ text: protocols }) });

it('merges extra protocols for one text service without duplicates', async () => {
  const provider = await plugin.createProvider({
    ...config, ...extras(['openai-responses', 'anthropic-messages', 'openai-responses']),
  });
  expect(provider.serviceApiProtocols).toEqual({
    text: ['openai-chat-completions', 'openai-responses', 'anthropic-messages'],
    other: ['openai-chat-completions'],
  });
});

it('rejects an unsupported protocol at provider creation', () => {
  expect(() => plugin.createProvider({ ...config, ...extras(['openai-images']) })).toThrow('supports only');
});

it.each(['gpt-image-1', 'tts-1'])('rejects extras on %s and its alias', (model) => {
  expect(() => plugin.createProvider({
    ...config, ANTSEED_ALLOWED_SERVICES: model,
    ANTSEED_SERVICE_EXTRA_PROTOCOLS_JSON: JSON.stringify({ [model]: ['openai-responses'] }),
  })).toThrow('only for text services');
  expect(() => plugin.createProvider({
    ...config, ...extras(['openai-responses']),
    ANTSEED_SERVICE_ALIAS_MAP_JSON: JSON.stringify({ text: model }),
  })).toThrow('only for text services');
});

it('keeps default announcements when extra protocols are omitted', async () => {
  const provider = await plugin.createProvider({ ...config, ANTSEED_ALLOWED_SERVICES: 'text,gpt-image-1,tts-1' });
  expect(provider.serviceApiProtocols).toEqual({
    text: ['openai-chat-completions'],
    'gpt-image-1': ['openai-images'],
    'tts-1': ['openai-audio-speech'],
  });
});
