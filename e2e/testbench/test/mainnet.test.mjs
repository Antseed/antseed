import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertProfilePlatform, assertProfileSecretStore, linkWorktreePlugins, MAINNET_RESERVE_CAP_ENV, MAINNET_WALLET_ENV, prepareMainnetProfile, profileDesktopEnv, profilePaths, profileSecretStore, resolveMainnetWallet, resolveReserveCap, seedProfile, walletAddress } from '../lib/mainnet.mjs';
import { createMainnetApi, isRouteUnavailableError, rankPaidChatModels, tryPaidCandidates } from '../lib/mainnet-run.mjs';
import { chatOnPaidModel } from '../scenarios/mainnet-smoke.mjs';
import { parseArgs } from '../lib/options.mjs';

const KEY = 'ab'.repeat(32);
const repo = fileURLToPath(new URL('../../..', import.meta.url));

describe('mainnet wallet and cap', () => {
  it('requires the wallet env and prefers the shell over .env.local', () => {
    assert.throws(() => resolveMainnetWallet({ env: {}, fileValues: {} }), new RegExp(MAINNET_WALLET_ENV));
    assert.deepEqual(resolveMainnetWallet({ env: {}, fileValues: { [MAINNET_WALLET_ENV]: `0x${KEY.toUpperCase()}` } }), { hex: KEY, source: '.env.local' });
    assert.equal(resolveMainnetWallet({ env: { [MAINNET_WALLET_ENV]: 'cd'.repeat(32) }, fileValues: { [MAINNET_WALLET_ENV]: KEY } }).source, 'shell');
    assert.throws(() => resolveMainnetWallet({ env: { [MAINNET_WALLET_ENV]: 'abc' } }), /64 hex/);
  });

  it('caps the channel reserve at 0.50 USDC by default and refuses more than 5', () => {
    assert.deepEqual(resolveReserveCap({ env: {} }), { usdc: '0.50', micros: 500_000n });
    assert.equal(resolveReserveCap({ env: { [MAINNET_RESERVE_CAP_ENV]: '1.25' } }).micros, 1_250_000n);
    for (const bad of ['0', '5.01', '-1', 'abc', '1.1234567']) {
      assert.throws(() => resolveReserveCap({ env: { [MAINNET_RESERVE_CAP_ENV]: bad } }), /at most 5/, bad);
    }
  });

  it('derives the wallet address', () => {
    assert.match(walletAddress(KEY), /^0x[0-9a-fA-F]{40}$/);
  });
});

