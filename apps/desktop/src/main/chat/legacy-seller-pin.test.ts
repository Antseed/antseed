import assert from 'node:assert/strict';
import test from 'node:test';
import { clearLegacySellerPin, sessionServiceId } from './legacy-seller-pin.js';

const PEER = 'a'.repeat(40);

function session(modelId: string, entries: Array<Record<string, unknown>>) {
  return {
    getEntries: () => entries,
    buildSessionContext: () => ({ model: { modelId } }),
    appendCustomEntry: (customType: string, data: unknown) => { entries.push({ type: 'custom', customType, data }); },
  } as unknown as Parameters<typeof sessionServiceId>[0] & Parameters<typeof clearLegacySellerPin>[0];
}
const peerEntry = (data: Record<string, unknown>) => ({ type: 'custom', customType: 'antseed:peer', data });

test('a pre-gateway pinned session keeps its seller', () => {
  assert.equal(sessionServiceId(session('qwen3-coder', [peerEntry({ peerId: `0x${PEER}`, routeMode: 'pinned' })])), `${PEER}@qwen3-coder`);
});

test('automatic bindings and sessions without a binding stay on Auto', () => {
  assert.equal(sessionServiceId(session('qwen3-coder', [])), 'qwen3-coder');
  assert.equal(sessionServiceId(session('qwen3-coder', [peerEntry({ peerId: PEER, routeMode: 'auto' })])), 'qwen3-coder');
  assert.equal(sessionServiceId(session('qwen3-coder', [
    peerEntry({ peerId: PEER, routeMode: 'pinned' }),
    peerEntry({ peerId: PEER, routeMode: 'auto' }),
  ])), 'qwen3-coder');
});

test('choosing a model after the upgrade ends the old pin', () => {
  const upgraded = session('qwen3-coder', [peerEntry({ peerId: PEER, routeMode: 'pinned' })]);
  clearLegacySellerPin(upgraded);
  assert.equal(sessionServiceId(upgraded), 'qwen3-coder');
});

test('nothing is written for a session with no old pin', () => {
  const entries: Array<Record<string, unknown>> = [];
  clearLegacySellerPin(session('qwen3-coder', entries));
  assert.equal(entries.length, 0);
});
