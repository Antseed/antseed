import test from 'node:test';
import assert from 'node:assert/strict';
import { recommendAppModels, toTrustedChatModels } from './catalog.js';
import type { GatewayModelEntry } from './models.js';

const seller = (n: string, fields: Record<string, unknown>) => ({ peerId: n.repeat(40), ...fields });
const free = { inputUsdPerMillion: 0, outputUsdPerMillion: 0 };
const paid = { inputUsdPerMillion: 1, outputUsdPerMillion: 2 };

const entries: GatewayModelEntry[] = [
  { id: 'trusted-paid', type: 'text', peers: [seller('a', { effectiveReputationScore: 82, ...paid })] },
  // Free, with the most sellers and tools: the best default but for trust.
  {
    id: 'untrusted-free',
    type: 'text',
    capabilities: { tool_use: true },
    peers: [seller('b', { effectiveReputationScore: 10, ...free }), seller('c', { effectiveReputationScore: 95, health: { status: 'unhealthy' }, ...free })],
  },
];

test('the chat marks the models the connected apps leave out, and keeps them for a chat already on one', () => {
  const models = toTrustedChatModels(entries);
  assert.deepEqual(models.map((model) => [model.id, model.lowTrust === true]).sort(), [['trusted-paid', false], ['untrusted-free', true]]);
});

test('the chat default comes from the trusted models, even when a low-trust one is free', () => {
  assert.deepEqual(recommendAppModels(toTrustedChatModels(entries)).map((model) => model.id), ['trusted-paid', 'untrusted-free']);
});

test('nothing is marked when no seller is trusted, or for a plain OpenAI-compatible list', () => {
  const untrusted = [{ id: 'x', type: 'text', peers: [seller('a', { effectiveReputationScore: 3 })] }];
  assert.equal(toTrustedChatModels(untrusted).some((model) => model.lowTrust), false);
  assert.equal(toTrustedChatModels([{ id: 'plain-a' }, { id: 'plain-b' }]).some((model) => model.lowTrust), false);
});
