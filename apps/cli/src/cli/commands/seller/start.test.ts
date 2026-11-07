import assert from 'node:assert/strict';
import test from 'node:test';

test('native video runtime configuration maps each video seller endpoint to its credentials', () => {
  for (const [plugin, prefix, protocol] of [['venice-video', 'VENICE_VIDEO', 'venice-video'], ['fal-video', 'FAL_VIDEO', 'fal-video'], ['alibaba-video', 'ALIBABA_VIDEO', 'fal-video']] as const) {
    const config = createDefaultConfig();
    config.seller.providers = { video: { plugin, baseUrl: 'https://seller.example.test', apiKeyEnv: 'TEST_VIDEO_KEY', services: { model: { unitBillingModels: { [protocol]: { version: 1, components: [{ unit: 'video_seconds', priceUsd: 0.1 }] } } } } } };
    const previous = process.env['TEST_VIDEO_KEY'];
    process.env['TEST_VIDEO_KEY'] = 'seller-key';
    try {
      const env = buildSellerPluginRuntimeEnv(config.seller, 'video');
      assert.equal(env[`${prefix}_BASE_URL`], 'https://seller.example.test');
      assert.equal(env[`${prefix}_API_KEY`], 'seller-key');
      assert.equal(JSON.parse(env['ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON']!).model[protocol].components[0].unit, 'video_seconds');
    } finally {
      if (previous === undefined) delete process.env['TEST_VIDEO_KEY'];
      else process.env['TEST_VIDEO_KEY'] = previous;
    }
  }
});
import { createDefaultConfig } from '../../../config/defaults.js';
import { resolveEffectiveSellerConfig } from '../../../config/effective.js';
import { requireCryptoConfig, resolveBaseRpcUrlOverride } from '../../payment-utils.js';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  announcedPricedServices,
  assertSellerPrerequisites,
  probeRpcUrls,
  resolveSellerPaymentsAfterRpcProbe,
  buildSellerRuntimeOverridesFromFlags,
  buildSellerPluginRuntimeEnv,
  getUnsupportedFallbackUpstreamsWarning,
  getImageEditUnitBillingWarning,
  getUnsupportedUnitBillingWarning,
  isPublicRpcUrl,
  mergeSellerRuntimeEnv,
  parseOptionalNonNegativeIntegerEnv,
  parseOptionalPositiveIntegerEnv,
  restartSupervisor,
  selectSellerProviderNames,
} from './start.js';

test('seller start runtime overrides are runtime-only and win over env/config', () => {
  const config = createDefaultConfig();
  config.seller.reserveFloor = 11;
  config.seller.providers = {
    anthropic: {
      plugin: 'anthropic',
      defaults: { inputUsdPerMillion: 12, outputUsdPerMillion: 18 },
      services: {},
    },
  };
  const beforeResolution = JSON.parse(JSON.stringify(config));

  const env = {
    ANTSEED_SELLER_INPUT_USD_PER_MILLION: '20',
  } as NodeJS.ProcessEnv;

  const overrides = buildSellerRuntimeOverridesFromFlags({
    reserve: 33,
    inputUsdPerMillion: 44,
    outputUsdPerMillion: 55,
  });

  const effective = resolveEffectiveSellerConfig({
    config,
    env,
    sellerOverrides: overrides,
  });

  assert.equal(effective.reserveFloor, 33);
  assert.equal(effective.providers.anthropic?.defaults?.inputUsdPerMillion, 44);
  assert.equal(effective.providers.anthropic?.defaults?.outputUsdPerMillion, 55);
  assert.deepEqual(config, beforeResolution);
});

