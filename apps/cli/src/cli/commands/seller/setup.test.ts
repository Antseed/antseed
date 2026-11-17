import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultConfig } from '../../../config/defaults.js';
import { resolvePluginPackage } from '../../../plugins/registry.js';
import { applySellerSetupRpcUrl, buildSellerSetupProviderEntry, getSellerSetupCredentialHint, parsePriceAnswer, setupCachedPriceProblem } from './setup.js';

test('resolvePluginPackage resolves trusted plugin aliases', () => {
  assert.equal(resolvePluginPackage('openai'), '@antseed/provider-openai');
  assert.equal(resolvePluginPackage('@custom/provider'), '@custom/provider');
});

test('buildSellerSetupProviderEntry builds seller provider config shape', () => {
  const entry = buildSellerSetupProviderEntry({
    plugin: 'openai',
    baseUrl: 'https://api.together.ai',
    inputUsdPerMillion: 1,
    outputUsdPerMillion: 2,
    services: {
      'kimi-k2.5': {
        upstreamModel: 'moonshotai/Kimi-K2.5',
        categories: ['math', 'coding'],
      },
    },
  });

  assert.equal(entry.plugin, 'openai');
  assert.equal(entry.baseUrl, 'https://api.together.ai');
  assert.equal(entry.defaults?.inputUsdPerMillion, 1);
  assert.equal(entry.defaults?.outputUsdPerMillion, 2);
  assert.deepEqual(entry.services['kimi-k2.5']?.categories, ['math', 'coding']);
});

test('getSellerSetupCredentialHint matches the selected plugin', () => {
  assert.equal(getSellerSetupCredentialHint('anthropic'), 'export ANTHROPIC_API_KEY=<key>');
  assert.equal(getSellerSetupCredentialHint('local-llm'), 'start your local LLM runtime (no API key required)');
  assert.equal(getSellerSetupCredentialHint('typesafe'), 'export TYPESAFE_API_KEY=<key>');
});

test('getSellerSetupCredentialHint points openai-responses at the Codex sign-in, not OPENAI_API_KEY', () => {
  assert.equal(getSellerSetupCredentialHint('openai'), 'export OPENAI_API_KEY=<key>');
  assert.equal(getSellerSetupCredentialHint('openai-responses'), 'sign in to Codex on this machine (~/.codex/auth.json)');
});

test('applySellerSetupRpcUrl stores valid custom RPC URLs, ignores blanks, and clears with dash', () => {
  const config = createDefaultConfig();

  applySellerSetupRpcUrl(config, '  ');
  assert.equal(config.payments.crypto?.rpcUrl, undefined);

  applySellerSetupRpcUrl(config, 'https://base.example/rpc');
  assert.equal(config.payments.crypto?.chainId, 'base-mainnet');
  assert.equal(config.payments.crypto?.rpcUrl, 'https://base.example/rpc');

  applySellerSetupRpcUrl(config, '-');
  assert.equal(config.payments.crypto?.chainId, 'base-mainnet');
  assert.equal(config.payments.crypto?.rpcUrl, undefined);
});

test('applySellerSetupRpcUrl rejects invalid custom RPC URLs', () => {
  const config = createDefaultConfig();

  assert.throws(() => applySellerSetupRpcUrl(config, 'not-a-url'), /valid http\(s\) URL/);
  assert.throws(() => applySellerSetupRpcUrl(config, 'ftp://base.example'), /http:\/\/ or https:\/\//);
});

test('seller setup keeps a default cached-input price, even without input and output defaults', () => {
  assert.deepEqual(buildSellerSetupProviderEntry({ plugin: 'openai', inputUsdPerMillion: 1, outputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.1 }).defaults,
    { inputUsdPerMillion: 1, outputUsdPerMillion: 2, cachedInputUsdPerMillion: 0.1 });
  assert.equal(buildSellerSetupProviderEntry({ plugin: 'openai' }).defaults, undefined);
});

test('seller setup asks again for a price that is not a number, or a cached-input price above input', () => {
  assert.equal(parsePriceAnswer(' '), undefined);
  assert.equal(parsePriceAnswer('0.5'), 0.5);
  assert.equal(parsePriceAnswer('0'), 0);
  for (const typo of ['abc', '-1', '1,5', 'Infinity']) assert.equal(parsePriceAnswer(typo), null);
  assert.match(setupCachedPriceProblem(50000, 0.0001) ?? '', /At most the input price \(\$0\.0001\): buyers skip/);
  assert.equal(setupCachedPriceProblem(0.0001, 0.0001), null);
  assert.equal(setupCachedPriceProblem(0.05, 0.5), null);
});
