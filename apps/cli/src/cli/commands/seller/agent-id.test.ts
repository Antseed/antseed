import assert from 'node:assert/strict';
import test from 'node:test';
import type { AbstractSigner } from 'ethers';
import { ensureRegisteredAgentId, recoverAgentId, resolveLegacyStakeAgentId } from './agent-id.js';

const OWNER = '0x1111111111111111111111111111111111111111';
const wallet = {} as AbstractSigner;

function fakeIdentity(opts: { registered: boolean; mintedId?: number; owned?: number[] }) {
  const calls: string[] = [];
  return {
    calls,
    isRegistered: async () => opts.registered,
    register: async (_signer: AbstractSigner, _uri?: string, onTransaction?: (hash: string) => void) => {
      calls.push('register');
      onTransaction?.('0xabc');
      return opts.mintedId ?? 0;
    },
    findOwnedAgentIds: async () => {
      calls.push('scan');
      return opts.owned ?? [];
    },
  };
}

test('recoverAgentId returns the single agent the wallet holds', async () => {
  assert.equal(await recoverAgentId(fakeIdentity({ registered: true, owned: [42] }), OWNER), 42);
});

test('recoverAgentId returns undefined when the wallet holds none', async () => {
  assert.equal(await recoverAgentId(fakeIdentity({ registered: true, owned: [] }), OWNER), undefined);
});

test('recoverAgentId refuses to guess between several agents and lists them', async () => {
  await assert.rejects(
    recoverAgentId(fakeIdentity({ registered: true, owned: [3, 12] }), OWNER),
    /several agent IDs \(3, 12\)\. Pass --agent-id <id>/,
  );
});

test('register prints the minted agent ID as soon as the receipt lands', async () => {
  const lines: string[] = [];
  const identity = fakeIdentity({ registered: false, mintedId: 77 });
  const result = await ensureRegisteredAgentId(
    { identity, lookupBoundAgentId: async () => { throw new Error('not consulted'); }, log: (line) => lines.push(line) },
    wallet, OWNER, { requireAgentId: true },
  );
  assert.deepEqual(result, { agentId: 77, minted: true });
  assert.deepEqual(lines, ['Transaction: 0xabc', 'Agent ID: 77']);
  assert.deepEqual(identity.calls, ['register']);
});

test('register re-run recovers the agent ID from the registry when the binding never happened', async () => {
  const identity = fakeIdentity({ registered: true, owned: [77] });
  const result = await ensureRegisteredAgentId(
    { identity, lookupBoundAgentId: async () => 0, log: () => {} },
    wallet, OWNER, { requireAgentId: true },
  );
  assert.deepEqual(result, { agentId: 77, minted: false });
  assert.deepEqual(identity.calls, ['scan']);
});

test('register prefers --agent-id and the bound agent ID over a log scan', async () => {
  const identity = fakeIdentity({ registered: true, owned: [77] });
  const deps = { identity, lookupBoundAgentId: async () => 5, log: () => {} };
  assert.equal((await ensureRegisteredAgentId(deps, wallet, OWNER, { agentId: 9, requireAgentId: true })).agentId, 9);
  assert.equal((await ensureRegisteredAgentId(deps, wallet, OWNER, { requireAgentId: true })).agentId, 5);
  assert.deepEqual(identity.calls, []);
});

test('register leaves the agent ID unknown when none is found, and lists several', async () => {
  const none = await ensureRegisteredAgentId(
    { identity: fakeIdentity({ registered: true, owned: [] }), lookupBoundAgentId: async () => 0, log: () => {} },
    wallet, OWNER, { requireAgentId: true },
  );
  assert.equal(none.agentId, undefined);
  await assert.rejects(ensureRegisteredAgentId(
    { identity: fakeIdentity({ registered: true, owned: [3, 12] }), lookupBoundAgentId: async () => 0, log: () => {} },
    wallet, OWNER, { requireAgentId: true },
  ), /several agent IDs \(3, 12\)/);
});

test('register skips the log scan when the agent ID is not needed', async () => {
  const identity = fakeIdentity({ registered: true, owned: [77] });
  const result = await ensureRegisteredAgentId(
    { identity, lookupBoundAgentId: async () => 0, log: () => {} },
    wallet, OWNER, { requireAgentId: false },
  );
  assert.equal(result.agentId, undefined);
  assert.deepEqual(identity.calls, []);
});

test('legacy stake uses the staked agent ID, then --agent-id, then recovers from the registry', async () => {
  const identity = fakeIdentity({ registered: true, owned: [77] });
  assert.equal(await resolveLegacyStakeAgentId(4, 9, identity, OWNER), 4);
  assert.equal(await resolveLegacyStakeAgentId(0, 9, identity, OWNER), 9);
  assert.deepEqual(identity.calls, []);
  assert.equal(await resolveLegacyStakeAgentId(0, undefined, identity, OWNER), 77);
  assert.deepEqual(identity.calls, ['scan']);
});

test('legacy stake finds nothing, or refuses to guess between several agents', async () => {
  assert.equal(await resolveLegacyStakeAgentId(0, undefined, fakeIdentity({ registered: true, owned: [] }), OWNER), undefined);
  await assert.rejects(
    resolveLegacyStakeAgentId(0, undefined, fakeIdentity({ registered: true, owned: [3, 12] }), OWNER),
    /several agent IDs/,
  );
});