test('buildSellerPluginRuntimeEnv translates unified config into flat ANTSEED_* keys', () => {
  const config = createDefaultConfig();
  config.seller.maxConcurrentBuyers = 17;
  config.seller.providers = {
    anthropic: {
      plugin: 'anthropic',
      defaults: {
        inputUsdPerMillion: 15,
        outputUsdPerMillion: 35,
        cachedInputUsdPerMillion: 1.5,
      },
      services: {
        'claude-sonnet-4-5-20250929': {
          upstreamModel: 'claude-sonnet-4-5-20250929',
          imageEditModel: 'qwen-edit',
          categories: ['coding', 'chat'],
          pricing: {
            inputUsdPerMillion: 18,
            outputUsdPerMillion: 42,
          },
          capabilities: {
            contextWindow: 200000,
            inputs: ['text', 'image'],
            toolUse: true,
          },
          unitBillingModels: {
            'openai-images': {
              version: 1,
              components: [{ unit: 'output_images', priceUsd: 0.04 }],
            },
          },
        },
        'claude-opus-4-5': {
          upstreamModel: 'anthropic/claude-opus-4-5-20251117',
          categories: ['reasoning'],
        },
      },
    },
  };

  const runtimeEnv = buildSellerPluginRuntimeEnv(config.seller, 'anthropic');

  assert.equal(runtimeEnv['ANTSEED_INPUT_USD_PER_MILLION'], '15');
  assert.equal(runtimeEnv['ANTSEED_OUTPUT_USD_PER_MILLION'], '35');
  assert.equal(runtimeEnv['ANTSEED_CACHED_INPUT_USD_PER_MILLION'], '1.5');
  assert.equal(runtimeEnv['ANTSEED_MAX_CONCURRENCY'], '17');

  // ANTSEED_ALLOWED_SERVICES is derived from the services map keys.
  const allowed = (runtimeEnv['ANTSEED_ALLOWED_SERVICES'] ?? '').split(',').sort();
  assert.deepEqual(allowed, ['claude-opus-4-5', 'claude-sonnet-4-5-20250929']);

  const services = JSON.parse(runtimeEnv['ANTSEED_SERVICE_PRICING_JSON'] ?? '{}') as Record<string, {
    inputUsdPerMillion: number;
    outputUsdPerMillion: number;
  }>;
  assert.equal(services['claude-sonnet-4-5-20250929']?.inputUsdPerMillion, 18);
  assert.equal(services['claude-sonnet-4-5-20250929']?.outputUsdPerMillion, 42);
  assert.equal(services['claude-opus-4-5'], undefined);

  // Categories are intentionally NOT emitted as an env var — plugins don't
  // read them from env. The CLI writes them directly onto
  // `provider.serviceCategories` inside the seed action.
  assert.equal(runtimeEnv['ANTSEED_SERVICE_CATEGORIES_JSON'], undefined);

  const aliases = JSON.parse(runtimeEnv['ANTSEED_SERVICE_ALIAS_MAP_JSON'] ?? '{}') as Record<string, string>;
  assert.equal(aliases['claude-opus-4-5'], 'anthropic/claude-opus-4-5-20251117');
  // When upstream == serviceId, no alias entry is emitted.
  assert.equal(aliases['claude-sonnet-4-5-20250929'], undefined);

  const editModels = JSON.parse(runtimeEnv['ANTSEED_SERVICE_IMAGE_EDIT_MODEL_MAP_JSON'] ?? '{}') as Record<string, string>;
  assert.equal(editModels['claude-sonnet-4-5-20250929'], 'qwen-edit');

  const capabilities = JSON.parse(runtimeEnv['ANTSEED_SERVICE_CAPABILITIES_JSON'] ?? '{}') as Record<string, unknown>;
  assert.deepEqual(capabilities['claude-sonnet-4-5-20250929'], {
    contextWindow: 200000,
    inputs: ['text', 'image'],
    toolUse: true,
  });

  const unitBillingModels = JSON.parse(runtimeEnv['ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON'] ?? '{}') as Record<string, unknown>;
  assert.deepEqual(unitBillingModels['claude-sonnet-4-5-20250929'], {
    'openai-images': {
      version: 1,
      components: [{ unit: 'output_images', priceUsd: 0.04 }],
    },
  });
});

test('buildSellerPluginRuntimeEnv returns bare env when no provider is configured', () => {
  const config = createDefaultConfig();
  config.seller.maxConcurrentBuyers = 7;
  const runtimeEnv = buildSellerPluginRuntimeEnv(config.seller, 'openai');
  assert.equal(runtimeEnv['ANTSEED_INPUT_USD_PER_MILLION'], undefined);
  assert.equal(runtimeEnv['ANTSEED_OUTPUT_USD_PER_MILLION'], undefined);
  assert.equal(runtimeEnv['ANTSEED_ALLOWED_SERVICES'], undefined);
  assert.equal(runtimeEnv['ANTSEED_MAX_CONCURRENCY'], '7');
});