describe('mainnet profile', () => {
  it('seeds a capped base-mainnet config and a private identity, keeping desktop settings', async () => {
    const paths = profilePaths(await mkdtemp(join(tmpdir(), 'tb-mainnet-')));
    await seedProfile(paths, { walletHex: KEY, buyerProxyPort: 18999, reserveCapMicros: 500_000n });
    await writeFile(paths.config, JSON.stringify({ ...JSON.parse(await readFile(paths.config, 'utf8')), ui: { theme: 'dark' } }));
    const config = await seedProfile(paths, { walletHex: KEY, buyerProxyPort: 19000, reserveCapMicros: 250_000n });
    assert.equal(config.buyer.proxyPort, 19000);
    assert.equal(config.payments.crypto.chainId, 'base-mainnet');
    assert.equal(config.payments.maxReserveAmountUsdc, '250000');
    assert.equal(config.payments.maxPerRequestUsdc, '250000');
    assert.deepEqual(config.ui, { theme: 'dark' });
    assert.equal((await readFile(paths.identityKey, 'utf8')).trim(), KEY);
    assert.equal((await stat(paths.identityKey)).mode & 0o777, 0o600);
  });

  it('gives the desktop its own HOME and the isolated-profile flag, without secrets', () => {
    const paths = profilePaths('/tb');
    const env = profileDesktopEnv({
      baseEnv: { PATH: '/bin', HOME: '/Users/me', OPENAI_API_KEY: 'sk', BASE_MAINNET_RPC_URL: 'https://x', [MAINNET_WALLET_ENV]: KEY, ANTSEED_SKIP_PLUGIN_UPDATE_CHECK: '1', VITE_DEV_SERVER_URL: 'http://x' },
      paths,
      ports: { renderer: 1, payments: 2, systemProxy: 3, claudeGateway: 4 },
      instance: 'tb-mainnet',
    });
    assert.equal(env.HOME, paths.home);
    assert.equal(env.ANTSEED_DESKTOP_ISOLATED_PROFILE, '1');
    assert.equal(env.ANTSEED_DESKTOP_ATTACH_ONLY, undefined);
    assert.equal(env.ANTSEED_DESKTOP_USER_DATA_DIR, paths.electron);
    assert.equal(env.COREPACK_HOME, '/Users/me/.cache/node/corepack');
    assert.equal(env.COREPACK_ENABLE_DOWNLOAD_PROMPT, '0');
    for (const key of ['OPENAI_API_KEY', 'BASE_MAINNET_RPC_URL', MAINNET_WALLET_ENV, 'ANTSEED_SKIP_PLUGIN_UPDATE_CHECK', 'VITE_DEV_SERVER_URL']) assert.equal(env[key], undefined, key);
  });

  it('refuses the full isolated profile on Windows before preparing anything', async () => {
    assert.throws(() => assertProfilePlatform('win32'), /not supported on Windows: .*USERPROFILE and APPDATA/);
    assert.doesNotThrow(() => assertProfilePlatform('darwin'));
    assert.doesNotThrow(() => assertProfilePlatform('linux'));
    assert.throws(() => profileDesktopEnv({ baseEnv: {}, paths: profilePaths('/tb'), ports: {}, instance: 'x', platform: 'win32' }), /not supported on Windows/);
    const dir = await mkdtemp(join(tmpdir(), 'tb-win-'));
    await assert.rejects(prepareMainnetProfile({ testbenchDir: dir, root: dir, repo: dir, env: { [MAINNET_WALLET_ENV]: KEY }, platform: 'win32' }), /not supported on Windows/);
    assert.deepEqual(await readdir(dir), [], 'no lock, profile or wallet file was written');
  });

  it('keeps an identity.enc from another secret store and says how to re-seed it', async () => {
    assert.equal(profileSecretStore('linux'), 'basic');
    assert.equal(profileSecretStore('darwin'), 'mock-keychain');
    const paths = profilePaths(await mkdtemp(join(tmpdir(), 'tb-store-')));
    assert.equal(assertProfileSecretStore({ paths, previous: null, platform: 'linux' }), 'basic', 'no wallet yet: seeded under the basic store');
    await mkdir(paths.antseed, { recursive: true });
    const encrypted = join(paths.antseed, 'identity.enc');
    await writeFile(encrypted, 'keyring-ciphertext');
    // A Linux profile from before the basic store has no secretStore in profile.json: its wallet is in the keyring.
    assert.throws(() => assertProfileSecretStore({ paths, previous: { address: '0x1' }, platform: 'linux', walletSource: '.env.local' }), (error) => {
      assert.match(error.message, /encrypted with your desktop keyring .*cannot read it\. Nothing was deleted\./);
      assert.match(error.message, new RegExp(`${MAINNET_WALLET_ENV} \\(\\.env\\.local\\)`));
      assert.match(error.message, /mv .*identity\.enc .*identity\.enc\.keyring-backup.* or rerun with --fresh/);
      return true;
    });
    assert.equal(await readFile(encrypted, 'utf8'), 'keyring-ciphertext', 'the old identity is untouched');
    assert.equal(assertProfileSecretStore({ paths, previous: { secretStore: 'basic' }, platform: 'linux' }), 'basic');
    assert.equal(assertProfileSecretStore({ paths, previous: { address: '0x1' }, platform: 'darwin' }), 'mock-keychain', 'macOS profiles always used the mock keychain');
  });
});

