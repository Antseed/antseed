import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {ListPricesResponse, Offering} from './api.ts';
import {mediumOf, selectMarket} from './lanes.ts';
import {makerOf} from './makers.ts';
import {cleanName, familyKey, pickName} from './names.ts';

const CHAT = ['openai-chat-completions'];
let seller = 0;
const offer = (service: string, extra: Partial<Offering> = {}): Offering => ({
  service, sellerAddress: `0x${++seller}`, sellerOnChainReputationScore: 50, protocols: CHAT, inputUsdPerMillion: 1, ...extra,
});
const market = (offerings: Offering[]) => ({totals: {uniqueServices: 42}, offerings});
const LIST: ListPricesResponse = {
  data: [
    {id: 'anthropic/claude-opus-5.5', name: 'Anthropic: Claude Opus 5.5', pricing: {prompt: '0.00001'}},
    {id: 'anthropic/claude-opus-5.5:batch', name: 'Anthropic: Claude Opus 5.5 (batch)', pricing: {prompt: '0.000005'}},
    {id: 'deepseek/deepseek-v4.1-flash-1017', name: 'DeepSeek: DeepSeek V4.1 Flash 1017', pricing: {prompt: '0.0000004'}},
  ],
};

test('media come from the protocol, a media protocol first', () => {
  assert.equal(mediumOf(['openai-chat-completions', 'openai-images']), 'image');
  assert.equal(mediumOf(['fal-video']), 'video');
  assert.equal(mediumOf(['openai-audio-speech']), 'voice');
  assert.equal(mediumOf(['anthropic-messages']), 'text');
  assert.equal(mediumOf(['typesafe-systemone']), null);
});

test('one family per model, however the seller writes it', () => {
  const key = (s: string, image = false) => familyKey(s, makerOf(s)!, image);
  assert.equal(key('claude-opus-4-7'), key('claude-opus-4.7'));
  assert.equal(key('deepseek/deepseek-v4.1-flash'), key('deepseek-v4.1-flash:fast'));
  assert.equal(key('deepseek-v4.1-flash-1017'), key('deepseek-v4.1-flash'));
  assert.equal(key('minimax/h3/text-to-video'), key('minimax-h3-image-to-video'));
  assert.equal(key('fal-ai/kling-video/v3/pro/text-to-video'), key('kling-v3-pro-image-to-video'));
  assert.notEqual(key('gpt-image-2', true), key('gpt-2', true));
});

test('names read as titles', () => {
  assert.equal(cleanName('Seedance 2 0 Fast Text To Video Basic'), 'Seedance 2.0 Fast');
  assert.equal(cleanName('Tts Elevenlabs Turbo V2 5'), 'ElevenLabs Turbo V2.5 TTS');
  assert.equal(cleanName('Tts Qwen3 0 6b'), 'Qwen3 0.6B TTS');
  assert.equal(pickName(['H3 Text To Video', 'MiniMax H3 Image To Video']), 'MiniMax H3');
});

test('text: lowest paid price from reputable sellers, the saving on the list price, makers dealt in turn', () => {
  const view = selectMarket(market([
    offer('claude-opus-5.5', {inputUsdPerMillion: 4}),
    offer('claude-opus-5-5', {inputUsdPerMillion: 2}),
    offer('claude-opus-5.5', {inputUsdPerMillion: 0}),
    offer('claude-opus-5.5', {inputUsdPerMillion: 1, sellerOnChainReputationScore: 0}),
    offer('claude-sonnet-5', {inputUsdPerMillion: 1, serviceDisplayName: 'Claude Sonnet 5'}),
    offer('claude-sonnet-5', {inputUsdPerMillion: 1, serviceDisplayName: 'Claude Sonnet 5'}),
    offer('deepseek-v4.1-flash', {inputUsdPerMillion: 0.1}),
    offer('deepseek-v4.1-flash-1017', {inputUsdPerMillion: 0.3}),
    offer('own-label-model', {inputUsdPerMillion: 0.1}),
    offer('kimi-k3', {inputUsdPerMillion: 0.5}),
  ]), LIST);
  assert.ok(view);
  assert.equal(view.models, 42);
  assert.deepEqual(view.lanes.text, [
    {name: 'Claude Opus 5.5', logo: 'labs-color/anthropic.svg', providers: 4, price: 2, save: 80},
    {name: 'DeepSeek V4.1 Flash', logo: 'labs-color/deepseek.svg', providers: 2, price: 0.1, save: 75},
    {name: 'Claude Sonnet 5', logo: 'labs-color/anthropic.svg', providers: 2, price: 1, save: null},
  ]);
});

test('media cards carry no price until sellers publish a unit price', () => {
  const images = ['openai-images'];
  const view = selectMarket(market([
    offer('claude-opus-5.5'), offer('claude-opus-5.5'),
    offer('gpt-image-2', {protocols: images, inputUsdPerMillion: 0, serviceDisplayName: 'GPT Image 2'}),
    offer('bfl/flux-2-pro', {protocols: images, inputUsdPerMillion: 0, unitPrices: {output_images: {minUsd: 0.03, maxUsd: 0.03}}, serviceDisplayName: 'Flux 2 Pro'}),
    offer('flux-2-pro', {protocols: images, inputUsdPerMillion: 0, unitPrices: {output_images: {minUsd: 0.015, maxUsd: 0.015}}, serviceDisplayName: 'Flux 2 Pro'}),
    offer('tts-xai-v1', {protocols: ['openai-audio-speech'], unitPrices: {input_characters: {minUsd: 0.000015, maxUsd: 0.000015}}, serviceDisplayName: 'Tts xAI V1'}),
  ]), LIST);
  assert.ok(view);
  assert.deepEqual(view.lanes.image.map((m) => [m.name, m.price]), [['Flux 2 Pro', 0.015], ['GPT Image 2', null]]);
  assert.deepEqual(view.lanes.voice.map((m) => [m.name, m.price]), [['xAI V1 TTS', 15]]);
  assert.deepEqual(view.lanes.video, []);
});

test('a marketplace without text prices is not a view', () => {
  assert.equal(selectMarket(market([]), LIST), null);
});