test('getUnsupportedUnitBillingWarning identifies plugins that ignore configured models', () => {
  const provider = {
    plugin: 'anthropic',
    services: {
      'claude-sonnet': {
        unitBillingModels: {
          'openai-images': {
            version: 1 as const,
            components: [{ unit: 'output_images' as const, priceUsd: 0.04 }],
          },
        },
      },
    },
  };

  assert.match(
    getUnsupportedUnitBillingWarning('anthropic', provider, []) ?? '',
    /Provider "anthropic".*ignores unitBillingModels.*claude-sonnet/,
  );
  assert.equal(
    getUnsupportedUnitBillingWarning('openai', provider, [{
      key: 'ANTSEED_SERVICE_UNIT_BILLING_MODELS_JSON',
      label: 'Unit billing',
      type: 'string',
    }]),
    undefined,
  );
});

test('getImageEditUnitBillingWarning identifies edit services without image pricing', () => {
  const provider = {
    plugin: 'openai',
    services: {
      unpriced: { imageEditModel: 'qwen-edit' },
      priced: {
        imageEditModel: 'flux-2-max-edit',
        unitBillingModels: {
          'openai-images': {
            version: 1 as const,
            components: [
              {
                unit: 'output_images' as const,
                priceUsd: 0.04,
              },
            ],
          },
        },
      },
      free: {
        imageEditModel: 'qwen-edit',
        unitBillingModels: {
          'openai-images': { version: 1 as const, components: [] },
        },
      },
    },
  };

  assert.match(
    getImageEditUnitBillingWarning('venice', provider) ?? '',
    /Provider "venice".*unpriced.*shared output_images price/,
  );
  assert.equal(
    getImageEditUnitBillingWarning('venice', {
      ...provider,
      services: {
        priced: provider.services.priced,
        free: provider.services.free,
      },
    }),
    undefined,
  );
});

test('buildSellerPluginRuntimeEnv sets OPENAI_BASE_URL from provider baseUrl', () => {
  const config = createDefaultConfig();
  config.seller.providers = {
    openai: {
      plugin: 'openai',
      baseUrl: 'https://api.together.ai',
      services: {
        'qwen3.5-9b': {},
      },
    },
  };
  const runtimeEnv = buildSellerPluginRuntimeEnv(config.seller, 'openai');
  assert.equal(runtimeEnv['OPENAI_BASE_URL'], 'https://api.together.ai');
});

test('buildSellerPluginRuntimeEnv sets LOCAL_LLM_BASE_URL for local LLM providers', () => {
  const config = createDefaultConfig();
  config.seller.providers = {
    local: {
      plugin: 'local-llm',
      baseUrl: 'http://192.168.1.100:11434',
      services: {
        'qwen3.5-9b': {},
      },
    },
  };
  const runtimeEnv = buildSellerPluginRuntimeEnv(config.seller, 'local');
  assert.equal(runtimeEnv['LOCAL_LLM_BASE_URL'], 'http://192.168.1.100:11434');
  assert.equal(runtimeEnv['OPENAI_BASE_URL'], undefined);
});

test('buildSellerPluginRuntimeEnv maps base URL and API key to TYPESAFE_* for the typesafe plugin', () => {
  const config = createDefaultConfig();
  config.seller.providers = {
    decisions: {
      plugin: 'typesafe',
      baseUrl: 'https://api.example.test',
      apiKeyEnv: 'TEST_DECISIONS_KEY',
      services: {
        'jev-latest': {},
      },
    },
  };
  process.env['TEST_DECISIONS_KEY'] = 'ts-key';
  try {
    const runtimeEnv = buildSellerPluginRuntimeEnv(config.seller, 'decisions');
    assert.equal(runtimeEnv['TYPESAFE_BASE_URL'], 'https://api.example.test');
    assert.equal(runtimeEnv['TYPESAFE_API_KEY'], 'ts-key');
    assert.equal(runtimeEnv['OPENAI_BASE_URL'], undefined);
    assert.equal(runtimeEnv['OPENAI_API_KEY'], undefined);
  } finally {
    delete process.env['TEST_DECISIONS_KEY'];
  }
});

