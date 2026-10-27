import assert from 'node:assert/strict';
import test from 'node:test';
import { createDefaultConfig } from './defaults.js';
import {
  buyerSettingOverrides,
  dropDisabledServices,
  resolveEffectiveBuyerConfig,
  resolveEffectiveRoleConfig,
  resolveEffectiveSellerConfig,
  pricedSellerServices,
  resolveSellerFreeTier,
} from './effective.js';

test('effective seller config precedence is flags > env > config > defaults', () => {
  const config = createDefaultConfig();
  config.seller.providers = {
    openai: {
      plugin: 'openai',
      defaults: { inputUsdPerMillion: 10, outputUsdPerMillion: 20 },
      services: {
        'gpt-4': {
          pricing: { inputUsdPerMillion: 15, outputUsdPerMillion: 25 },
        },
      },
    },
  };

  const env = {
    ANTSEED_SELLER_INPUT_USD_PER_MILLION: '30',
    ANTSEED_SELLER_OUTPUT_USD_PER_MILLION: '40',
  } as NodeJS.ProcessEnv;

  const effective = resolveEffectiveSellerConfig({
    config,
    env,
    sellerOverrides: {
      inputUsdPerMillion: 50,
    },
  });

  // Global overrides shift provider defaults, leaving service-specific entries alone.
  assert.equal(effective.providers.openai?.defaults?.inputUsdPerMillion, 50);
  assert.equal(effective.providers.openai?.defaults?.outputUsdPerMillion, 40);
  assert.equal(effective.providers.openai?.services['gpt-4']?.pricing?.inputUsdPerMillion, 15);
  assert.equal(effective.providers.openai?.services['gpt-4']?.pricing?.outputUsdPerMillion, 25);
});

test('effective buyer config precedence is flags > env > config > defaults', () => {
  const config = createDefaultConfig();
  config.buyer.minPeerReputation = 25;
  config.buyer.peerRefreshIntervalMs = 120_000;
  config.buyer.metadataFetchTimeoutMs = 1_200;
  config.buyer.disableMetadataV2Services = false;
  config.buyer.maxPricing.defaults.inputUsdPerMillion = 70;
  config.buyer.maxPricing.defaults.outputUsdPerMillion = 80;

  const env = {
    ANTSEED_BUYER_MIN_REPUTATION: '45',
    ANTSEED_BUYER_MAX_INPUT_USD_PER_MILLION: '90',
    ANTSEED_BUYER_MAX_OUTPUT_USD_PER_MILLION: '95',
    ANTSEED_BUYER_METADATA_FETCH_TIMEOUT_MS: '2200',
    ANTSEED_BUYER_DISABLE_METADATA_V2_SERVICES: 'true',
  } as NodeJS.ProcessEnv;

  const effective = resolveEffectiveBuyerConfig({
    config,
    env,
    buyerOverrides: {
      minPeerReputation: 55,
      maxOutputUsdPerMillion: 99,
    },
  });

  assert.equal(effective.minPeerReputation, 55);
  assert.equal(effective.peerRefreshIntervalMs, 120_000);
  assert.equal(effective.metadataFetchTimeoutMs, 2200);
  assert.equal(effective.disableMetadataV2Services, true);
  assert.equal(effective.maxPricing.defaults.inputUsdPerMillion, 90);
  assert.equal(effective.maxPricing.defaults.outputUsdPerMillion, 99);
});

test('effective buyer config rejects invalid metadata v2 opt-out env overrides', () => {
  const config = createDefaultConfig();

  assert.throws(
    () => resolveEffectiveBuyerConfig({
      config,
      env: { ANTSEED_BUYER_DISABLE_METADATA_V2_SERVICES: 'maybe' } as NodeJS.ProcessEnv,
    }),
    /ANTSEED_BUYER_DISABLE_METADATA_V2_SERVICES must be a boolean/,
  );
});

test('effective buyer config rejects invalid metadata fetch timeout env overrides', () => {
  const config = createDefaultConfig();

  assert.throws(
    () => resolveEffectiveBuyerConfig({
      config,
      env: { ANTSEED_BUYER_METADATA_FETCH_TIMEOUT_MS: '99' } as NodeJS.ProcessEnv,
    }),
    /buyer\.metadataFetchTimeoutMs must be an integer >= 100/,
  );

  assert.throws(
    () => resolveEffectiveBuyerConfig({
      config,
      env: { ANTSEED_BUYER_METADATA_FETCH_TIMEOUT_MS: 'not-a-number' } as NodeJS.ProcessEnv,
    }),
    /ANTSEED_BUYER_METADATA_FETCH_TIMEOUT_MS must be a finite number/,
  );
});

