import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultConfig } from '../../../config/defaults.js';
import { resolvePluginPackage } from '../../../plugins/registry.js';
import {
  isDynamicKey,
  redactConfig,
  setConfigValue,
} from './index.js';

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
  const config = createDefaultConfig() as unknown as Record<string, unknown>;
  setConfigValue(config, 'seller.freeTier.maxRequestsPerAddress', '100');
  setConfigValue(config, 'seller.freeTier.maxRequestsPerIp', '300');
  setConfigValue(config, 'seller.freeTier.windowMs', '86400000');
  const seller = config['seller'] as Record<string, unknown>;
  assert.deepEqual(seller['freeTier'], { maxRequestsPerAddress: 100, maxRequestsPerIp: 300, windowMs: 86400000 });
});

test('redactConfig returns a detached clone of the config object', () => {
  const config = createDefaultConfig();
  config.identity.displayName = 'Original';

  const redacted = redactConfig(config);
  (redacted['identity'] as Record<string, unknown>)['displayName'] = 'Mutated';

  assert.equal(config.identity.displayName, 'Original');
});