test('assertSellerPrerequisites fails when no services are configured', async () => {
  const config = createDefaultConfig();
  const seller = config.seller;
  await assert.rejects(
    async () =>
      assertSellerPrerequisites({
        dataDir: '/tmp/no-identity-here',
        config,
        effectiveSeller: seller,
        providerNames: ['anthropic'],
        paymentsEnabled: false,
        runtimePricingOverride: false,
        skipChainChecks: true,
      }),
    /seller prerequisites not met/,
  );
});

test('assertSellerPrerequisites fails when pricing override has no providers to apply to', async () => {
  const config = createDefaultConfig();
  const seller = config.seller;
  await assert.rejects(
    async () =>
      assertSellerPrerequisites({
        dataDir: '/tmp/no-identity-here',
        config,
        effectiveSeller: seller,
        providerNames: ['anthropic'],
        paymentsEnabled: false,
        runtimePricingOverride: true,
        skipChainChecks: true,
      }),
    /seller prerequisites not met/,
  );
});

test('assertSellerPrerequisites passes when services are configured and chain checks are skipped', async () => {
  const config = createDefaultConfig();
  config.seller.providers = {
    anthropic: {
      plugin: 'anthropic',
      defaults: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
      services: {
        'claude-sonnet-4-5-20250929': {
          pricing: { inputUsdPerMillion: 3, outputUsdPerMillion: 15 },
        },
      },
    },
  };
  await assertSellerPrerequisites({
    dataDir: '/tmp/no-identity-here',
    config,
    effectiveSeller: config.seller,
    providerNames: ['anthropic'],
    paymentsEnabled: false,
    runtimePricingOverride: false,
    skipChainChecks: true,
  });
});

test('assertSellerPrerequisites fails when any selected provider has no services', async () => {
  const config = createDefaultConfig();
  config.seller.providers = {
    anthropic: {
      plugin: 'anthropic',
      services: {
        'claude-sonnet-4-5-20250929': {},
      },
    },
    together: {
      plugin: 'openai',
      services: {},
    },
  };

  await assert.rejects(
    async () =>
      assertSellerPrerequisites({
        dataDir: '/tmp/no-identity-here',
        config,
        effectiveSeller: config.seller,
        providerNames: ['anthropic', 'together'],
        paymentsEnabled: false,
        runtimePricingOverride: false,
        skipChainChecks: true,
      }),
    /seller prerequisites not met/,
  );
});

test('seller start merge keeps explicit pricing when runtime env also contains pricing and force override is off', () => {
  const merged = mergeSellerRuntimeEnv(
    {
      ANTSEED_INPUT_USD_PER_MILLION: '0.05',
      ANTSEED_OUTPUT_USD_PER_MILLION: '0.1',
    },
    {
      ANTSEED_INPUT_USD_PER_MILLION: '3',
      ANTSEED_OUTPUT_USD_PER_MILLION: '15',
      ANTSEED_MAX_CONCURRENCY: '10',
    },
  );

  assert.equal(merged['ANTSEED_INPUT_USD_PER_MILLION'], '0.05');
  assert.equal(merged['ANTSEED_OUTPUT_USD_PER_MILLION'], '0.1');
  assert.equal(merged['ANTSEED_MAX_CONCURRENCY'], '10');
});

test('parseOptionalPositiveIntegerEnv accepts positive integer env values', () => {
  assert.equal(parseOptionalPositiveIntegerEnv('134217728'), 134217728);
  assert.equal(parseOptionalPositiveIntegerEnv(' 134217728 '), 134217728);
  assert.equal(parseOptionalPositiveIntegerEnv('0'), undefined);
  assert.equal(parseOptionalPositiveIntegerEnv('123abc'), undefined);
  assert.equal(parseOptionalPositiveIntegerEnv('not-a-number'), undefined);
});

test('parseOptionalNonNegativeIntegerEnv accepts 0 and positive integer env values', () => {
  assert.equal(parseOptionalNonNegativeIntegerEnv('0'), 0);
  assert.equal(parseOptionalNonNegativeIntegerEnv(' 1800000 '), 1800000);
  assert.equal(parseOptionalNonNegativeIntegerEnv(undefined), undefined);
  assert.equal(parseOptionalNonNegativeIntegerEnv('-1'), undefined);
  assert.equal(parseOptionalNonNegativeIntegerEnv('30m'), undefined);
});

