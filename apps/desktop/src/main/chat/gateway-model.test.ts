import test from 'node:test';
import assert from 'node:assert/strict';

import { makeGatewayModel } from './gateway-model.js';
import { recommendAppModels, resolveEntryProtocol, toChatModel, toChatModels } from '../gateway/catalog.js';

const ENDPOINT = { mode: 'local' as const, origin: 'http://127.0.0.1:8379', apiKey: 'antseed_key' };

test('a plain OpenAI-compatible entry is a text model over chat completions', () => {
  assert.deepEqual(toChatModel({ id: 'gpt-x' }), {
    id: 'gpt-x',
    label: 'gpt-x',
    type: 'text',
    protocol: 'openai-chat-completions',
    supportsImages: false,
    sellers: 0,
    free: false,
    minImageUsd: null,
    freeSellerId: null,
    freeForStakers: false,
    tee: false,
    toolUse: false,
    reasoning: false,
    inputUsdPerMillion: null,
    outputUsdPerMillion: null,
  });
});

test('the offer summary has the cheapest prices, free and stakers-only offers, TEE and capabilities', () => {
  const model = toChatModel({
    id: 'deepseek-v4-flash',
    capabilities: { tool_use: true },
    peers: [
      { peerId: 'a', inputUsdPerMillion: 0.3, outputUsdPerMillion: 0.9, advertisedVerifierIds: ['antseed-verifier'], teeScope: 'seller-node' },
      { peerId: 'b', inputUsdPerMillion: 0.1, outputUsdPerMillion: 1.2, capabilities: { reasoning: true } },
      { peerId: 'c', inputUsdPerMillion: 0, outputUsdPerMillion: 0, freeTier: { base: { stakersOnly: true } } },
    ],
  });
  assert.deepEqual(
    [model.sellers, model.free, model.freeForStakers, model.tee, model.toolUse, model.reasoning, model.inputUsdPerMillion, model.outputUsdPerMillion],
    // The stakers-only $0 seller is not the price anyone else pays.
    [3, false, true, true, true, true, 0.1, 0.9],
  );
  assert.deepEqual(model.stakersOnlyFreeSellerIds, ['c']);
  const open = toChatModel({ id: 'm', peers: [{ peerId: 'd', inputUsdPerMillion: 0, outputUsdPerMillion: 0 }] });
  assert.equal(open.free, true);
  assert.equal(open.stakersOnlyFreeSellerIds, undefined);
  // Only stakers-only $0 sellers: the $0 price stays, and the picker says it is for stakers.
  const stakersOnly = toChatModel({ id: 's', peers: [{ peerId: '0xAB', inputUsdPerMillion: 0, outputUsdPerMillion: 0, freeTier: { base: { stakersOnly: true } } }] });
  assert.deepEqual([stakersOnly.free, stakersOnly.inputUsdPerMillion, stakersOnly.stakersOnlyFreeSellerIds], [false, 0, ['ab']]);
});

test('protocol preference: anthropic-messages, then responses, then chat completions', () => {
  assert.equal(resolveEntryProtocol({ id: 'a', supported_protocols: ['openai-chat-completions', 'anthropic-messages'] }), 'anthropic-messages');
  assert.equal(resolveEntryProtocol({ id: 'b', supported_protocols: ['openai-chat-completions', 'openai-responses'] }), 'openai-responses');
  assert.equal(resolveEntryProtocol({ id: 'c', peers: [{ protocol: 'openai-chat-completions', protocols: [] }] }), 'openai-chat-completions');
  assert.equal(resolveEntryProtocol({ id: 'd', supported_protocols: ['openai-images'] }), null);
});

test('Antseed entries carry name, type, vision and context window', () => {
  const model = toChatModel({
    id: 'qwen-vl',
    name: 'Qwen VL',
    type: 'text',
    supported_protocols: ['openai-chat-completions'],
    context_length: 131072,
    peers: [
      { peerId: 'a', protocol: 'openai-chat-completions', protocols: [], categories: ['multimodal'] },
      { peerId: 'b', protocol: 'openai-chat-completions', protocols: [], capabilities: { inputs: ['text', 'image'] } },
    ],
  });
  assert.equal(model.label, 'Qwen VL');
  assert.equal(model.supportsImages, true);
  assert.equal(model.contextWindow, 131072);
});