describe('ranking the paid chat models for mainnet-smoke', () => {
  const offer = (inputUsdPerMillion, outputUsdPerMillion, extra = {}) => ({ peerId: extra.peerId ?? 'a'.repeat(40), serviceId: 's', inputUsdPerMillion, outputUsdPerMillion, effectiveReputationScore: 80, ...extra });
  const model = (id, peers, extra = {}) => ({ id, name: id, type: 'text', peers, ...extra });
  const two = (input, output) => [offer(input, output, { peerId: 'a'.repeat(40) }), offer(input, output, { peerId: 'b'.repeat(40) })];
  const ids = (models, options) => rankPaidChatModels(models, options).candidates.map((candidate) => candidate.model.id);

  it('ranks models with more than one seller first, then lowest price, then id, and reports price and sellers', () => {
    const models = [model('lone-cheapest', [offer(0.001, 0.001)]), model('pair-dear', two(2, 2)), model('pair-cheap', two(0.5, 1)), model('lone-cheap', [offer(0.1, 0.1)]), model('pair-tie-b', two(1, 1)), model('pair-tie-a', two(1, 1))];
    assert.deepEqual(ids(models), ['pair-cheap', 'pair-tie-a', 'pair-tie-b', 'pair-dear', 'lone-cheapest', 'lone-cheap']);
    const [first] = rankPaidChatModels(models).candidates;
    assert.deepEqual([first.inputUsdPerMillion, first.outputUsdPerMillion, first.sellers], [0.5, 1, 2]);
  });

  it('skips free models, and a model with any free offer or free allowance, since the desktop picks the seller', () => {
    for (const free of [
      model('free', [offer(0, 0)]),
      model('input-free', [offer(0, 1)]),
      model('output-free', [offer(1, 0)]),
      model('mixed', [offer(0.1, 0.1), offer(0, 0)]),
      model('allowance', [offer(0.1, 0.1, { freeTier: { maxRequestsPerAddress: 5 } })]),
    ]) assert.deepEqual(ids([free, model('paid', [offer(5, 5)])]), ['paid'], free.id);
  });

  it('skips unpriced offers and image, video, audio and other non-chat models', () => {
    for (const other of [
      model('unpriced', [{ peerId: 'x', serviceId: 's' }]),
      model('half', [offer(1, undefined)]),
      model('flux', [offer(0.1, 0.1)], { type: 'images' }),
      model('sora', [offer(0.1, 0.1)], { type: 'videos' }),
      model('voice', [offer(0.1, 0.1)], { type: 'speech' }),
      model('picker', [offer(0.1, 0.1)], { type: 'decisions' }),
      model('gpt-image-2', [offer(0.1, 0.1)]),
      model('qwen-audio-turbo', [offer(0.1, 0.1)]),
      model('multi', [offer(0.1, 0.1)], { architecture: { output_modalities: ['text', 'image'] } }),
      model('per-unit', [offer(0.1, 0.1, { unitBillingModels: { images: {} } })]),
    ]) assert.deepEqual(ids([other, model('paid', [offer(5, 5)])]), ['paid'], other.id);
  });

  it('keeps only models the buyer can route to, by the buyer routing rule itself', async () => {
    // The two real refusals: Gemma's only seller is under the default trust floor of 60, and an unscored seller has no trust at all.
    const { isModelRouteEligible, DEFAULT_MODEL_ROUTING_PREFERENCES } = await import(join(repo, 'packages/node/dist/index.js'));
    assert.equal(DEFAULT_MODEL_ROUTING_PREFERENCES.minTrustScore, 60);
    const isRoutable = (candidate) => isModelRouteEligible(candidate, DEFAULT_MODEL_ROUTING_PREFERENCES);
    const models = [
      model('gemma-3-4b', [offer(0.001, 0.001, { effectiveReputationScore: 12 })]),
      model('unscored', [offer(0.001, 0.001, { effectiveReputationScore: null, reputationScore: null, onChainReputationScore: null })]),
      model('trusted', [offer(1, 1, { effectiveReputationScore: 75 })]),
      model('one-of-two', [offer(0.2, 0.2, { peerId: 'a'.repeat(40), effectiveReputationScore: 10 }), offer(2, 2, { peerId: 'b'.repeat(40), effectiveReputationScore: 90 })]),
    ];
    const { candidates } = rankPaidChatModels(models, { isRoutable });
    assert.deepEqual(candidates.map((candidate) => candidate.model.id), ['trusted', 'one-of-two']);
    const [, oneOfTwo] = candidates;
    assert.deepEqual([oneOfTwo.inputUsdPerMillion, oneOfTwo.sellers], [2, 1], 'priced and counted by the seller the buyer can use');
  });

  it('respects the buyer price caps and the 5 USD per million limit, on input and on output', () => {
    const maxPricing = { defaults: { inputUsdPerMillion: 3, outputUsdPerMillion: 3 } };
    assert.deepEqual(ids([model('over-cap', [offer(1, 4)]), model('under', [offer(2, 2)])], { maxPricing }), ['under']);
    assert.deepEqual(ids([model('in', [offer(6, 1)]), model('out', [offer(1, 15)]), model('limit', [offer(5, 5)])]), ['limit']);
    assert.deepEqual(rankPaidChatModels([model('some', [offer(1, 15), offer(2, 2)])]).candidates.map((candidate) => candidate.outputUsdPerMillion), [2], 'an offer over the limit does not count');
  });

  it('with no candidate says why, and never offers a free one', () => {
    const maxPricing = { defaults: { inputUsdPerMillion: 5, outputUsdPerMillion: 5 } };
    const none = rankPaidChatModels([model('free', [offer(0, 0)]), model('offline', []), model('flux', [offer(1, 1)], { type: 'images' }), model('capped', [offer(9, 9)]), model('untrusted', [offer(1, 1, { effectiveReputationScore: 1 })])], { maxPricing, isRoutable: (candidate) => candidate.effectiveReputationScore >= 60 });
    assert.deepEqual(none.candidates, []);
    assert.match(none.reason, /no routable paid chat model among 5 catalog entries \(skipped: 1 notChat, 1 noLiveOffer, 1 freeOrUnpriced, 1 noRoutableSeller, 1 overBuyerCaps, 0 overPriceLimit\)/);
    assert.deepEqual(ids([]), []);
  });

  it('reads the limits the buyer config loads to', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tb-caps-'));
    const config = join(dir, 'config.json');
    await writeFile(config, JSON.stringify({ buyer: { proxyPort: 18999, maxPricing: { defaults: { inputUsdPerMillion: 7, outputUsdPerMillion: 9 } }, routingPreferences: { minTrustScore: 40 } } }));
    const tb = createMainnetApi({ repo, env: {}, instance: 'x', profile: { address: '0x0', paths: { config }, buyerProxyPort: 1 }, reader: { close() {} }, reportDir: dir, eventsPath: join(dir, 'e.jsonl'), capMicros: 1n });
    const limits = await tb.buyerRoutingLimits();
    assert.deepEqual(limits.maxPricing.defaults, { inputUsdPerMillion: 7, outputUsdPerMillion: 9 });
    assert.equal(limits.isRoutable(offer(1, 1, { effectiveReputationScore: 41 })), true);
    assert.equal(limits.isRoutable(offer(1, 1, { effectiveReputationScore: 39 })), false);
    await tb.dispose();
  });
});