test('isPublicRpcUrl detects built-in public Base RPC endpoints', () => {
  assert.equal(isPublicRpcUrl('https://base.publicnode.com'), true);
  assert.equal(isPublicRpcUrl('https://base.drpc.org'), true);
  assert.equal(isPublicRpcUrl('https://base.llamarpc.com'), true);
  assert.equal(isPublicRpcUrl('https://mainnet.base.org'), true);
  assert.equal(isPublicRpcUrl('https://sepolia.base.org'), true);
});

test('isPublicRpcUrl matches host only and ignores invalid or dedicated RPC URLs', () => {
  assert.equal(isPublicRpcUrl('https://BASE.PUBLICNODE.COM/path'), true);
  assert.equal(isPublicRpcUrl('https://base.publicnode.com:443'), true);
  assert.equal(isPublicRpcUrl('https://rpc.example.com/base.publicnode.com'), false);
  assert.equal(isPublicRpcUrl('https://dedicated-base-rpc.example'), false);
  assert.equal(isPublicRpcUrl('not a url'), false);
});

test('resolveBaseRpcUrlOverride uses flag before ANTSEED_BASE_RPC_URL', () => {
  const env = {
    ANTSEED_BASE_RPC_URL: 'https://env-rpc.example',
  } as NodeJS.ProcessEnv;

  assert.equal(
    resolveBaseRpcUrlOverride({ flagValue: 'https://flag-rpc.example', env }),
    'https://flag-rpc.example',
  );
  assert.equal(
    resolveBaseRpcUrlOverride({ env }),
    'https://env-rpc.example',
  );
});

test('requireCryptoConfig applies ANTSEED_BASE_RPC_URL over config rpcUrl', () => {
  const config = createDefaultConfig();
  config.payments.crypto = {
    chainId: 'base-mainnet',
    rpcUrl: 'https://configured-rpc.example',
    depositsContractAddress: '0x0000000000000000000000000000000000000001',
    channelsContractAddress: '0x0000000000000000000000000000000000000002',
    usdcContractAddress: '0x0000000000000000000000000000000000000003',
  };

  const crypto = requireCryptoConfig(config, {
    env: { ANTSEED_BASE_RPC_URL: 'https://env-rpc.example' } as NodeJS.ProcessEnv,
  });

  assert.equal(crypto.rpcUrl, 'https://env-rpc.example');
});

test('selectSellerProviderNames defaults to all configured providers', () => {
  const config = createDefaultConfig();
  config.seller.providers = {
    anthropic: { plugin: 'anthropic', services: {} },
    together: { plugin: 'openai', services: {} },
  };

  const selection = selectSellerProviderNames(config.seller);

  assert.deepEqual(selection.selected, ['anthropic', 'together']);
  assert.deepEqual(selection.unknown, []);
});

test('selectSellerProviderNames parses comma-separated provider filters and reports unknown names', () => {
  const config = createDefaultConfig();
  config.seller.providers = {
    anthropic: { plugin: 'anthropic', services: {} },
    together: { plugin: 'openai', services: {} },
  };

  const selection = selectSellerProviderNames(config.seller, 'together, missing');

  assert.deepEqual(selection.selected, ['together', 'missing']);
  assert.deepEqual(selection.unknown, ['missing']);
});