test('vision needs every peer to accept images unless the gateway guarantees it', () => {
  const mixed = toChatModel({
    id: 'm',
    type: 'text',
    peers: [{ peerId: 'a', categories: ['multimodal'] }, { peerId: 'b', categories: [] }],
  });
  assert.equal(mixed.supportsImages, false);
  const guaranteed = toChatModel({ id: 'g', type: 'text', architecture: { input_modalities: ['text', 'image'] } });
  assert.equal(guaranteed.supportsImages, true);
});

test('image models have no chat protocol', () => {
  const model = toChatModel({ id: 'flux', type: 'image', supported_protocols: ['openai-images'] });
  assert.equal(model.type, 'image');
  assert.equal(model.protocol, null);
  assert.equal(toChatModel({ id: 'img', supported_protocols: ['openai-images'] }).type, 'image');
});

test('the picker lists each model id once: tool-capable first, then most sellers, then by name', () => {
  const models = toChatModels([
    { id: 'b', name: 'Beta' },
    { id: 'a', name: 'alpha' },
    { id: 'b', name: 'Duplicate' },
    { id: 'c', name: 'Crowded', peers: [{ peerId: '1' }, { peerId: '2' }] },
    { id: 'd', name: 'Delta', capabilities: { tool_use: true } },
  ]);
  assert.deepEqual(models.map((model) => model.label), ['Delta', 'Crowded', 'alpha', 'Beta']);
});

test('thinking needs every seller to declare reasoning, or the pinned one', () => {
  const peers = [
    { peerId: 'AA', capabilities: { reasoning: true } },
    { peerId: 'bb', capabilities: { reasoning: false } },
  ];
  const mixed = toChatModel({ id: 'claude-haiku-5-5', peers });
  assert.deepEqual([mixed.reasoning, mixed.reasoningEverySeller, mixed.reasoningSellerIds], [true, undefined, ['aa']]);
  // The gateway's guarantee: every seller reported reasoning.
  const guaranteed = toChatModel({ id: 'm', capabilities: { reasoning: true }, peers: [{ peerId: 'cc' }] });
  assert.equal(guaranteed.reasoningEverySeller, true);
  const all = toChatModel({ id: 'm', peers: [{ peerId: 'dd', capabilities: { reasoning: true } }] });
  assert.equal(all.reasoningEverySeller, true);
  assert.equal(toChatModel({ id: 'm' }).reasoningEverySeller, undefined);
});

test('an Anthropic model reasons only when its sellers do and its form of thinking is known', () => {
  const anthropic = (modelId: string, reasoning?: boolean) => makeGatewayModel({ modelId, endpoint: ENDPOINT, protocol: 'anthropic-messages', supportsImages: false, ...(reasoning === undefined ? {} : { reasoning }) }).reasoning;
  assert.deepEqual(
    [anthropic('claude-haiku-5-5', true), anthropic('claude-haiku-5-5', false), anthropic('claude-haiku-5-5'), anthropic('code-helper', true)],
    [true, false, false, false],
  );
  // The OpenAI protocols keep their own reasoning handling.
  assert.equal(makeGatewayModel({ modelId: 'm', endpoint: ENDPOINT, protocol: 'openai-responses', supportsImages: false }).reasoning, true);
});

