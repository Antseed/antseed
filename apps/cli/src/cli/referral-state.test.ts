import assert from 'node:assert/strict';
import test from 'node:test';
import { encodeInvite } from '@antseed/node';
import { referralLookups, referralScope, resolveBuyerAttribution, watchReferralAttribution } from './referral-state.js';

const REFERRER = '0x1111111111111111111111111111111111111111';
const BUYER = '0x2222222222222222222222222222222222222222';
const INVITE = { epoch: 42n, index: 7n, r: `0x${'aa'.repeat(32)}`, vs: `0x${'bb'.repeat(32)}` };

test('buyer attribution resolves the client agent id from env, config, then chain config', () => {
  const chain = { cli: 11, desktop: 12 };
  const fromEnv = resolveBuyerAttribution({ referralState: null, clientAgentId: 5, clientAgentIds: chain, env: { ANTSEED_CLIENT_AGENT_ID: '7' } });
  assert.equal(BigInt(fromEnv.clientId!), 7n);
  assert.equal(fromEnv.invite, undefined);

  const fromConfig = resolveBuyerAttribution({ referralState: null, clientAgentId: 5, clientAgentIds: chain, env: {} });
  assert.equal(BigInt(fromConfig.clientId!), 5n);

  const cli = resolveBuyerAttribution({ referralState: null, clientAgentIds: chain, env: {} });
  assert.equal(BigInt(cli.clientId!), 11n);
  const desktop = resolveBuyerAttribution({ referralState: null, clientAgentIds: chain, env: { ANTSEED_CLIENT_KIND: 'desktop' } });
  assert.equal(BigInt(desktop.clientId!), 12n);

  const none = resolveBuyerAttribution({ referralState: null, env: {} });
  assert.deepEqual(none, {});
});

test('buyer attribution ignores a malformed ANTSEED_CLIENT_AGENT_ID and falls back to the configured id', () => {
  for (const value of ['12.5', '12junk', '1e3', '0x0c', '-4', '0', '9007199254740993']) {
    const resolved = resolveBuyerAttribution({ referralState: null, clientAgentId: 5, env: { ANTSEED_CLIENT_AGENT_ID: value } });
    assert.equal(BigInt(resolved.clientId!), 5n, `${value} is not an agent id`);
  }
});

test('buyer attribution carries a pending invite until it is bound, keeping the client', () => {
  const invited = resolveBuyerAttribution({ referralState: { state: 'invited', invite: encodeInvite(INVITE), referrer: REFERRER }, clientAgentId: 5, env: {} });
  assert.deepEqual(invited.invite, INVITE);
  assert.equal(BigInt(invited.clientId!), 5n);

  const bound = resolveBuyerAttribution({ referralState: { state: 'bound', referrer: REFERRER }, clientAgentId: 5, env: {} });
  assert.equal(bound.invite, undefined);
  assert.equal(BigInt(bound.clientId!), 5n);
});

test('referral scope and lookups follow the configured referrals contract', async () => {
  assert.equal(referralScope({ evmChainId: 8453 }, REFERRER), null);
  assert.deepEqual(referralScope({ evmChainId: 8453, referralsAddress: REFERRER }, BUYER), { wallet: BUYER, chainId: 8453, referralsAddress: REFERRER });

  assert.deepEqual(referralLookups({ explorerApiUrl: 'https://antscan.example', client: null }), {});
  const noExplorer = referralLookups({ client: { referrerOf: async () => '0x0000000000000000000000000000000000000000' } });
  assert.equal(noExplorer.explorer, null);
  assert.equal(await noExplorer.chain!(BUYER), null);
  const withExplorer = referralLookups({ explorerApiUrl: 'https://antscan.example', client: { referrerOf: async () => REFERRER } });
  assert.equal(typeof withExplorer.explorer, 'function');
  assert.equal(await withExplorer.chain!(BUYER), REFERRER);
});

test('the saved invite is applied before the explorer answers, and the background sync drops it once bound', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { saveReferralInvite } = await import('@antseed/node');
  const dataDir = await mkdtemp(join(tmpdir(), 'antseed-referral-watch-'));
  const scope = { wallet: BUYER, chainId: 8453, referralsAddress: REFERRER };
  try {
    await saveReferralInvite(dataDir, scope, encodeInvite(INVITE), REFERRER);
    let answerExplorer!: (referrer: string | null) => void;
    let markExplorerCalled!: () => void;
    const explorerCalled = new Promise<void>((resolve) => { markExplorerCalled = resolve; });
    const lookups = {
      explorer: () => {
        markExplorerCalled();
        return new Promise<string | null>((resolve) => { answerExplorer = resolve; });
      },
      chain: async () => REFERRER,
    };
    const applied: Array<ReturnType<typeof resolveBuyerAttribution>> = [];
    const watch = await watchReferralAttribution({ dataDir, scope, lookups, clientAgentId: 5, env: {}, apply: (a) => applied.push(a) });
    try {
      // Startup (the proxy) continues here: the invite is already installed
      // although the explorer has not answered yet.
      assert.equal(applied.length, 1);
      assert.deepEqual(applied[0]!.invite, INVITE);
      assert.equal(BigInt(applied[0]!.clientId!), 5n);

      await explorerCalled;
      answerExplorer(REFERRER);
      await watch.synced;
      assert.equal(applied.length, 2);
      assert.equal(applied[1]!.invite, undefined);
      assert.equal(BigInt(applied[1]!.clientId!), 5n);
    } finally {
      watch.stop();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('an invite saved while the watcher reads the state is applied by a later poll', async () => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { saveReferralInvite, syncReferralState, writeReferralState } = await import('@antseed/node');
  const dataDir = await mkdtemp(join(tmpdir(), 'antseed-referral-watch-'));
  const scope = { wallet: BUYER, chainId: 8453, referralsAddress: REFERRER };
  try {
    await writeReferralState(dataDir, scope, { state: 'none' });
    let raced = false
    // The first sync reads "none"; another process redeems an invite before
    // the watcher looks at the file again.
    const syncState: typeof syncReferralState = async (...args) => {
      const state = await syncReferralState(...args)
      if (!raced) {
        raced = true
        await new Promise((resolve) => setTimeout(resolve, 10))
        await saveReferralInvite(dataDir, scope, encodeInvite(INVITE), REFERRER)
      }
      return state
    }
    const applied: Array<ReturnType<typeof resolveBuyerAttribution>> = [];
    const watch = await watchReferralAttribution({ dataDir, scope, lookups: {}, clientAgentId: 5, env: {}, intervalMs: 100, syncState, apply: (a) => applied.push(a) });
    try {
      await watch.synced;
      assert.equal(applied[0]!.invite, undefined);
      const deadline = Date.now() + 2_000;
      while (!applied.at(-1)!.invite && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
      assert.deepEqual(applied.at(-1)!.invite, INVITE);
    } finally {
      watch.stop();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test('referral attribution without a referrals deployment applies only the client id', async () => {
  const applied: Array<ReturnType<typeof resolveBuyerAttribution>> = [];
  const watch = await watchReferralAttribution({ dataDir: '/nonexistent-antseed-dir', scope: null, lookups: {}, clientAgentId: 5, env: {}, apply: (a) => applied.push(a) });
  await watch.synced;
  watch.stop();
  assert.ok(applied.length >= 1);
  for (const attribution of applied) assert.equal(attribution.invite, undefined);
});