test('buildSellerPluginRuntimeEnv resolves fallback upstream keys and model names', () => {
  const config = createDefaultConfig();
  config.seller.providers = {
    kimi: {
      plugin: 'openai',
      baseUrl: 'https://api.moonshot.example',
      services: { 'kimi-k3.1-pro': { upstreamModel: 'kimi-k3.1-pro' } },
      fallbackUpstreams: [
        {
          baseUrl: 'https://openrouter.example/api',
          apiKeyEnv: 'TEST_FALLBACK_KEY',
          services: { 'kimi-k3.1-pro': { upstreamModel: 'moonshotai/kimi-k3.1-pro' } },
        },
        { baseUrl: 'https://mirror.moonshot.example', pathRewrite: { '/v1/chat/completions': '/v2/chat/completions' } },
      ],
    },
  };
  const previous = process.env['TEST_FALLBACK_KEY'];
  process.env['TEST_FALLBACK_KEY'] = 'fallback-key';
  try {
    const env = buildSellerPluginRuntimeEnv(config.seller, 'kimi');
    assert.deepEqual(JSON.parse(env['ANTSEED_FALLBACK_UPSTREAMS_JSON']!), [
      {
        baseUrl: 'https://openrouter.example/api',
        apiKey: 'fallback-key',
        services: ['kimi-k3.1-pro'],
        serviceAliasMap: { 'kimi-k3.1-pro': 'moonshotai/kimi-k3.1-pro' },
      },
      { baseUrl: 'https://mirror.moonshot.example', pathRewrite: { '/v1/chat/completions': '/v2/chat/completions' } },
    ]);

    delete process.env['TEST_FALLBACK_KEY'];
    assert.throws(
      () => buildSellerPluginRuntimeEnv(config.seller, 'kimi'),
      /fallbackUpstreams\[0\] of provider "kimi" reads its API key from TEST_FALLBACK_KEY, which is not set/,
    );
  } finally {
    if (previous === undefined) delete process.env['TEST_FALLBACK_KEY'];
    else process.env['TEST_FALLBACK_KEY'] = previous;
  }
});

test('buildSellerPluginRuntimeEnv keeps a fallback model name equal to the service id', () => {
  const config = createDefaultConfig();
  config.seller.providers = {
    kimi: {
      plugin: 'openai',
      services: { 'kimi-k3.1-pro': { upstreamModel: 'moonshotai/kimi-k3.1-pro' } },
      fallbackUpstreams: [
        { baseUrl: 'https://api.moonshot.example', services: { 'kimi-k3.1-pro': { upstreamModel: 'kimi-k3.1-pro' } } },
      ],
    },
  };
  const env = buildSellerPluginRuntimeEnv(config.seller, 'kimi');
  assert.deepEqual(JSON.parse(env['ANTSEED_FALLBACK_UPSTREAMS_JSON']!), [
    {
      baseUrl: 'https://api.moonshot.example',
      services: ['kimi-k3.1-pro'],
      serviceAliasMap: { 'kimi-k3.1-pro': 'kimi-k3.1-pro' },
    },
  ]);
});

test('getUnsupportedFallbackUpstreamsWarning flags plugins without fallback support', () => {
  const providerConfig = {
    plugin: 'anthropic',
    services: {},
    fallbackUpstreams: [{ baseUrl: 'https://backup.example' }],
  };
  assert.match(
    getUnsupportedFallbackUpstreamsWarning('claude', providerConfig, [])!,
    /Provider "claude" \(anthropic\) ignores fallbackUpstreams/,
  );
  assert.equal(
    getUnsupportedFallbackUpstreamsWarning('kimi', providerConfig, [{ key: 'ANTSEED_FALLBACK_UPSTREAMS_JSON', label: '', type: 'string', required: false }]),
    undefined,
  );
  assert.equal(getUnsupportedFallbackUpstreamsWarning('kimi', { plugin: 'openai', services: {} }, []), undefined);
});

test('a restart from the dashboard is offered only when a supervisor will start the seller again', () => {
  assert.equal(restartSupervisor({ ANTSEED_SUPERVISED: '1' }, 4321), 'its supervisor')
  assert.equal(restartSupervisor({ KUBERNETES_SERVICE_HOST: '10.0.0.1' }, 1), 'Kubernetes')
  // A shell inside the pod (kubectl exec) is not the container's main process, so nothing would restart it.
  assert.equal(restartSupervisor({ KUBERNETES_SERVICE_HOST: '10.0.0.1' }, 4321), null)
  // A terminal that inherited systemd's INVOCATION_ID is not supervised.
  assert.equal(restartSupervisor({ INVOCATION_ID: 'abc' }, 4321), null)
  assert.equal(restartSupervisor({ ANTSEED_SUPERVISED: '0', KUBERNETES_SERVICE_HOST: '10.0.0.1' }, 1), null)
})

/** A JSON-RPC endpoint that answers eth_chainId after `delaysMs[n]` on its n-th request (the last delay repeats). */
async function slowRpc(delaysMs: number[]): Promise<{ url: string; requests: () => number; close: () => Promise<void> }> {
  let count = 0;
  const server: Server = createServer((req, res) => {
    const delay = delaysMs[Math.min(count, delaysMs.length - 1)]!;
    count += 1;
    req.resume();
    const timer = setTimeout(() => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x2105' }));
    }, delay);
    res.on('close', () => clearTimeout(timer));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    requests: () => count,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }),
  };
}

