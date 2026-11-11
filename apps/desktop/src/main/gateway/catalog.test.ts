import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendAppModels, toTrustedChatModels } from './catalog.js';
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