test('gateway models use the origin for Anthropic and /v1 for OpenAI, with a bearer key', () => {
  const anthropic = makeGatewayModel({ modelId: 'm', endpoint: ENDPOINT, protocol: 'anthropic-messages', supportsImages: false });
  assert.equal(anthropic.baseUrl, 'http://127.0.0.1:8379');
  assert.equal(anthropic.api, 'anthropic-messages');
  assert.deepEqual(anthropic.headers, { authorization: 'Bearer antseed_key' });
  assert.deepEqual(anthropic.input, ['text']);
  // A Private run's every turn asks for TEE sellers itself.
  const sealed = makeGatewayModel({ modelId: 'm', endpoint: { ...ENDPOINT, requireTee: true }, protocol: 'anthropic-messages', supportsImages: false });
  assert.deepEqual(sealed.headers, { authorization: 'Bearer antseed_key', 'x-antseed-require-tee': '1' });

  const openai = makeGatewayModel({ modelId: 'm', endpoint: ENDPOINT, protocol: 'openai-chat-completions', supportsImages: true, contextWindow: 1000 });
  assert.equal(openai.baseUrl, 'http://127.0.0.1:8379/v1');
  assert.equal(openai.api, 'openai-completions');
  assert.deepEqual(openai.input, ['text', 'image']);
  assert.equal(openai.contextWindow, 1000);
  assert.equal(makeGatewayModel({ modelId: 'm', endpoint: ENDPOINT, protocol: 'openai-responses', supportsImages: false }).api, 'openai-responses');
});

test('apps default to free models first, then tool use, then the most sellers; never image models', () => {
  const free = { inputUsdPerMillion: 0, outputUsdPerMillion: 0 };
  const paid = { inputUsdPerMillion: 1, outputUsdPerMillion: 2 };
  const models = toChatModels([
    { id: 'paid-tools', capabilities: { tool_use: true }, peers: [{ peerId: '1', ...paid }, { peerId: '2', ...paid }, { peerId: '3', ...paid }] },
    { id: 'free-plain', peers: [{ peerId: '1', ...free }, { peerId: '2', ...free }] },
    { id: 'free-tools', capabilities: { tool_use: true }, peers: [{ peerId: '1', ...free }] },
    { id: 'free-image', type: 'image', peers: [{ peerId: '1', ...free }] },
  ]);
  assert.deepEqual(recommendAppModels(models).map((model) => model.id), ['free-tools', 'free-plain', 'paid-tools']);
});

test('an image model charging per image is not free, though its token prices are $0', () => {
  const models = toChatModels([
    { id: 'flux', type: 'image', peers: [{ peerId: 'a', inputUsdPerMillion: 0, outputUsdPerMillion: 0, minImageUsdPerImage: 0.005 }] },
    { id: 'chroma', type: 'image', peers: [{ peerId: 'b', inputUsdPerMillion: 0, outputUsdPerMillion: 0 }] },
  ]);
  const paid = models.find((model) => model.id === 'flux');
  const free = models.find((model) => model.id === 'chroma');
  assert.equal(paid?.free, false);
  assert.equal(paid?.freeSellerId, null);
  assert.equal(paid?.minImageUsd, 0.005);
  assert.equal(free?.free, true);
});

test('a seller charging only for cached input is not free, as the buyer decides it', () => {
  const models = toChatModels([
    { id: 'cached-paid', peers: [{ peerId: 'a', inputUsdPerMillion: 0, outputUsdPerMillion: 0, cachedInputUsdPerMillion: 0.1 }] },
    { id: 'all-zero', peers: [{ peerId: 'b', inputUsdPerMillion: 0, outputUsdPerMillion: 0, cachedInputUsdPerMillion: 0 }] },
  ]);
  const paid = models.find((model) => model.id === 'cached-paid');
  assert.equal(paid?.free, false);
  assert.equal(paid?.freeSellerId, null);
  assert.equal(models.find((model) => model.id === 'all-zero')?.free, true);
});

test('sellers that take images are listed, for a chat pinned to one when not all of them do', () => {
  const model = toChatModel({
    id: 'mixed',
    peers: [
      { peerId: `0x${'A'.repeat(40)}`, capabilities: { inputs: ['text', 'image'] } },
      { peerId: 'b'.repeat(40), capabilities: { inputs: ['text'] } },
    ],
  } as never);
  assert.equal(model.supportsImages, false);
  assert.deepEqual(model.imageInputSellerIds, ['a'.repeat(40)]);
});