const fastProbe = { timeoutMs: 100, attempts: 3, retryDelayMs: 10 };

test('probeRpcUrls retries an RPC that is slow at first, instead of giving up after one timeout', async () => {
  const rpc = await slowRpc([300, 300, 0]);
  try {
    assert.equal(await probeRpcUrls([rpc.url], fastProbe), true);
    assert.equal(rpc.requests(), 3);
  } finally {
    await rpc.close();
  }
});

test('probeRpcUrls accepts an answer from a fallback RPC when the primary is too slow', async () => {
  const slow = await slowRpc([5_000]);
  const fallback = await slowRpc([0]);
  try {
    assert.equal(await probeRpcUrls([slow.url, fallback.url], fastProbe), true);
  } finally {
    await slow.close();
    await fallback.close();
  }
});

test('probeRpcUrls reports unreachable after every attempt times out', async () => {
  const rpc = await slowRpc([5_000]);
  try {
    const started = Date.now();
    assert.equal(await probeRpcUrls([rpc.url], fastProbe), false);
    assert.equal(rpc.requests(), 3);
    assert.ok(Date.now() - started < 2_000);
  } finally {
    await rpc.close();
  }
});

test('an unreachable RPC keeps payments on for a priced seller and turns them off only for a free one', async () => {
  const down = async () => false;
  const base = { paymentsEnabled: true, settlementEnv: null, rpcUrls: ['http://10.255.255.1:8545'], probe: down };
  assert.deepEqual(
    await resolveSellerPaymentsAfterRpcProbe({ ...base, pricedServiceIds: ['kimi-k2.6'] }),
    { paymentsEnabled: true, rpcReachable: false },
  );
  assert.deepEqual(
    await resolveSellerPaymentsAfterRpcProbe({ ...base, pricedServiceIds: [] }),
    { paymentsEnabled: false, rpcReachable: false },
  );
  // ANTSEED_ENABLE_SETTLEMENT decides on its own, without probing.
  let probed = false;
  const probe = async () => { probed = true; return false; };
  assert.deepEqual(
    await resolveSellerPaymentsAfterRpcProbe({ ...base, probe, settlementEnv: true, pricedServiceIds: ['kimi-k2.6'] }),
    { paymentsEnabled: true, rpcReachable: null },
  );
  assert.deepEqual(
    await resolveSellerPaymentsAfterRpcProbe({ ...base, probe, paymentsEnabled: false, settlementEnv: false, pricedServiceIds: ['kimi-k2.6'] }),
    { paymentsEnabled: false, rpcReachable: null },
  );
  assert.equal(probed, false);
  assert.deepEqual(
    await resolveSellerPaymentsAfterRpcProbe({ ...base, probe: async () => true, pricedServiceIds: [] }),
    { paymentsEnabled: true, rpcReachable: true },
  );
});

test('announcedPricedServices counts a price the plugin applies on its own', () => {
  const config = createDefaultConfig();
  config.seller.providers = {
    inference: { plugin: 'openai', services: { 'kimi-k2.6': { pricing: { inputUsdPerMillion: 0.6, outputUsdPerMillion: 2.5 } }, free: {} } },
    other: { plugin: 'openai', services: { 'plugin-default': {} } },
  };
  const zero = { inputUsdPerMillion: 0, outputUsdPerMillion: 0 };
  assert.deepEqual(
    announcedPricedServices(config.seller, ['inference', 'other'], [
      { services: ['kimi-k2.6', 'free'], pricing: { defaults: zero, services: { 'kimi-k2.6': { inputUsdPerMillion: 0.6, outputUsdPerMillion: 2.5 }, free: zero } } },
      { services: ['plugin-default'], pricing: { defaults: { inputUsdPerMillion: 10, outputUsdPerMillion: 10 } } },
    ]).sort(),
    ['kimi-k2.6', 'plugin-default'],
  );
  assert.deepEqual(announcedPricedServices(config.seller, ['inference'], [{ services: ['free'], pricing: { defaults: zero } }]), ['kimi-k2.6']);
});