test('effective config resolution does not mutate loaded config', () => {
  const config = createDefaultConfig();
  config.seller.providers = {
    openai: {
      plugin: 'openai',
      defaults: { inputUsdPerMillion: 10, outputUsdPerMillion: 20 },
      services: {},
    },
  };
  const original = JSON.parse(JSON.stringify(config));

  const env = {
    ANTSEED_BUYER_MAX_INPUT_USD_PER_MILLION: '123',
  } as NodeJS.ProcessEnv;

  const effective = resolveEffectiveRoleConfig({
    config,
    env,
    sellerOverrides: {
      outputUsdPerMillion: 44,
    },
  });

  assert.equal(effective.buyer.maxPricing.defaults.inputUsdPerMillion, 123);
  assert.equal(effective.seller.providers.openai?.defaults?.outputUsdPerMillion, 44);
  assert.deepEqual(config, original);
});

test('buyerSettingOverrides names the settings env and flags take over', () => {
  assert.deepEqual(buyerSettingOverrides({ env: {} }), []);
  assert.deepEqual(
    buyerSettingOverrides({
      env: { ANTSEED_BUYER_MAX_INPUT_USD_PER_MILLION: '3', ANTSEED_BASE_RPC_URL: 'https://rpc.example', ANTSEED_BUYER_MAX_STREAM_DURATION_MS: '5' },
      buyerOverrides: { proxyPort: 9000, metadataFetchTimeoutMs: 500 },
      verifierFlags: true,
    }).sort(),
    ['maxPricing.inputUsdPerMillion', 'network.maxStreamDurationMs', 'network.metadataFetchTimeoutMs', 'payments.rpcUrl', 'proxyPort', 'verifier'],
  );
});

test('resolveSellerFreeTier merges the seller-wide program with the selected providers’ service programs', () => {
  const config = createDefaultConfig();
  delete config.seller.freeTier;
  const own = { maxRequestsPerAddress: 5, stakersOnly: true };
  config.seller.providers = {
    a: { plugin: 'openai', services: { 'free-model': { freeTier: own }, plain: {} } },
    b: { plugin: 'openai', services: { 'other-model': { freeTier: { maxRequestsPerIp: 1 } } } },
  };
  assert.deepEqual(resolveSellerFreeTier(config.seller, ['a']), { services: { 'free-model': own } });
  assert.equal(resolveSellerFreeTier(config.seller, []), undefined);
  config.seller.freeTier = { maxRequestsPerAddress: 100 };
  assert.deepEqual(resolveSellerFreeTier(config.seller, ['a', 'b']), {
    maxRequestsPerAddress: 100,
    services: { 'free-model': own, 'other-model': { maxRequestsPerIp: 1 } },
  });
  assert.deepEqual(resolveSellerFreeTier(config.seller, []), { maxRequestsPerAddress: 100 });
});

test('pricedSellerServices lists services that charge, by their own pricing or the provider default', () => {
  const config = createDefaultConfig();
  const free = { inputUsdPerMillion: 0, outputUsdPerMillion: 0 };
  config.seller.providers = {
    a: {
      plugin: 'openai',
      defaults: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
      services: {
        k3: {},
        'free-model': { pricing: free },
      },
    },
    b: {
      plugin: 'openai',
      defaults: free,
      services: {
        'flash-5.3': { pricing: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0 } },
        other: {},
        'paid-image': { pricing: free, unitBillingModels: { 'openai-images': { version: 1, components: [{ unit: 'output_images', priceUsd: 0.02 }] } } },
      },
    },
  };
  assert.deepEqual(pricedSellerServices(config.seller, ['a', 'b']).sort(), ['flash-5.3', 'k3', 'paid-image']);
  assert.deepEqual(pricedSellerServices(config.seller, ['b']), ['flash-5.3', 'paid-image']);
});

test('models turned off are not offered, and a provider with every model off is not started', () => {
  const seller = { providers: {
    a: { plugin: 'openai', services: { one: {}, two: { enabled: false } } },
    b: { plugin: 'openai', services: { three: { enabled: false } } },
  } } as unknown as Parameters<typeof dropDisabledServices>[0]
  assert.deepEqual(dropDisabledServices(seller, ['a', 'b']), { off: ['a/two', 'b/three'], emptyProviders: ['b'] })
  assert.deepEqual(Object.keys(seller.providers['a']!.services), ['one'])
})
