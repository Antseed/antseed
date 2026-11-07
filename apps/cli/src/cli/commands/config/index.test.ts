import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultConfig } from '../../../config/defaults.js';
import { resolvePluginPackage } from '../../../plugins/registry.js';
import {
  isDynamicKey,
  redactConfig,
  resolveConfigKeyPath,
  setConfigValue,
  setValidatedConfigValue,
} from './index.js';
import { patchValidatedConfig } from '../../../config/patch.js';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('resolvePluginPackage maps trusted plugin aliases to package names', () => {
  assert.equal(resolvePluginPackage('openai'), '@antseed/provider-openai');
  assert.equal(resolvePluginPackage('@custom/provider'), '@custom/provider');
});

test('setConfigValue creates nested seller provider paths for dynamic keys', () => {
  const config = createDefaultConfig() as unknown as Record<string, unknown>;

  setConfigValue(
    config,
    'seller.providers.together.services.kimi-k2_5.pricing.inputUsdPerMillion',
    '0.5',
  );

  const seller = config['seller'] as Record<string, unknown>;
  const providers = seller['providers'] as Record<string, unknown>;
  const together = providers['together'] as Record<string, unknown>;
  const services = together['services'] as Record<string, unknown>;
  const kimi = services['kimi-k2_5'] as Record<string, unknown>;
  const pricing = kimi['pricing'] as Record<string, unknown>;

  assert.equal(pricing['inputUsdPerMillion'], 0.5);
});

test('seller free-tier fields can be created before the optional block exists', () => {
  assert.equal(isDynamicKey('seller.freeTier.maxRequestsPerAddress'), true);
  assert.equal(isDynamicKey('seller.freeTier.maxRequestsPerIp'), true);
  assert.equal(isDynamicKey('seller.freeTier.windowMs'), true);
  assert.equal(isDynamicKey('seller.freeTier.typo'), false);
  assert.equal(isDynamicKey('seller.restrictedCountries'), true);
  const config = createDefaultConfig() as unknown as Record<string, unknown>;
  setConfigValue(config, 'seller.freeTier.maxRequestsPerAddress', '100');
  setConfigValue(config, 'seller.freeTier.maxRequestsPerIp', '300');
  setConfigValue(config, 'seller.freeTier.windowMs', '86400000');
  const seller = config['seller'] as Record<string, unknown>;
  assert.deepEqual(seller['freeTier'], { maxRequestsPerAddress: 100, maxRequestsPerIp: 300, windowMs: 86400000 });
});

test('seller gas settings can be set before their optional blocks exist, booleans included', () => {
  assert.equal(isDynamicKey('seller.gasRefuel.enabled'), true);
  assert.equal(isDynamicKey('seller.gasRefuel.swapUsdc'), true);
  assert.equal(isDynamicKey('seller.gasCheck.enabled'), true);
  const config = createDefaultConfig() as unknown as Record<string, unknown>;
  setConfigValue(config, 'seller.gasRefuel.enabled', 'false');
  setConfigValue(config, 'seller.gasRefuel.swapUsdc', '25');
  const seller = config['seller'] as Record<string, unknown>;
  assert.deepEqual(seller['gasRefuel'], { enabled: false, swapUsdc: 25 });
});

test('redactConfig returns a detached clone of the config object', () => {
  const config = createDefaultConfig();
  config.identity.displayName = 'Original';

  const redacted = redactConfig(config);
  (redacted['identity'] as Record<string, unknown>)['displayName'] = 'Mutated';

  assert.equal(config.identity.displayName, 'Original');
});

test('a malformed numeric edit is refused, leaving the config and its backup alone', async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'config-set-')), 'config.json');
  writeFileSync(path, JSON.stringify({ seller: { maxConcurrentBuyers: 7 } }));
  await patchValidatedConfig(path, (raw) => setValidatedConfigValue(raw, 'seller.maxConcurrentBuyers', '9'));
  const config = readFileSync(path, 'utf-8');
  const backup = readFileSync(`${path}.bak`, 'utf-8');
  for (const value of ['typo', '-3']) {
    await assert.rejects(patchValidatedConfig(path, (raw) => setValidatedConfigValue(raw, 'seller.maxConcurrentBuyers', value)));
  }
  assert.equal(readFileSync(path, 'utf-8'), config);
  assert.equal(readFileSync(`${path}.bak`, 'utf-8'), backup);
  assert.equal(JSON.parse(config).seller.maxConcurrentBuyers, 9);
});

function writeSellerConfig(): string {
  const path = join(mkdtempSync(join(tmpdir(), 'config-set-dotted-')), 'config.json');
  writeFileSync(path, JSON.stringify({
    seller: {
      providers: {
        inference: {
          plugin: 'openai',
          services: {
            'kimi-k2': { pricing: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.2 } },
            'kimi-k2.6': { upstreamModel: 'kimi-k2.6', pricing: { inputUsdPerMillion: 0.6, outputUsdPerMillion: 2.5 } },
            'glm-4.7-flash': {},
          },
        },
      },
    },
  }));
  return path;
}

