import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_MODEL_MIN_TRUST, entryHasTrustedSeller, toGatewayModel, trustedAppEntries } from './models.js';
import { toChatModel } from './catalog.js';

test('a model reasons when the entry says so or one of its sellers reports it', () => {
  const declared = { id: 'model-a', name: 'Model A', type: 'text', capabilities: { reasoning: true }, peers: [] };
  const oneSeller = {
    id: 'model-b',
    type: 'text',
    peers: [{ peerId: 'a'.repeat(40), capabilities: { reasoning: false } }, { peerId: 'b'.repeat(40), capabilities: { reasoning: true } }],
  };
  assert.deepEqual(toGatewayModel(declared), { id: 'model-a', label: 'Model A', type: 'text', reasoning: true });
  assert.equal(toGatewayModel(oneSeller).reasoning, true);
  // The chat picker reads the same capability.
  assert.equal(toChatModel(declared).reasoning, true);
  assert.equal(toChatModel(oneSeller).reasoning, true);
});

test('a plain model, or a plain OpenAI-compatible entry, does not reason', () => {
  const plain = { id: 'model-c', type: 'text', capabilities: { reasoning: false }, peers: [{ peerId: 'c'.repeat(40), capabilities: { toolUse: true } }] };
  assert.equal(toGatewayModel(plain).reasoning, false);
  assert.equal(toChatModel(plain).reasoning, false);
  assert.deepEqual(toGatewayModel({ id: 'bare', peers: ['not a seller'] }), { id: 'bare', label: 'bare', type: null, reasoning: false });
});

const seller = (n: string, fields: Record<string, unknown>) => ({ peerId: n.repeat(40), ...fields });

test('apps list a model only when a trusted, healthy seller serves it', () => {
  const trusted = { id: 'trusted', peers: [seller('a', { effectiveReputationScore: 12 }), seller('b', { effectiveReputationScore: 82 })] };
  const lowTrust = { id: 'low-trust', peers: [seller('c', { effectiveReputationScore: 0 }), seller('d', { effectiveReputationScore: 59.9 })] };
  // Announced health is `unknown`, `healthy` or `failing`.
  const failing = { id: 'failing', peers: [seller('e', { effectiveReputationScore: 95, health: { status: 'failing' } })] };
  const unknownHealth = { id: 'unknown-health', peers: [seller('g', { effectiveReputationScore: 95, health: { status: 'unknown' } })] };
  const noScore = { id: 'no-score', peers: [seller('f', {})] };
  assert.equal(APP_MODEL_MIN_TRUST, 60);
  assert.equal(entryHasTrustedSeller(trusted), true);
  assert.equal(entryHasTrustedSeller(lowTrust), false);
  assert.equal(entryHasTrustedSeller(failing), false);
  assert.equal(entryHasTrustedSeller(unknownHealth), true);
  assert.equal(entryHasTrustedSeller(noScore), false);
  assert.deepEqual(trustedAppEntries([trusted, lowTrust, failing, unknownHealth, noScore]).map((entry) => entry.id), ['trusted', 'unknown-health']);
});

test('the trust check uses the effective score routing uses, then the on-chain one', () => {
  // Effective trust wins even when the raw score is higher, as in routing.
  assert.equal(entryHasTrustedSeller({ id: 'm', peers: [seller('a', { effectiveReputationScore: 40, reputationScore: 90 })] }), false);
  assert.equal(entryHasTrustedSeller({ id: 'm', peers: [seller('a', { onChainReputationScore: 70 })] }), true);
});

test('a trusted image model does not empty the text list: each type falls back on its own', () => {
  const image = { id: 'image', type: 'image', peers: [seller('a', { effectiveReputationScore: 90 })] };
  const textA = { id: 'text-a', type: 'text', peers: [seller('b', { effectiveReputationScore: 10 })] };
  const textB = { id: 'text-b', peers: [seller('c', { effectiveReputationScore: 20 })] };
  const lowTrustImage = { id: 'image-b', type: 'image', peers: [seller('d', { effectiveReputationScore: 5 })] };
  assert.deepEqual(trustedAppEntries([image, textA, textB, lowTrustImage]).map((entry) => entry.id), ['image', 'text-a', 'text-b']);
});

test('a plain OpenAI-compatible list is kept, and so is a list with no trusted seller at all', () => {
  const plain = [{ id: 'plain-a' }, { id: 'plain-b' }];
  assert.deepEqual(trustedAppEntries(plain), plain);
  const untrusted = [{ id: 'x', peers: [seller('a', { effectiveReputationScore: 3 })] }];
  assert.deepEqual(trustedAppEntries(untrusted), untrusted);
});
