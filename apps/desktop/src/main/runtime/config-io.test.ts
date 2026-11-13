import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  DESKTOP_DEFAULT_MAX_INPUT_USD_PER_MILLION,
  DESKTOP_DEFAULT_MAX_OUTPUT_USD_PER_MILLION,
  DESKTOP_DEFAULT_MIN_PEER_REPUTATION,
  DESKTOP_DEFAULT_PEER_REFRESH_INTERVAL_MS,
  DESKTOP_DEFAULT_METADATA_FETCH_TIMEOUT_MS,
  DESKTOP_DEFAULT_SELLER_MAX_CONCURRENT_BUYERS,
  ensureConfig,
  readConfig,
} from './config-io.js';

async function makeTempConfigPath(): Promise<{ dir: string; configPath: string }> {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-desktop-config-'));
  return { dir, configPath: join(dir, 'config.json') };
}

function readBuyerMaxPricing(config: Record<string, unknown>): { input: unknown; output: unknown } {
  const buyer = config.buyer as { maxPricing?: { defaults?: Record<string, unknown> } } | undefined;
  const defaults = buyer?.maxPricing?.defaults ?? {};
  return {
    input: defaults.inputUsdPerMillion,
    output: defaults.outputUsdPerMillion,
  };
}

function readBuyerRoutingPreferences(config: Record<string, unknown>): Record<string, unknown> {
  const buyer = config.buyer as { routingPreferences?: Record<string, unknown> } | undefined;
  return buyer?.routingPreferences ?? {};
}

test('ensureConfig creates config with desktop buyer max pricing defaults', async (t) => {
  const { dir, configPath } = await makeTempConfigPath();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await ensureConfig(configPath);

  const config = await readConfig(configPath);
  const pricing = readBuyerMaxPricing(config);
  assert.equal(pricing.input, DESKTOP_DEFAULT_MAX_INPUT_USD_PER_MILLION);
  assert.equal(pricing.output, DESKTOP_DEFAULT_MAX_OUTPUT_USD_PER_MILLION);
  assert.equal((config.buyer as { minPeerReputation?: number }).minPeerReputation, DESKTOP_DEFAULT_MIN_PEER_REPUTATION);
  assert.equal((config.buyer as { peerRefreshIntervalMs?: number }).peerRefreshIntervalMs, DESKTOP_DEFAULT_PEER_REFRESH_INTERVAL_MS);
  assert.equal((config.buyer as { metadataFetchTimeoutMs?: number }).metadataFetchTimeoutMs, DESKTOP_DEFAULT_METADATA_FETCH_TIMEOUT_MS);
  assert.equal((config.buyer as { disableMetadataV2Services?: boolean }).disableMetadataV2Services, false);
  assert.deepEqual(readBuyerRoutingPreferences(config), {
    preferFreePeers: false,
    maxInputUsdPerMillion: 25,
    minTrustScore: 60,
    allowedPeerIds: [],
    blockedPeerIds: [],
  });
  assert.equal(
    (config.seller as { maxConcurrentBuyers?: number }).maxConcurrentBuyers,
    DESKTOP_DEFAULT_SELLER_MAX_CONCURRENT_BUYERS,
  );
});

test('ensureConfig clamps buyer max pricing above desktop defaults', async (t) => {
  const { dir, configPath } = await makeTempConfigPath();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(configPath, JSON.stringify({
    identity: { displayName: 'Existing User' },
    buyer: {
      proxyPort: 8377,
      minPeerReputation: 50,
      maxPricing: {
        defaults: {
          inputUsdPerMillion: 100,
          outputUsdPerMillion: 100,
        },
      },
    },
  }, null, 2));

  await ensureConfig(configPath);

  const config = await readConfig(configPath);
  const pricing = readBuyerMaxPricing(config);
  assert.equal(pricing.input, DESKTOP_DEFAULT_MAX_INPUT_USD_PER_MILLION);
  assert.equal(pricing.output, DESKTOP_DEFAULT_MAX_OUTPUT_USD_PER_MILLION);
  assert.equal((config.buyer as { minPeerReputation?: number }).minPeerReputation, DESKTOP_DEFAULT_MIN_PEER_REPUTATION);
  assert.equal((config.buyer as { peerRefreshIntervalMs?: number }).peerRefreshIntervalMs, DESKTOP_DEFAULT_PEER_REFRESH_INTERVAL_MS);
  assert.equal((config.identity as { displayName?: string }).displayName, 'Existing User');
});