test('assertSellerPrerequisites refuses a priced seller whose RPC did not answer, unless chain checks are skipped', async () => {
  const config = createDefaultConfig();
  config.seller.providers = {
    inference: { plugin: 'openai', services: { 'kimi-k2.6': { pricing: { inputUsdPerMillion: 0.6, outputUsdPerMillion: 2.5 } } } },
  };
  const input = {
    dataDir: '/tmp/no-identity-here',
    config,
    effectiveSeller: config.seller,
    providerNames: ['inference'],
    paymentsEnabled: true,
    runtimePricingOverride: false,
    skipChainChecks: false,
    unreachableRpc: { urls: ['http://10.255.255.1:8545'], pricedServiceIds: ['kimi-k2.6'] },
  };
  const errors: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
  try {
    await assert.rejects(assertSellerPrerequisites(input), /seller prerequisites not met/);
  } finally {
    console.error = originalError;
  }
  const output = errors.join('\n');
  assert.match(output, /Base RPC unreachable/);
  assert.match(output, /http:\/\/10\.255\.255\.1:8545/);
  assert.match(output, /kimi-k2\.6/);
  assert.match(output, /ANTSEED_ENABLE_SETTLEMENT=false/);
  await assertSellerPrerequisites({ ...input, skipChainChecks: true });
});

test('a plugin unit price with zero token defaults and no config pricing keeps payments on and fails the prerequisites when the RPC is down', async () => {
  const config = createDefaultConfig();
  // provider-irp-router: zero token defaults, IRP_ROUTER_PRICE_USD as a completed_requests price, no pricing in config.
  config.seller.providers = { router: { plugin: 'irp-router', services: { 'irp-router': {} } } };
  const zero = { inputUsdPerMillion: 0, outputUsdPerMillion: 0 };
  const pricedServiceIds = announcedPricedServices(config.seller, ['router'], [{
    services: ['irp-router'],
    pricing: { defaults: zero },
    serviceUnitBillingModels: { 'irp-router': { 'irp-suggest': { version: 1, components: [{ unit: 'completed_requests', priceUsd: 0.001 }] } } },
  }]);
  assert.deepEqual(pricedServiceIds, ['irp-router']);
  // The same plugin at $0 is free.
  assert.deepEqual(announcedPricedServices(config.seller, ['router'], [{
    services: ['irp-router'],
    pricing: { defaults: zero },
    serviceUnitBillingModels: { 'irp-router': { 'irp-suggest': { version: 1, components: [{ unit: 'completed_requests', priceUsd: 0 }] } } },
  }]), []);

  const rpcUrls = ['http://10.255.255.1:8545'];
  const decision = await resolveSellerPaymentsAfterRpcProbe({
    paymentsEnabled: true, settlementEnv: null, rpcUrls, pricedServiceIds, probe: async () => false,
  });
  assert.deepEqual(decision, { paymentsEnabled: true, rpcReachable: false });
  const originalError = console.error;
  const errors: string[] = [];
  console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
  try {
    await assert.rejects(assertSellerPrerequisites({
      dataDir: '/tmp/no-identity-here',
      config,
      effectiveSeller: config.seller,
      providerNames: ['router'],
      paymentsEnabled: decision.paymentsEnabled,
      runtimePricingOverride: false,
      skipChainChecks: false,
      unreachableRpc: { urls: rpcUrls, pricedServiceIds },
    }), /seller prerequisites not met/);
  } finally {
    console.error = originalError;
  }
  assert.match(errors.join('\n'), /Base RPC unreachable[\s\S]*irp-router/);
});

test('announcedPricedServices counts unit prices set in the seller config (image, video, speech)', () => {
  const config = createDefaultConfig();
  config.seller.providers = {
    media: {
      plugin: 'openai',
      services: {
        'qwen-image': { unitBillingModels: { 'openai-images': { version: 1, components: [{ unit: 'output_images', priceUsd: 0.02 }] } } },
        'free-image': { unitBillingModels: { 'openai-images': { version: 1, components: [{ unit: 'output_images', priceUsd: 0 }] } } },
      },
    },
  };
  const zero = { inputUsdPerMillion: 0, outputUsdPerMillion: 0 };
  assert.deepEqual(
    announcedPricedServices(config.seller, ['media'], [{ services: ['qwen-image', 'free-image'], pricing: { defaults: zero } }]),
    ['qwen-image'],
  );
});
