import assert from 'node:assert/strict';
import fs, { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { clearReferralInvite, encodeInvite, readReferralState, saveReferralInvite } from '@antseed/node';
import { BuyerAttributionSync, resolveBuyerAttribution, resolveClientAgentId } from './referral-state.js';

const REFERRER = '0x1111111111111111111111111111111111111111';
const INVITE = { epoch: 42n, index: 7n, r: `0x${'aa'.repeat(32)}`, vs: `0x${'bb'.repeat(32)}` };
const DEPLOYMENT = { chainId: 8453, referralsAddress: '0x4444444444444444444444444444444444444444' };
const scopeOf = (wallet: string) => ({ ...DEPLOYMENT, wallet });

test('buyer attribution resolves the client agent id from env, config, then chain config', () => {
  const chain = { cli: 11, desktop: 12 };
  const fromEnv = resolveBuyerAttribution({ referralState: null, clientAgentId: 5, clientAgentIds: chain, env: { ANTSEED_CLIENT_AGENT_ID: '7' } });
  assert.equal(BigInt(fromEnv.clientId!), 7n);
  assert.equal(fromEnv.invite, undefined);

  const fromConfig = resolveBuyerAttribution({ referralState: null, clientAgentId: 5, clientAgentIds: chain, env: {} });
  assert.equal(BigInt(fromConfig.clientId!), 5n);
  for (const invalid of ['7garbage', '7.5', '9007199254740993', '1e3']) {
    const ignored = resolveBuyerAttribution({ referralState: null, clientAgentId: 5, clientAgentIds: chain, env: { ANTSEED_CLIENT_AGENT_ID: invalid } });
    assert.equal(BigInt(ignored.clientId!), 5n, `env ${invalid} was used`);
  }

  const cli = resolveBuyerAttribution({ referralState: null, clientAgentIds: chain, env: {} });
  assert.equal(BigInt(cli.clientId!), 11n);
  const desktop = resolveBuyerAttribution({ referralState: null, clientAgentIds: chain, env: { ANTSEED_CLIENT_KIND: 'desktop' } });
  assert.equal(BigInt(desktop.clientId!), 12n);

  const none = resolveBuyerAttribution({ referralState: null, env: {} });
  assert.deepEqual(none, {});
});

test('the client agent resolver reports where the id came from and which client default applies', () => {
  const chain = { cli: 11, desktop: 12 };
  assert.deepEqual(resolveClientAgentId({ clientAgentId: 5, clientAgentIds: chain }, { ANTSEED_CLIENT_AGENT_ID: '7' }), { agentId: 7, source: 'env', client: 'cli' });
  assert.deepEqual(resolveClientAgentId({ clientAgentId: 5, clientAgentIds: chain }, {}), { agentId: 5, source: 'config', client: 'cli' });
  assert.deepEqual(resolveClientAgentId({ clientAgentIds: chain }, {}), { agentId: 11, source: 'default', client: 'cli' });
  assert.deepEqual(resolveClientAgentId({ clientAgentIds: chain }, { ANTSEED_CLIENT_KIND: 'desktop' }), { agentId: 12, source: 'default', client: 'desktop' });
  assert.deepEqual(resolveClientAgentId({}, {}), { agentId: null, source: 'none', client: 'cli' });
});

test('buyer attribution carries a pending invite until it is bound, keeping the client', () => {
  const invited = resolveBuyerAttribution({ referralState: { state: 'invited', invite: encodeInvite(INVITE), referrer: REFERRER }, clientAgentId: 5, env: {} });
  assert.deepEqual(invited.invite, INVITE);
  assert.equal(BigInt(invited.clientId!), 5n);

  const bound = resolveBuyerAttribution({ referralState: { state: 'bound', referrer: REFERRER }, clientAgentId: 5, env: {} });
  assert.equal(bound.invite, undefined);
  assert.equal(BigInt(bound.clientId!), 5n);
});

test('attribution sync gives each wallet its own invite and drops it once bound', async () => {
  const root = mkdtempSync(join(tmpdir(), 'antseed-attribution-'));
  const identityDir = join(root, 'buyer-identities', 'team-a');
  const DEFAULT_WALLET = '0x2222222222222222222222222222222222222222';
  const TEAM_WALLET = '0x3333333333333333333333333333333333333333';
  try {
    await saveReferralInvite(identityDir, scopeOf(TEAM_WALLET), encodeInvite(INVITE), REFERRER);
    const bound = new Map<string, string>();
    const applied: Array<{ identity: string | undefined; invite: boolean; clientId: string | undefined }> = [];
    const sync = new BuyerAttributionSync({
      clientAgentId: 5,
      deployment: DEPLOYMENT,
      lookup: async (buyer) => bound.get(buyer) ?? null,
      verify: async (buyer) => bound.get(buyer) ?? null,
      apply: (attribution, identity) => applied.push({ identity, invite: !!attribution.invite, clientId: attribution.clientId }),
    });
    await sync.track(undefined, root, DEFAULT_WALLET);
    await sync.track('team-a', identityDir, TEAM_WALLET);
    assert.deepEqual(applied.map(({ identity, invite }) => [identity, invite]), [[undefined, false], ['team-a', true]]);
    assert.ok(applied.every((entry) => BigInt(entry.clientId!) === 5n));

    // The default wallet's unchanged file is skipped; the carried invite is re-checked every poll.
    applied.length = 0;
    await sync.refreshAll();
    assert.deepEqual(applied.map(({ identity, invite }) => [identity, invite]), [['team-a', true]]);

    bound.set(TEAM_WALLET, REFERRER);
    applied.length = 0;
    await sync.refreshAll();
    assert.deepEqual(applied.map(({ identity, invite }) => [identity, invite]), [['team-a', false]]);
    assert.equal((await readReferralState(identityDir, scopeOf(TEAM_WALLET)))?.state, 'bound');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a tracked wallet carries its saved invite before a slow explorer answers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'antseed-attribution-'));
  const TEAM_WALLET = '0x3333333333333333333333333333333333333333';
  try {
    await saveReferralInvite(root, scopeOf(TEAM_WALLET), encodeInvite(INVITE), REFERRER);
    let answer: (value: string | null) => void = () => {};
    const explorer = new Promise<string | null>((resolve) => { answer = resolve; });
    const applied: boolean[] = [];
    const sync = new BuyerAttributionSync({
      deployment: DEPLOYMENT,
      lookup: () => explorer,
      verify: async () => null,
      apply: (attribution) => applied.push(!!attribution.invite),
    });
    // Resolves while the explorer lookup is still pending.
    await sync.track('team-a', root, TEAM_WALLET);
    assert.deepEqual(applied, [true]);
    answer(null);
    await sync.refreshAll();
    assert.ok(applied.every(Boolean));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('attribution sync keeps a carried invite when only the explorer reports a binding', async () => {
  const root = mkdtempSync(join(tmpdir(), 'antseed-attribution-'));
  try {
    await saveReferralInvite(root, scopeOf('0x2222222222222222222222222222222222222222'), encodeInvite(INVITE), REFERRER);
    const applied: boolean[] = [];
    const sync = new BuyerAttributionSync({
      deployment: DEPLOYMENT,
      lookup: async () => REFERRER,
      verify: async () => '0x0000000000000000000000000000000000000000',
      apply: (attribution) => applied.push(!!attribution.invite),
    });
    await sync.track(undefined, root, '0x2222222222222222222222222222222222222222');
    await sync.refreshAll();
    assert.ok(applied.length >= 2 && applied.every(Boolean));
    assert.equal((await readReferralState(root, scopeOf('0x2222222222222222222222222222222222222222')))?.state, 'invited');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a replacement saved while a poll reads the state is applied by the next poll', async () => {
  const root = mkdtempSync(join(tmpdir(), 'antseed-attribution-'));
  const realStat = fs.promises.stat;
  try {
    await saveReferralInvite(root, scopeOf('0x2222222222222222222222222222222222222222'), encodeInvite(INVITE), REFERRER);
    await clearReferralInvite(root, scopeOf('0x2222222222222222222222222222222222222222'));
    const applied: boolean[] = [];
    const sync = new BuyerAttributionSync({ deployment: DEPLOYMENT, lookup: null, verify: null, apply: (attribution) => applied.push(!!attribution.invite) });
    await sync.track(undefined, root, '0x2222222222222222222222222222222222222222');
    await sync.refreshAll(); // lets the background check started by track settle
    assert.deepEqual(applied, [false]);

    // Another process saves a new invite right as the poll stats the state file.
    let armed = true;
    fs.promises.stat = (async (...args: Parameters<typeof realStat>) => {
      if (armed && String(args[0]).endsWith('referral.json')) {
        armed = false;
        await new Promise((resolve) => setTimeout(resolve, 20));
        await saveReferralInvite(root, scopeOf('0x2222222222222222222222222222222222222222'), encodeInvite({ ...INVITE, index: 8n }), REFERRER);
      }
      return realStat(...args);
    }) as typeof realStat;
    syncBuiltinESMExports();
    await sync.refreshAll(true);
    fs.promises.stat = realStat;
    syncBuiltinESMExports();

    await sync.refreshAll();
    assert.equal(applied.at(-1), true);
  } finally {
    fs.promises.stat = realStat;
    syncBuiltinESMExports();
    rmSync(root, { recursive: true, force: true });
  }
});

test('a different wallet using the same data dir never carries the previous wallet\'s invite', async () => {
  const root = mkdtempSync(join(tmpdir(), 'antseed-attribution-'));
  try {
    await saveReferralInvite(root, scopeOf('0x2222222222222222222222222222222222222222'), encodeInvite(INVITE), REFERRER);
    const applied: boolean[] = [];
    const sync = new BuyerAttributionSync({ deployment: DEPLOYMENT, lookup: null, verify: null, apply: (attribution) => applied.push(!!attribution.invite) });
    await sync.track(undefined, root, '0x5555555555555555555555555555555555555555');
    await sync.refreshAll(true);
    assert.deepEqual(applied, [false, false]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