function readServices(path: string): Record<string, Record<string, unknown>> {
  return JSON.parse(readFileSync(path, 'utf-8')).seller.providers.inference.services;
}

const set = (path: string, key: string, value: string) =>
  patchValidatedConfig(path, (raw) => setValidatedConfigValue(raw, key, value));

test('resolveConfigKeyPath keeps a dotted id together when it names an existing key', () => {
  const config = { services: { 'kimi-k2': {}, 'kimi-k2.6': { pricing: {} } } };
  assert.deepEqual(resolveConfigKeyPath(config, 'services.kimi-k2.6.pricing.inputUsdPerMillion'), ['services', 'kimi-k2.6', 'pricing', 'inputUsdPerMillion']);
  assert.deepEqual(resolveConfigKeyPath(config, 'services.kimi-k2.pricing'), ['services', 'kimi-k2', 'pricing']);
  assert.deepEqual(resolveConfigKeyPath(config, 'services.kimi-k2.6'), ['services', 'kimi-k2.6']);
  assert.deepEqual(resolveConfigKeyPath(config, 'services.new.pricing'), ['services', 'new', 'pricing']);
});

test('set prices a service whose id contains a dot, without adding an entry', async () => {
  const path = writeSellerConfig();
  await set(path, 'seller.providers.inference.services.kimi-k2.6.pricing.inputUsdPerMillion', '0.2');
  await set(path, 'seller.providers.inference.services.glm-4.7-flash.categories', '["coding"]');
  const services = readServices(path);
  assert.deepEqual(Object.keys(services).sort(), ['glm-4.7-flash', 'kimi-k2', 'kimi-k2.6']);
  assert.deepEqual(services['kimi-k2.6']!['pricing'], { inputUsdPerMillion: 0.2, outputUsdPerMillion: 2.5 });
  assert.deepEqual(services['kimi-k2']!['pricing'], { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.2 });
  assert.deepEqual(services['glm-4.7-flash']!['categories'], ['coding']);
});

test('set refuses a provider path that does not resolve to a real field, and leaves the file alone', async () => {
  const path = writeSellerConfig();
  const before = readFileSync(path, 'utf-8');
  const refused: Array<[string, RegExp]> = [
    ['seller.providers.inference.services.kimi-k2.7.pricing.inputUsdPerMillion', /No service of provider "inference" matches "kimi-k2\.7\.pricing\.inputUsdPerMillion".*"7" is not a field of service "kimi-k2"/],
    ['seller.providers.inference.services.qwen-2.5-7b.pricing.inputUsdPerMillion', /No service of provider "inference" matches/],
    ['seller.providers.inference.services.kimi-k2.6.pricing.inputUsdPerMilion', /"inputUsdPerMilion" is not a field of service "kimi-k2\.6"\.pricing/],
    ['seller.providers.inference.services.kimi-k2.6.pricing.input', /"input" is not a field of service "kimi-k2\.6"\.pricing/],
    ['seller.providers.inference.services.kimi-k2.6.price', /No service of provider "inference" matches "kimi-k2\.6\.price".*"price" is not a field of service "kimi-k2\.6"/],
    ['seller.providers.inference.nonsense', /"nonsense" is not a field of provider "inference"/],
    ['seller.providers.missing.baseUrl', /No provider "missing"/],
  ];
  for (const [key, message] of refused) {
    await assert.rejects(set(path, key, '0.2'), message, key);
  }
  assert.equal(readFileSync(path, 'utf-8'), before);
});

test('set still accepts whole provider and service objects and free-form capability fields', async () => {
  const path = writeSellerConfig();
  await set(path, 'seller.providers.inference.services.kimi-k2.6.capabilities.contextWindow', '262144');
  await set(path, 'seller.providers.inference.services.new-model', '{"upstreamModel":"vendor/new-model"}');
  await set(path, 'seller.providers.inference.services.new-model.enabled', 'false');
  await set(path, 'seller.providers.inference.defaults', '{"inputUsdPerMillion":1,"outputUsdPerMillion":2}');
  await set(path, 'seller.providers.inference.defaults.inputUsdPerMillion', '1.5');
  await set(path, 'seller.providers.other', '{"plugin":"openai","services":{}}');
  const services = readServices(path);
  assert.deepEqual(services['kimi-k2.6']!['capabilities'], { contextWindow: 262144 });
  assert.deepEqual(services['new-model'], { upstreamModel: 'vendor/new-model', enabled: false });
  const providers = JSON.parse(readFileSync(path, 'utf-8')).seller.providers;
  assert.deepEqual(providers.inference.defaults, { inputUsdPerMillion: 1.5, outputUsdPerMillion: 2 });
  assert.equal(providers.other.plugin, 'openai');
});