describe('trying the paid candidates in mainnet-smoke', () => {
  const candidate = (id) => ({ model: { id } });
  const routeError = (banner) => Object.assign(new Error(`The chat shows an error: ${banner}`), { banner });
  const NOT_FOUND = '502 {"error":{"code":"model_not_found","message":"No policy-allowed peer currently serves model \\"x\\"."}}';

  it('moves on after a routing error on screen and stops at the first success', async () => {
    const tried = [];
    const heard = [];
    const outcome = await tryPaidCandidates([candidate('a'), candidate('b'), candidate('c')], async ({ model }) => {
      tried.push(model.id);
      if (model.id === 'a') throw routeError(NOT_FOUND);
      return `reply from ${model.id}`;
    }, { onAttempt: async (entry) => heard.push(entry) });
    assert.deepEqual(tried, ['a', 'b']);
    assert.equal(outcome.candidate.model.id, 'b');
    assert.equal(outcome.result, 'reply from b');
    assert.deepEqual(outcome.attempts, [{ model: 'a', ok: false, error: NOT_FOUND }, { model: 'b', ok: true }]);
    assert.deepEqual(heard, outcome.attempts);
  });

  it('tries at most three, and when all fail returns no candidate, naming each model and its error', async () => {
    const tried = [];
    const outcome = await tryPaidCandidates(['a', 'b', 'c', 'd'].map(candidate), async ({ model }) => { tried.push(model.id); throw routeError(`503 Service Unavailable for ${model.id}`); });
    assert.deepEqual(tried, ['a', 'b', 'c']);
    assert.equal(outcome.candidate, null, 'a candidate that failed does not count as success');
    assert.deepEqual(outcome.attempts.map((attempt) => [attempt.model, attempt.error]), [['a', '503 Service Unavailable for a'], ['b', '503 Service Unavailable for b'], ['c', '503 Service Unavailable for c']]);
  });

  it('only routing and availability errors move on: anything else ends the run', async () => {
    for (const error of [new Error('No reply matching /PONG/i within 120000ms'), Object.assign(new Error('x'), { banner: '402 insufficient deposit' }), Object.assign(new Error('assert'), { code: 'ERR_ASSERTION' })]) {
      const tried = [];
      await assert.rejects(tryPaidCandidates(['a', 'b'].map(candidate), async ({ model }) => { tried.push(model.id); throw error; }), error);
      assert.deepEqual(tried, ['a'], error.message);
    }
    for (const banner of [NOT_FOUND, 'No policy-allowed peer currently serves model "x".', '502 Bad Gateway', '503 unavailable', '{"code":"model_not_found"}']) assert.equal(isRouteUnavailableError({ banner }), true, banner);
    for (const value of [{ banner: '402 payment required' }, { message: '502' }, null]) assert.equal(isRouteUnavailableError(value), false);
  });

  it('with no candidates tries nothing', async () => {
    assert.deepEqual(await tryPaidCandidates([], async () => assert.fail('no attempt')), { candidate: null, result: null, attempts: [] });
  });
});

