import test from 'node:test';
import assert from 'node:assert/strict';
import { findGatewayEntry, recommendAppModels, toChatModel, toTrustedChatModels, minVideoUsdPerSecond } from './catalog.js';
import type { GatewayModelEntry } from './models.js';

const seller = (n: string, fields: Record<string, unknown>) => ({ peerId: n.repeat(40), ...fields });
const free = { inputUsdPerMillion: 0, outputUsdPerMillion: 0 };
const paid = { inputUsdPerMillion: 1, outputUsdPerMillion: 2 };

const entries: GatewayModelEntry[] = [
  { id: 'trusted-paid', type: 'text', peers: [seller('a', { effectiveReputationScore: 82, ...paid })] },
  // Free, with the most sellers and tools, but only a low-trust seller and a failing one serve it.
  {
    id: 'untrusted-free',
    type: 'text',
    capabilities: { tool_use: true },
    peers: [seller('b', { effectiveReputationScore: 10, ...free }), seller('c', { effectiveReputationScore: 95, health: { status: 'failing' }, ...free })],
  },
];

test('the chat marks the models the connected apps leave out, and keeps them for a chat already on one', () => {
  const models = toTrustedChatModels(entries);
  assert.deepEqual(models.map((model) => [model.id, model.lowTrust === true]).sort(), [['trusted-paid', false], ['untrusted-free', true]]);
});

test('a default works without funds first: free and trusted, then free, then paid and trusted, then the rest', () => {
  // Every free text model is low-trust: an unfunded user still lands on one that answers.
  assert.deepEqual(recommendAppModels(toTrustedChatModels(entries)).map((model) => model.id), ['untrusted-free', 'trusted-paid']);
  const all: GatewayModelEntry[] = [
    ...entries,
    { id: 'trusted-free', type: 'text', peers: [seller('d', { effectiveReputationScore: 70, ...free })] },
    { id: 'untrusted-paid', type: 'text', capabilities: { tool_use: true }, peers: [seller('e', { effectiveReputationScore: 5, ...paid }), seller('f', { effectiveReputationScore: 5, ...paid })] },
  ];
  assert.deepEqual(recommendAppModels(toTrustedChatModels(all)).map((model) => model.id), ['trusted-free', 'untrusted-free', 'trusted-paid', 'untrusted-paid']);
});

test('a trusted image model alone does not mark every text model low-trust', () => {
  const mixed: GatewayModelEntry[] = [
    { id: 'image', type: 'image', peers: [seller('a', { effectiveReputationScore: 90 })] },
    { id: 'text', type: 'text', peers: [seller('b', { effectiveReputationScore: 10, ...free })] },
  ];
  assert.deepEqual(toTrustedChatModels(mixed).map((model) => [model.id, model.lowTrust === true]).sort(), [['image', false], ['text', false]]);
});

test('nothing is marked when no seller is trusted, or for a plain OpenAI-compatible list', () => {
  const untrusted = [{ id: 'x', type: 'text', peers: [seller('a', { effectiveReputationScore: 3 })] }];
  assert.equal(toTrustedChatModels(untrusted).some((model) => model.lowTrust), false);
  assert.equal(toTrustedChatModels([{ id: 'plain-a' }, { id: 'plain-b' }]).some((model) => model.lowTrust), false);
});

test('a chat on a model finds its entry after the listing names it by another of its ids', () => {
  const entries: GatewayModelEntry[] = [
    { id: 'qwen', type: 'text' },
    { id: 'z-ai/glm-5.3-flash', type: 'text', peers: [seller('a', { serviceId: 'z-ai/glm-5.3-flash' })] },
  ];
  assert.equal(findGatewayEntry(entries, 'glm-5.3-flash')?.id, 'z-ai/glm-5.3-flash');
  assert.equal(findGatewayEntry(entries, 'GLM-5.3-Flash')?.id, 'z-ai/glm-5.3-flash');
  assert.equal(findGatewayEntry(entries, `${'a'.repeat(40)}@GLM-5.3-FLASH`)?.id, 'z-ai/glm-5.3-flash');
  assert.equal(findGatewayEntry(entries, 'qwen')?.id, 'qwen');
  assert.equal(findGatewayEntry(entries, 'gone'), null);
});