test('a seller reporting a capability as false does not count as having it', () => {
  const model = toChatModel({
    id: 'plain',
    capability_coverage: { tool_use: 1, reasoning: 1 },
    capabilities: { tool_use: false, reasoning: false },
    peers: [{ peerId: 'a', capabilities: { toolUse: false, reasoning: false } }],
  });
  assert.equal(model.toolUse, false);
  assert.equal(model.reasoning, false);
});

test('one seller declaring a capability is enough, even if another does not', () => {
  const model = toChatModel({
    id: 'mixed',
    capabilities: { tool_use: false },
    peers: [{ peerId: 'a', capabilities: { toolUse: true } }, { peerId: 'b', capabilities: { toolUse: false } }],
  });
  assert.equal(model.toolUse, true);
});

test('in Private only a free seller on sealed hardware makes a model free', async () => {
  const { TEE_VERIFIER_ID } = await import('@antseed/node/tee-status');
  const entry = {
    id: 'm',
    peers: [
      { peerId: 'open-free', inputUsdPerMillion: 0, outputUsdPerMillion: 0 },
      { peerId: 'tee-paid', inputUsdPerMillion: 1, outputUsdPerMillion: 2, advertisedVerifierIds: [TEE_VERIFIER_ID], teeScope: 'seller-node' },
    ],
  };
  assert.equal(toChatModel(entry).free, true);
  assert.equal(toChatModel(entry).freeSellerId, 'open-free');
  const privateModel = toChatModel(entry, { teeOnly: true });
  assert.equal(privateModel.free, false);
  assert.equal(privateModel.freeSellerId, null);

  const teeFree = { id: 't', peers: [{ peerId: 'tee-free', inputUsdPerMillion: 0, outputUsdPerMillion: 0, advertisedVerifierIds: [TEE_VERIFIER_ID], teeScope: 'seller-node' }] };
  assert.equal(toChatModel(teeFree, { teeOnly: true }).freeSellerId, 'tee-free');
});

test('a model is TEE end to end only when a seller\'s model provider is attested too', () => {
  const tee = (teeScope?: string) => ({ peerId: 'a', inputUsdPerMillion: 1, outputUsdPerMillion: 2, advertisedVerifierIds: ['antseed-verifier'], ...(teeScope ? { teeScope } : {}) });
  assert.equal(toChatModel({ id: 'm', peers: [tee('seller-node')] }).teeEndToEnd, undefined);
  assert.equal(toChatModel({ id: 'm', peers: [tee('seller-node'), { ...tee('end-to-end'), peerId: 'b' }] }).teeEndToEnd, true);
  // Without the TEE verifier listed (an unproven seller) the scope says nothing.
  assert.equal(toChatModel({ id: 'm', peers: [{ peerId: 'c', teeScope: 'end-to-end' }] }).teeEndToEnd, undefined);
});

test('each desktop chat sends its own session id, so chats that open alike stay apart', () => {
  const one = makeGatewayModel({ modelId: 'm', endpoint: ENDPOINT, protocol: 'openai-chat-completions', supportsImages: false, conversationId: 'conv-1' });
  const two = makeGatewayModel({ modelId: 'm', endpoint: ENDPOINT, protocol: 'openai-chat-completions', supportsImages: false, conversationId: 'conv-2' });
  assert.equal(one.headers?.['x-vpr-session-id'], 'conv-1');
  assert.equal(two.headers?.['x-vpr-session-id'], 'conv-2');
});

test('a seller that only advertises the TEE verifier, unchecked, doesn\'t make a model TEE', () => {
  const advertised = { peerId: 'a', inputUsdPerMillion: 1, outputUsdPerMillion: 2, advertisedVerifierIds: ['antseed-verifier'] };
  assert.equal(toChatModel({ id: 'm', peers: [advertised] }).tee, false);
  // Shared with a proven one, the model is TEE (some of its sellers are).
  assert.equal(toChatModel({ id: 'm', peers: [advertised, { ...advertised, peerId: 'b', teeScope: 'seller-node' }] }).tee, true);
  assert.equal(toChatModel({ id: 'm', peers: [{ peerId: 'c', inputUsdPerMillion: 1, outputUsdPerMillion: 2 }] }).tee, false);
});