describe('chatOnPaidModel (one try in mainnet-smoke)', () => {
  const model = { id: 'qwen-x', name: 'Qwen X', peers: [{ serviceId: 'qwen/x' }] };
  function fakes({ selected = { rowTitle: 'Qwen X', rowText: 'Qwen X', headerLabel: 'Qwen X' }, after = 'Qwen X', send = async () => ({ reply: 'PONG' }) } = {}) {
    const checks = [];
    const tb = { check(name, ok, detail) { checks.push([name, Boolean(ok)]); if (!ok) throw Object.assign(new Error(`${name}: ${JSON.stringify(detail)}`), { code: 'ERR_ASSERTION' }); } };
    const ui = { selectModel: async (options) => { ui.options = options; return selected; }, screenshot: async () => {}, sendChat: send, modelPickerLabel: async () => after };
    return { checks, tb, ui };
  }

  it('selects by name, id and service id, and returns the reply', async () => {
    const { tb, ui, checks } = fakes();
    assert.deepEqual(await chatOnPaidModel(tb, ui, { model }), { reply: 'PONG' });
    assert.deepEqual(ui.options, { search: ['Qwen X', 'qwen-x', 'qwen/x'], label: 'Qwen X' });
    assert.deepEqual(checks.map(([, ok]) => ok), [true, true]);
  });

  it('fails when the desktop answered on another model than the one selected', async () => {
    const { tb, ui } = fakes({ after: 'Ledgerlens' });
    await assert.rejects(chatOnPaidModel(tb, ui, { model }), /the chat ran on the selected model qwen-x.*Ledgerlens/);
  });

  it('fails on a free or failed selection before sending anything', async () => {
    for (const selected of [{ rowTitle: 'Qwen X', headerLabel: 'Qwen X Free' }, { error: 'no row on the Models page' }]) {
      let sent = false;
      const { tb, ui } = fakes({ selected, send: async () => { sent = true; return { reply: 'PONG' }; } });
      await assert.rejects(chatOnPaidModel(tb, ui, { model }), { code: 'ERR_ASSERTION' });
      assert.equal(sent, false);
    }
  });

  it('lets a routing error from the send through to the try-next logic', async () => {
    const banner = '502 model_not_found';
    const { tb, ui } = fakes({ send: async () => { throw Object.assign(new Error('banner'), { banner }); } });
    await assert.rejects(chatOnPaidModel(tb, ui, { model }), (error) => isRouteUnavailableError(error));
  });
});

describe('worktree plugin links', () => {
  it('pins the plugin to worktree versions and never links a whole scope directory', async () => {
    const repo = join(import.meta.dirname, '../../..');
    const pluginsDir = await mkdtemp(join(tmpdir(), 'tb-plugins-'));
    await linkWorktreePlugins(pluginsDir, repo);
    const nodeModules = join(pluginsDir, 'node_modules');
    const plugin = JSON.parse(await readFile(join(nodeModules, '@antseed/router-local/package.json'), 'utf8'));
    const routerCore = JSON.parse(await readFile(join(repo, 'packages/router-core/package.json'), 'utf8'));
    assert.equal(plugin.dependencies['@antseed/router-core'], routerCore.version);
    assert.equal((await lstat(join(nodeModules, '@antseed/router-local'))).isSymbolicLink(), false);
    assert.equal(await readlink(join(nodeModules, '@antseed/node')), join(repo, 'packages/node'));
    assert.equal(await readlink(join(nodeModules, '@antseed/antseed-verifier')), join(repo, 'packages/antseed-verifier'));
    const typesScope = await lstat(join(nodeModules, '@types'));
    assert.equal(typesScope.isSymbolicLink(), false);
    assert.equal(typesScope.isDirectory(), true);
  });
});

describe('mainnet options', () => {
  it('refuses the real network without --real-funds', () => {
    assert.throws(() => parseArgs(['mainnet']), /--real-funds/);
    assert.throws(() => parseArgs(['run', 'mainnet-smoke', '--chain', 'mainnet']), /--real-funds/);
    assert.throws(() => parseArgs(['up', '--chain', 'mainnet', '--real-funds']), /only for pnpm testbench run/);
    assert.equal(parseArgs(['mainnet', '--real-funds', '--dev']).dev, true);
    assert.equal(parseArgs(['run', 'mainnet-smoke', '--chain', 'mainnet', '--real-funds']).chain, 'mainnet');
  });
});