test('ensureConfig clamps only buyer max pricing values above desktop defaults', async (t) => {
  const { dir, configPath } = await makeTempConfigPath();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(configPath, JSON.stringify({
    buyer: {
      maxPricing: {
        defaults: {
          inputUsdPerMillion: 4,
          outputUsdPerMillion: 90,
        },
      },
    },
  }, null, 2));

  await ensureConfig(configPath);

  const config = await readConfig(configPath);
  const pricing = readBuyerMaxPricing(config);
  assert.equal(pricing.input, 4);
  assert.equal(pricing.output, DESKTOP_DEFAULT_MAX_OUTPUT_USD_PER_MILLION);
});

test('ensureConfig fills missing buyer max pricing defaults for existing configs', async (t) => {
  const { dir, configPath } = await makeTempConfigPath();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(configPath, JSON.stringify({
    identity: { displayName: 'Missing Pricing' },
    buyer: {
      proxyPort: 9123,
      minPeerReputation: 42,
    },
  }, null, 2));

  await ensureConfig(configPath);

  const config = await readConfig(configPath);
  const pricing = readBuyerMaxPricing(config);
  assert.equal(pricing.input, DESKTOP_DEFAULT_MAX_INPUT_USD_PER_MILLION);
  assert.equal(pricing.output, DESKTOP_DEFAULT_MAX_OUTPUT_USD_PER_MILLION);
  assert.equal((config.buyer as { proxyPort?: number }).proxyPort, 9123);
  assert.equal((config.buyer as { minPeerReputation?: number }).minPeerReputation, 42);
  assert.equal((config.buyer as { peerRefreshIntervalMs?: number }).peerRefreshIntervalMs, DESKTOP_DEFAULT_PEER_REFRESH_INTERVAL_MS);
  assert.equal((config.buyer as { disableMetadataV2Services?: boolean }).disableMetadataV2Services, false);
});

test('ensureConfig preserves valid buyer peer refresh interval and metadata v2 setting', async (t) => {
  const { dir, configPath } = await makeTempConfigPath();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(configPath, JSON.stringify({
    buyer: {
      peerRefreshIntervalMs: 30_000,
      metadataFetchTimeoutMs: 2_000,
      disableMetadataV2Services: true,
      maxPricing: {
        defaults: {
          inputUsdPerMillion: 4,
          outputUsdPerMillion: 20,
        },
      },
    },
  }, null, 2));

  await ensureConfig(configPath);

  const config = await readConfig(configPath);
  assert.equal((config.buyer as { peerRefreshIntervalMs?: number }).peerRefreshIntervalMs, 30_000);
  assert.equal((config.buyer as { metadataFetchTimeoutMs?: number }).metadataFetchTimeoutMs, 2_000);
  assert.equal((config.buyer as { disableMetadataV2Services?: boolean }).disableMetadataV2Services, true);
});

test('ensureConfig preserves valid buyer routing preferences', async (t) => {
  const { dir, configPath } = await makeTempConfigPath();
  t.after(() => rm(dir, { recursive: true, force: true }));

  const peerId = 'a'.repeat(40);
  await writeFile(configPath, JSON.stringify({
    buyer: {
      routingPreferences: {
        preferFreePeers: true,
        maxInputUsdPerMillion: 8,
        minTrustScore: 72,
        allowedPeerIds: [peerId],
        blockedPeerIds: [],
      },
    },
  }, null, 2));

  await ensureConfig(configPath);

  const config = await readConfig(configPath);
  assert.deepEqual(readBuyerRoutingPreferences(config), {
    preferFreePeers: true,
    maxInputUsdPerMillion: 8,
    minTrustScore: 72,
    allowedPeerIds: [peerId],
    blockedPeerIds: [],
  });
});

test('ensureConfig preserves buyer max pricing at or below desktop defaults', async (t) => {
  const { dir, configPath } = await makeTempConfigPath();
  t.after(() => rm(dir, { recursive: true, force: true }));

  await writeFile(configPath, JSON.stringify({
    buyer: {
      maxPricing: {
        defaults: {
          inputUsdPerMillion: 4,
          outputUsdPerMillion: 20,
        },
      },
    },
  }, null, 2));

  await ensureConfig(configPath);

  const raw = await readFile(configPath, 'utf-8');
  const config = JSON.parse(raw) as Record<string, unknown>;
  const pricing = readBuyerMaxPricing(config);
  assert.equal(pricing.input, 4);
  assert.equal(pricing.output, 20);
});