test('an exact entry id beats a canonical match, and a dated variant is another model', () => {
  const entries: GatewayModelEntry[] = [
    { id: 'z-ai/glm-5.3-flash', type: 'text' },
    { id: 'glm-5.3-flash', type: 'text' },
    { id: 'deepseek-v4.1-flash', type: 'text' },
  ];
  assert.equal(findGatewayEntry(entries, 'glm-5.3-flash')?.id, 'glm-5.3-flash');
  assert.equal(findGatewayEntry(entries, 'z-ai/glm-5.3-flash')?.id, 'z-ai/glm-5.3-flash');
  assert.equal(findGatewayEntry(entries, 'deepseek-v4-1-flash-1017'), null);
});

test('an image model keeps each seller\'s price per image for the seller picker', () => {
  const model = toChatModel({
    id: 'flux-2-pro',
    type: 'image',
    peers: [
      { peerId: '0xAB12CD34', minImageUsdPerImage: 0.04 },
      { peerId: 'ef56ab78', minImageUsdPerImage: 0.05 },
      { peerId: 'cd90ef12' },
      { peerId: '12ab34cd', minImageUsdPerImage: 0 },
    ],
  } as unknown as GatewayModelEntry);
  // A free seller keeps its $0, next to the paid ones.
  assert.deepEqual(model.imageUsdBySeller, { ab12cd34: 0.04, ef56ab78: 0.05, '12ab34cd': 0 });
  assert.equal(toChatModel({ id: 'glm-5.3-flash', peers: [{ peerId: 'ab12cd34', inputUsdPerMillion: 0.3 }] } as unknown as GatewayModelEntry).imageUsdBySeller, undefined);
});

test('a text model keeps the retail reference price the gateway lists; any other entry has none', () => {
  const peers = [{ peerId: 'ab12cd34', inputUsdPerMillion: 0.6, outputUsdPerMillion: 2.5 }];
  const listed = (fields: Record<string, unknown>) => toChatModel({ id: 'kimi-k3', type: 'text', peers, ...fields } as unknown as GatewayModelEntry);
  assert.deepEqual(
    listed({ reference_price: { input_usd_per_million: 1, output_usd_per_million: 4, cached_input_usd_per_million: 0.1 } }).referencePrice,
    { inputUsdPerMillion: 1, outputUsdPerMillion: 4 },
  );
  assert.deepEqual(listed({ reference_price: { output_usd_per_million: 4 } }).referencePrice, { inputUsdPerMillion: null, outputUsdPerMillion: 4 });
  // An older gateway, a plain OpenAI-compatible list, or a malformed value.
  for (const fields of [{}, { reference_price: null }, { reference_price: { input_usd_per_million: '1' } }, { reference_price: { input_usd_per_million: 0, output_usd_per_million: -1 } }]) {
    assert.equal('referencePrice' in listed(fields), false);
  }
  // Image models charge per image.
  assert.equal('referencePrice' in listed({ type: 'image', reference_price: { input_usd_per_million: 1, output_usd_per_million: 4 } }), false);
});

test('a video model reads its lowest price per second of video from its sellers\' unit billing models', () => {
  const peers = [
    { peerId: 'aaaa', unitBillingModels: { 'fal-video': { version: 1, components: [
      { unit: 'video_seconds', priceUsd: 0.17, match: { resolution: '720p' } },
      { unit: 'video_seconds', priceUsd: 0.29, match: { resolution: '1080p' } },
    ] } } },
    { peerId: 'bbbb', unitBillingModels: { 'venice-video': { version: 1, components: [
      { unit: 'video_seconds', priceUsd: 0.10285, match: { resolution: '720p' } },
      { unit: 'images', priceUsd: 0.01 },
    ] } } },
  ];
  assert.equal(minVideoUsdPerSecond(peers), 0.10285);
  assert.equal(minVideoUsdPerSecond([{ peerId: 'cccc' }]), null);
  assert.equal(toChatModel({ id: 'example-video', type: 'video', peers }).minVideoUsdPerSecond, 0.10285);
});
