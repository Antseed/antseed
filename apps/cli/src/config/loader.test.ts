import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEFAULT_BUYER_MAX_STREAM_DURATION_MS,
  DEFAULT_BUYER_METADATA_FETCH_TIMEOUT_MS,
  DEFAULT_BUYER_PEER_REFRESH_INTERVAL_MS,
  DEFAULT_BUYER_REQUEST_TIMEOUT_MS,
} from './defaults.js';
import { configFromObject, loadConfig, saveConfig } from './loader.js';
import { createDefaultConfig } from './defaults.js';
import { deriveDisplayNameFromPeerId, shouldDeriveDisplayName } from './identity-display-name.js';

async function withTempConfig(contents: string, fn: (configPath: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-cli-config-'));
  const configPath = join(dir, 'config.json');
  try {
    await writeFile(configPath, contents, 'utf-8');
    await fn(configPath);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test('deriveDisplayNameFromPeerId returns deterministic peer-specific names', () => {
  const peerId = '1234567890abcdef1234567890abcdef12345678';

  assert.equal(deriveDisplayNameFromPeerId(peerId), deriveDisplayNameFromPeerId(peerId));
  assert.match(deriveDisplayNameFromPeerId(peerId), /^antseed-[a-z]+-[a-z]+-[0-9a-f]{4}$/);
  assert.notEqual(deriveDisplayNameFromPeerId(peerId), deriveDisplayNameFromPeerId('abcdef1234567890abcdef1234567890abcdef12'));
  assert.equal(shouldDeriveDisplayName('Antseed Node'), true);
  assert.equal(shouldDeriveDisplayName('custom seller'), false);
});

test('createDefaultConfig includes a Base mainnet crypto payment default', () => {
  const config = createDefaultConfig();

  assert.deepEqual(config.payments.crypto, { chainId: 'base-mainnet' });
  assert.equal(config.verifier?.referenceMaxConcurrentRequests, 4);
  assert.equal(config.verifier?.referenceMaxConcurrentRequestsPerModel, 3);
  assert.equal(config.verifier?.referenceMinimumProbeCount, 100);
  assert.equal(config.verifier?.referenceMaximumProbeCount, 500);
  assert.equal(config.verifier?.referenceProbeStep, 10);
  assert.equal(config.verifier?.referenceMinimumStatisticalPower, 0.9);
  assert.equal(config.verifier?.responseAuthWaitTimeoutMs, 35_000);
  assert.equal(config.verifier?.auditPeerTimeoutMs, 600_000);
  assert.deepEqual(config.verifier?.contrastSelection, {
    inputWeight: 0.9,
    maxPriceRatio: 0.3,
    maxModels: 3,
  });
});

test('loadConfig preserves the verification contract address', async () => {
  const verificationContractAddress = '0x' + '12'.repeat(20);
  await withTempConfig(
    JSON.stringify({
      payments: {
        crypto: {
          chainId: 'base-mainnet',
          verificationContractAddress,
        },
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.equal(config.payments.crypto?.verificationContractAddress, verificationContractAddress);
    },
  );
});

test('createDefaultConfig uses a higher seller concurrency default', () => {
  const config = createDefaultConfig();

  assert.equal(config.seller.maxConcurrentBuyers, 50);
});

test('createDefaultConfig includes shared model routing preferences', () => {
  const config = createDefaultConfig();

  assert.deepEqual(config.buyer.routingPreferences, {
    preferFreePeers: false,
    maxInputUsdPerMillion: 25,
    minTrustScore: 60,
    allowedPeerIds: [],
    blockedPeerIds: [],
  });
});

test('loadConfig merges partial model routing preferences with defaults', async () => {
  await withTempConfig(
    JSON.stringify({
      buyer: {
        routingPreferences: {
          preferFreePeers: true,
          allowedPeerIds: ['0x' + 'a'.repeat(40)],
        },
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.deepEqual(config.buyer.routingPreferences, {
        preferFreePeers: true,
        maxInputUsdPerMillion: 25,
        minTrustScore: 60,
        allowedPeerIds: ['0x' + 'a'.repeat(40)],
        blockedPeerIds: [],
      });
    },
  );
});

test('loadConfig rejects invalid model routing peer ids', async () => {
  await withTempConfig(
    JSON.stringify({ buyer: { routingPreferences: { blockedPeerIds: ['not-a-peer'] } } }),
    async (configPath) => {
      await assert.rejects(
        () => loadConfig(configPath),
        /buyer\.routingPreferences\.blockedPeerIds/,
      );
    },
  );
});

test('loadConfig reads nested seller.providers[name].services[id] shape', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        providers: {
          anthropic: {
            plugin: 'anthropic',
            defaults: { inputUsdPerMillion: 5, outputUsdPerMillion: 10 },
            services: {
              'claude-sonnet-4-5-20250929': {
                upstreamModel: 'claude-sonnet-4-5-20250929',
                categories: ['coding', 'chat'],
                pricing: {
                  inputUsdPerMillion: 12,
                  outputUsdPerMillion: 18,
                  cachedInputUsdPerMillion: 1.5,
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
            },
          },
        },
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      const anthropic = config.seller.providers['anthropic'];
      assert.ok(anthropic);
      assert.equal(anthropic.defaults?.inputUsdPerMillion, 5);
      assert.equal(anthropic.defaults?.outputUsdPerMillion, 10);
      const service = anthropic.services['claude-sonnet-4-5-20250929'];
      assert.ok(service);
      assert.equal(service.upstreamModel, 'claude-sonnet-4-5-20250929');
      assert.deepEqual(service.categories, ['coding', 'chat']);
      assert.equal(service.pricing?.inputUsdPerMillion, 12);
      assert.equal(service.pricing?.outputUsdPerMillion, 18);
      assert.equal(service.pricing?.cachedInputUsdPerMillion, 1.5);
      assert.deepEqual(service.capabilities, {
        contextWindow: 200000,
        inputs: ['text', 'image'],
        toolUse: true,
      });
      assert.equal(service.unitBillingModels?.['openai-images']?.components[0]?.priceUsd, 0.04);
    }
  );
});

test('loadConfig rejects invalid per-service capabilities', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        providers: {
          openai: {
            plugin: 'openai',
            services: {
              'gpt-invalid': { capabilities: { contextWindow: -1 } },
            },
          },
        },
      },
    }),
    async (configPath) => {
      await assert.rejects(() => loadConfig(configPath), /capabilities.*contextWindow must be a positive integer/);
    },
  );
});

test('loadConfig reads provider fallbackUpstreams', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        providers: {
          kimi: {
            plugin: 'openai',
            baseUrl: 'https://api.moonshot.example',
            services: { 'kimi-k3.1-pro': {}, 'kimi-k3': {} },
            fallbackUpstreams: [
              {
                baseUrl: 'https://openrouter.example/api',
                apiKeyEnv: 'OPENROUTER_API_KEY',
                services: { 'kimi-k3.1-pro': { upstreamModel: 'moonshotai/kimi-k3.1-pro' } },
              },
              { baseUrl: 'https://mirror.moonshot.example' },
            ],
          },
        },
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.deepEqual(config.seller.providers['kimi']?.fallbackUpstreams, [
        {
          baseUrl: 'https://openrouter.example/api',
          apiKeyEnv: 'OPENROUTER_API_KEY',
          services: { 'kimi-k3.1-pro': { upstreamModel: 'moonshotai/kimi-k3.1-pro' } },
        },
        { baseUrl: 'https://mirror.moonshot.example' },
      ]);
    },
  );
});

test('loadConfig rejects invalid fallbackUpstreams', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        providers: {
          kimi: {
            plugin: 'openai',
            services: { 'kimi-k3.1-pro': {} },
            fallbackUpstreams: [
              { services: { 'kimi-k3.1-pro': {} } },
              { baseUrl: 'https://openrouter.example/api', services: { 'glm-5': {} } },
            ],
          },
        },
      },
    }),
    async (configPath) => {
      await assert.rejects(
        () => loadConfig(configPath),
        (err: Error) => {
          assert.match(err.message, /fallbackUpstreams\[0\]\.baseUrl must be an http\(s\) URL/);
          assert.match(err.message, /fallbackUpstreams\[1\]\.services\.glm-5 is not a service of this provider/);
          return true;
        },
      );
    },
  );
});

test('loadConfig treats legacy buyer minPeerReputation 50 as the new default', async () => {
  await withTempConfig(
    JSON.stringify({
      buyer: {
        minPeerReputation: 50,
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.equal(config.buyer.minPeerReputation, 0);
    }
  );
});

test('loadConfig applies the default buyer peer refresh interval when missing', async () => {
  await withTempConfig(
    JSON.stringify({
      buyer: {
        proxyPort: 9123,
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.equal(config.buyer.peerRefreshIntervalMs, DEFAULT_BUYER_PEER_REFRESH_INTERVAL_MS);
      assert.equal(config.buyer.metadataFetchTimeoutMs, DEFAULT_BUYER_METADATA_FETCH_TIMEOUT_MS);
      assert.equal(config.buyer.requestTimeoutMs, DEFAULT_BUYER_REQUEST_TIMEOUT_MS);
      assert.equal(config.buyer.maxStreamDurationMs, DEFAULT_BUYER_MAX_STREAM_DURATION_MS);
    }
  );
});

test('loadConfig preserves explicit buyer discovery and request timeouts', async () => {
  await withTempConfig(
    JSON.stringify({
      buyer: {
        peerRefreshIntervalMs: 15_000,
        metadataFetchTimeoutMs: 2_500,
        requestTimeoutMs: 600_000,
        maxStreamDurationMs: 900_000,
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.equal(config.buyer.peerRefreshIntervalMs, 15_000);
      assert.equal(config.buyer.metadataFetchTimeoutMs, 2_500);
      assert.equal(config.buyer.requestTimeoutMs, 600_000);
      assert.equal(config.buyer.maxStreamDurationMs, 900_000);
    }
  );
});

test('loadConfig defaults and preserves buyer metadata v2 service opt-out setting', async () => {
  await withTempConfig(
    JSON.stringify({
      buyer: {
        proxyPort: 9123,
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.equal(config.buyer.disableMetadataV2Services, false);
    }
  );

  await withTempConfig(
    JSON.stringify({
      buyer: {
        disableMetadataV2Services: true,
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.equal(config.buyer.disableMetadataV2Services, true);
    }
  );
});

test('loadConfig defaults buyer autoSweep on and preserves an explicit false', async () => {
  await withTempConfig(
    JSON.stringify({
      buyer: {
        proxyPort: 9123,
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.equal(config.buyer.autoSweep, true);
    }
  );

  await withTempConfig(
    JSON.stringify({
      buyer: {
        autoSweep: false,
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.equal(config.buyer.autoSweep, false);
    }
  );
});

test('loadConfig rejects invalid buyer disableMetadataV2Services', async () => {
  await withTempConfig(
    JSON.stringify({
      buyer: {
        disableMetadataV2Services: 'false',
      },
    }),
    async (configPath) => {
      await assert.rejects(
        async () => loadConfig(configPath),
        /buyer\.disableMetadataV2Services/
      );
    }
  );
});

test('loadConfig preserves buyer verification sampling settings', async () => {
  await withTempConfig(
    JSON.stringify({
      buyer: {
        verification: {
          sampleRate: 1,
          maxSampleBytes: 1048576,
        },
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.deepEqual(config.buyer.verification, {
        sampleRate: 1,
        maxSampleBytes: 1048576,
      });
    }
  );
});

test('loadConfig rejects invalid buyer verification sampleRate', async () => {
  await withTempConfig(
    JSON.stringify({
      buyer: {
        verification: {
          sampleRate: 1.1,
        },
      },
    }),
    async (configPath) => {
      await assert.rejects(
        async () => loadConfig(configPath),
        /buyer\.verification\.sampleRate/
      );
    }
  );
});

const REFERENCE_ENDPOINT = {
  baseUrl: 'https://reference.example/v1',
  sourceId: 'trusted-reference-v1',
  trust: 'trusted',
};

test('loadConfig preserves and validates verifier settings', async () => {
  await withTempConfig(JSON.stringify({
    verifier: {
      auditor: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      keystore: '~/.foundry/keystores/auditor',
      referencesDir: './refs',
      banksDir: './banks',
      evidenceDir: './evidence',
      probeRequestTimeoutMs: 90_000,
      responseAuthWaitTimeoutMs: 35_000,
      auditMaxConcurrentModels: 3,
      auditMaxConcurrentPeersPerModel: 4,
      auditMaxConcurrentBatches: 12,
      auditMaxConcurrentBatchesPerPeer: 2,
      auditConcurrencyPromotionLatencyMs: 30_000,
      auditPeerTimeoutMs: 123_456,
      contrastSelection: { inputWeight: 0.9, maxPriceRatio: 0.3, maxModels: 3 },
      referenceEndpoint: REFERENCE_ENDPOINT,
      models: {
        'gpt-5.6-sol': {
          referenceRoute: {
            type: 'antseed',
            service: 'gpt-5.6-sol-reference',
            peerId: '12'.repeat(20),
            pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
          },
          contrastModels: ['kimi-k3'],
          excludedDomains: ['medical'],
        },
        'kimi-k3': {
          contrastModels: ['gpt-5.6-sol'],
          referenceProvider: { order: ['Provider-A'] },
        },
      },
      referenceMaxRequestsPerBuild: 500,
      referenceBatchRetryCount: 2,
      referenceRetryBaseDelayMs: 250,
      referenceMaxNoProgressRounds: 2,
      referenceMaxConcurrentRequests: 2,
      referenceMaxConcurrentRequestsPerModel: 1,
      referenceMinimumProbeCount: 120,
      referenceMaximumProbeCount: 240,
      referenceProbeStep: 20,
      referenceMinimumStatisticalPower: 0.95,
    },
  }), async (configPath) => {
    const config = await loadConfig(configPath);
    assert.equal(config.verifier?.auditor, '0x70997970C51812dc3A010C7d01b50e0d17dc79C8');
    assert.equal(config.verifier?.keystore, '~/.foundry/keystores/auditor');
    assert.equal(config.verifier?.referencesDir, './refs');
    assert.equal(config.verifier?.banksDir, './banks');
    assert.equal(config.verifier?.responseAuthWaitTimeoutMs, 35_000);
    assert.equal(config.verifier?.auditMaxConcurrentModels, 3);
    assert.equal(config.verifier?.auditMaxConcurrentPeersPerModel, 4);
    assert.equal(config.verifier?.auditMaxConcurrentBatches, 12);
    assert.equal(config.verifier?.auditMaxConcurrentBatchesPerPeer, 2);
    assert.equal(config.verifier?.auditConcurrencyPromotionLatencyMs, 30_000);
    assert.equal(config.verifier?.auditPeerTimeoutMs, 123_456);
    assert.equal(config.verifier?.contrastSelection?.inputWeight, 0.9);
    assert.equal(config.verifier?.referenceEndpoint?.sourceId, 'trusted-reference-v1');
    assert.deepEqual(config.verifier?.models?.['gpt-5.6-sol']?.excludedDomains, ['medical']);
    assert.equal(config.verifier?.models?.['gpt-5.6-sol']?.referenceRoute?.service, 'gpt-5.6-sol-reference');
    assert.deepEqual(config.verifier?.models?.['kimi-k3']?.referenceProvider, { order: ['Provider-A'] });
    assert.equal(config.verifier?.referenceMaxRequestsPerBuild, 500);
    assert.equal(config.verifier?.referenceMinimumProbeCount, 120);
    assert.equal(config.verifier?.referenceMaximumProbeCount, 240);
    assert.equal(config.verifier?.referenceProbeStep, 20);
    assert.equal(config.verifier?.referenceMinimumStatisticalPower, 0.95);
  });
});

test('loadConfig accepts a verifier with only a reference endpoint', async () => {
  await withTempConfig(JSON.stringify({
    verifier: {
      contrastSelection: {
        catalogSource: 'openrouter', inputWeight: 0.9, maxPriceRatio: 0.3,
        maxModels: 3, minimumIntelligenceIndex: 30,
      },
      referenceEndpoint: {
        baseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', sourceId: 'openrouter', trust: 'trusted',
      },
    },
  }), async (configPath) => {
    const config = await loadConfig(configPath);
    assert.equal(config.verifier?.contrastSelection?.catalogSource, 'openrouter');
    assert.equal(config.verifier?.contrastSelection?.minimumIntelligenceIndex, 30);
    assert.equal(config.verifier?.models, undefined);
  });
});

test('loadConfig rejects model lists: the audited models are built in', async () => {
  await withTempConfig(JSON.stringify({ verifier: {
    referenceEndpoint: { ...REFERENCE_ENDPOINT, models: { 'kimi-k3': { upstreamModel: 'moonshotai/kimi-k3' } } },
  } }), async (configPath) => {
    await assert.rejects(loadConfig(configPath), /referenceEndpoint\.models is no longer supported/);
  });
  await withTempConfig(JSON.stringify({ verifier: {
    referenceEndpoint: REFERENCE_ENDPOINT,
    models: { 'my-own-model': { excludedDomains: ['medical'] } },
  } }), async (configPath) => {
    await assert.rejects(loadConfig(configPath), /models\["?my-own-model"?\]? is not an audited model/);
  });
  await withTempConfig(JSON.stringify({ verifier: {
    referenceEndpoint: REFERENCE_ENDPOINT,
    models: { 'kimi-k3': { upstreamModel: 'other/kimi' } },
  } }), async (configPath) => {
    await assert.rejects(loadConfig(configPath), /models\["kimi-k3"\]\.upstreamModel is not supported/);
  });
  await withTempConfig(JSON.stringify({ verifier: {
    referenceEndpoint: REFERENCE_ENDPOINT,
    models: { 'kimi-k3': { enabled: false } },
  } }), async (configPath) => {
    await assert.rejects(loadConfig(configPath), /models\["kimi-k3"\]\.enabled is no longer supported/);
  });
  await withTempConfig(JSON.stringify({ verifier: {
    referenceEndpoint: REFERENCE_ENDPOINT,
    models: { 'claude-opus-4-6': {}, 'claude-opus-4.6': {} },
  } }), async (configPath) => {
    await assert.rejects(loadConfig(configPath), /configures the same model/);
  });
  await withTempConfig(JSON.stringify({ verifier: { auditor: '0x1234' } }), async (configPath) => {
    await assert.rejects(loadConfig(configPath), /verifier\.auditor must be a 0x-prefixed 20-byte address/);
  });
});

test('loadConfig accepts named reference upstreams and rejects unknown ones', async () => {
  const models = (upstream: unknown) => ({
    'claude-opus-5': { contrastModels: ['contrast'], upstream },
  });
  await withTempConfig(JSON.stringify({ verifier: {
    upstreams: {
      anthropic: { type: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', apiKeyEnv: 'ANTHROPIC_API_KEY' },
    },
    referenceEndpoint: { baseUrl: 'https://openrouter.ai/api/v1', sourceId: 'openrouter', trust: 'trusted' },
    models: models({ name: 'anthropic', model: 'claude-opus-5' }),
  } }), async (configPath) => {
    const config = await loadConfig(configPath);
    assert.equal(config.verifier?.upstreams?.anthropic?.type, 'anthropic');
    assert.deepEqual(config.verifier?.models?.['claude-opus-5']?.upstream, { name: 'anthropic', model: 'claude-opus-5' });
  });
  await withTempConfig(JSON.stringify({ verifier: {
    referenceEndpoint: { baseUrl: 'https://openrouter.ai/api/v1', sourceId: 'openrouter', trust: 'trusted' },
    models: models({ name: 'missing' }),
  } }), async (configPath) => {
    await assert.rejects(loadConfig(configPath), /must name an entry in verifier\.upstreams/);
  });
  await withTempConfig(JSON.stringify({ verifier: {
    upstreams: { seller: { type: 'antseed', peerId: '12'.repeat(20) } },
    referenceEndpoint: { baseUrl: 'https://openrouter.ai/api/v1', sourceId: 'openrouter', trust: 'trusted' },
    models: models({ name: 'seller' }),
  } }), async (configPath) => {
    await assert.rejects(loadConfig(configPath), /upstream\.pricing is required for an antseed upstream/);
  });
  await withTempConfig(JSON.stringify({ verifier: {
    upstreams: { native: { type: 'gemini', baseUrl: 'https://example.test' } },
  } }), async (configPath) => {
    await assert.rejects(loadConfig(configPath), /upstreams\.native\.type/);
  });
});

test('loadConfig rejects invalid verifier settings', async () => {
  const withModel = (settings: Record<string, unknown>, extra: Record<string, unknown> = {}) => JSON.stringify({ verifier: {
    referenceEndpoint: REFERENCE_ENDPOINT,
    models: { 'kimi-k3': { contrastModels: ['contrast'], ...settings } },
    ...extra,
  } });
  await withTempConfig(JSON.stringify({ verifier: { referenceBatchRetryCount: -1 } }), async (configPath) => {
    await assert.rejects(loadConfig(configPath), /referenceBatchRetryCount/);
  });
  await withTempConfig(JSON.stringify({ verifier: { probesPerAudti: 24 } }), async (configPath) => {
    await assert.rejects(loadConfig(configPath), /verifier\.probesPerAudti/);
  });
  await withTempConfig(JSON.stringify({ verifier: { referenceMinimumProbeCount: 105 } }), async (configPath) => {
    await assert.rejects(loadConfig(configPath), /referenceMinimumProbeCount/);
  });
  for (const [referenceRoute, message] of [
    [{ type: 'direct', service: 'target', peerId: '12'.repeat(20), pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } }, /referenceRoute\.type/],
    [{ type: 'antseed', service: '', peerId: '12'.repeat(20), pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } }, /referenceRoute\.service/],
    [{ type: 'antseed', service: 'target', peerId: 'bad', pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } }, /referenceRoute\.peerId/],
    [{ type: 'antseed', service: 'target', peerId: '12'.repeat(20), pricing: { inputUsdPerMillion: -1, outputUsdPerMillion: 2 } }, /referenceRoute\.pricing\.inputUsdPerMillion/],
  ] as const) {
    await withTempConfig(withModel({ referenceRoute }), async (configPath) => {
      await assert.rejects(loadConfig(configPath), message);
    });
  }
  await withTempConfig(JSON.stringify({ verifier: {
    referenceMinimumProbeCount: 120,
    referenceMaximumProbeCount: 100,
  } }), async (configPath) => {
    await assert.rejects(loadConfig(configPath), /must not exceed/);
  });
  await withTempConfig(JSON.stringify({ verifier: {
    referenceMinimumProbeCount: 100,
    referenceMaximumProbeCount: 150,
    referenceProbeStep: 20,
  } }), async (configPath) => {
    await assert.rejects(loadConfig(configPath), /must divide/);
  });
  for (const power of [0, 1.01]) {
    await withTempConfig(JSON.stringify({ verifier: { referenceMinimumStatisticalPower: power } }), async (configPath) => {
      await assert.rejects(loadConfig(configPath), /referenceMinimumStatisticalPower/);
    });
  }
  await withTempConfig(JSON.stringify({ verifier: { contrastSelection: { inputWeight: 1.1 } } }), async (configPath) => {
    await assert.rejects(loadConfig(configPath), /contrastSelection\.inputWeight/);
  });
  await withTempConfig(JSON.stringify({ verifier: {
    contrastSelection: { catalogSource: 'openrouter' },
    referenceEndpoint: {
      ...REFERENCE_ENDPOINT,
      contrastModelBank: { manual: {
        upstreamModel: 'provider/manual',
        pricing: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.2 },
        capabilityRank: 10,
      } },
    },
  } }), async (configPath) => {
    await assert.rejects(loadConfig(configPath), /must be omitted/);
  });
  await withTempConfig(withModel({ pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 } }), async (configPath) => {
    await assert.rejects(loadConfig(configPath), /pricing must be omitted when contrast models come from the OpenRouter catalog/);
  });
  await withTempConfig(withModel({ excludedDomains: ['medicine'] }), async (configPath) => {
    await assert.rejects(loadConfig(configPath), /excludedDomains\[0\].*canonical KBF domain/);
  });
  await withTempConfig(withModel({ excludedDomains: ['medical', 'medical'] }), async (configPath) => {
    await assert.rejects(loadConfig(configPath), /excludedDomains must not contain duplicates/);
  });
  for (const [referenceProvider, extra, message] of [
    [{ order: [] }, {}, /referenceProvider\.order must list at least one provider/],
    [{ order: ['A', 'a'] }, {}, /referenceProvider\.order must not contain duplicates/],
    [{ order: ['A'], allowFallbacks: true }, {}, /referenceProvider\.allowFallbacks is not supported/],
    [{ order: ['A'] }, { referenceRoute: {
      type: 'antseed', service: 'target', peerId: '12'.repeat(20),
      pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
    } }, /referenceProvider must be omitted/],
  ] as const) {
    await withTempConfig(withModel({ referenceProvider, ...extra }), async (configPath) => {
      await assert.rejects(loadConfig(configPath), message);
    });
  }
  await withTempConfig(withModel({ contrastModels: ['a', 'b', 'c', 'd'] }), async (configPath) => {
    await assert.rejects(loadConfig(configPath), /contrastModels must contain at most 3 entries/);
  });
});

test('loadConfig rejects invalid buyer peerRefreshIntervalMs', async () => {
  await withTempConfig(
    JSON.stringify({
      buyer: {
        peerRefreshIntervalMs: 999,
      },
    }),
    async (configPath) => {
      await assert.rejects(
        async () => loadConfig(configPath),
        /buyer\.peerRefreshIntervalMs/
      );
    }
  );
});

test('loadConfig rejects invalid buyer metadataFetchTimeoutMs', async () => {
  await withTempConfig(
    JSON.stringify({
      buyer: {
        metadataFetchTimeoutMs: 99,
      },
    }),
    async (configPath) => {
      await assert.rejects(
        async () => loadConfig(configPath),
        /buyer\.metadataFetchTimeoutMs/
      );
    }
  );
});

test('loadConfig rejects invalid buyer request duration limits', async () => {
  await withTempConfig(
    JSON.stringify({ buyer: { requestTimeoutMs: 0, maxStreamDurationMs: -1 } }),
    async (configPath) => {
      await assert.rejects(
        async () => loadConfig(configPath),
        /buyer\.requestTimeoutMs.*buyer\.maxStreamDurationMs/s,
      );
    },
  );
});

test('loadConfig preserves explicit non-default buyer minPeerReputation', async () => {
  await withTempConfig(
    JSON.stringify({
      buyer: {
        minPeerReputation: 42,
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.equal(config.buyer.minPeerReputation, 42);
    }
  );
});

test('loadConfig rejects incomplete service pricing', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        providers: {
          anthropic: {
            plugin: 'anthropic',
            services: {
              broken: {
                pricing: { inputUsdPerMillion: 12 },
              },
            },
          },
        },
      },
    }),
    async (configPath) => {
      await assert.rejects(
        async () => loadConfig(configPath),
        /seller\.providers\.anthropic\.services\.broken\.pricing\.outputUsdPerMillion/
      );
    }
  );
});

test('loadConfig rejects invalid category tags', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        providers: {
          anthropic: {
            plugin: 'anthropic',
            services: {
              'claude-sonnet-4-5-20250929': {
                categories: ['Bad Value'],
              },
            },
          },
        },
      },
    }),
    async (configPath) => {
      await assert.rejects(
        async () => loadConfig(configPath),
        /seller\.providers\.anthropic\.services\.claude-sonnet-4-5-20250929\.categories/
      );
    }
  );
});

test('loadConfig normalizes category tags (lowercase, dedupe)', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        providers: {
          openai: {
            plugin: 'openai',
            services: {
              'gpt-4': {
                categories: ['Chat', 'chat', 'Coding'],
              },
            },
          },
        },
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.deepEqual(
        config.seller.providers['openai']?.services['gpt-4']?.categories,
        ['chat', 'coding']
      );
    }
  );
});

test('loadConfig drops seller provider entries without plugin', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        providers: {
          openai: {
            services: {
              'gpt-4': {},
            },
          },
        },
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.equal(config.seller.providers['openai'], undefined);
    }
  );
});

test('loadConfig preserves seller publicAddress override', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        publicAddress: 'peer.example.com:6882',
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.equal(config.seller.publicAddress, 'peer.example.com:6882');
    }
  );
});

test('loadConfig preserves seller verifications.domains claims', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        verifications: {
          domains: [
            { domain: 'Example.COM', methods: ['https-well-known', 'dns-txt'] },
          ],
        },
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.deepEqual(config.seller.verifications, {
        domains: [
          { domain: 'example.com', methods: ['https-well-known', 'dns-txt'] },
        ],
      });
    }
  );
});

test('loadConfig rejects unknown domain verification methods instead of dropping them', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        verifications: {
          domains: [
            { domain: 'example.com', methods: ['dns-text'] },
          ],
        },
      },
    }),
    async (configPath) => {
      await assert.rejects(
        loadConfig(configPath),
        /verifications\.domains\[0\]\.methods\[0\]/,
      );
    }
  );
});

test('loadConfig preserves seller verifications.github claims', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        verifications: {
          github: [
            { username: 'OctoCat' },
            { username: 'hubber', repository: 'Antseed-Proofs' },
          ],
        },
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.deepEqual(config.seller.verifications, {
        github: [
          { username: 'octocat' },
          { username: 'hubber', repository: 'antseed-proofs' },
        ],
      });
    }
  );
});

test('loadConfig rejects invalid github verification usernames', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        verifications: {
          github: [
            { username: '-invalid-' },
          ],
        },
      },
    }),
    async (configPath) => {
      await assert.rejects(
        loadConfig(configPath),
        /verifications\.github\[0\]\.username/,
      );
    }
  );
});

test('loadConfig rejects empty seller verifications', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        verifications: { domains: [] },
      },
    }),
    async (configPath) => {
      await assert.rejects(
        loadConfig(configPath),
        /verifications\.domains/,
      );
    }
  );
});

test('loadConfig preserves seller maxUploadBodyBytes setting', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        maxUploadBodyBytes: 134217728,
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.equal(config.seller.maxUploadBodyBytes, 134217728);
    }
  );
});

test('loadConfig rejects invalid seller maxUploadBodyBytes setting', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        maxUploadBodyBytes: 123,
      },
    }),
    async (configPath) => {
      await assert.rejects(
        async () => loadConfig(configPath),
        /seller\.maxUploadBodyBytes/
      );
    }
  );
});

test('loadConfig preserves seller healthCheck setting', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        healthCheck: { enabled: false, intervalMs: 120_000, failureThreshold: 5 },
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.deepEqual(config.seller.healthCheck, { enabled: false, intervalMs: 120_000, failureThreshold: 5 });
    }
  );
});

test('loadConfig rejects invalid seller healthCheck intervalMs', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        healthCheck: { intervalMs: 5_000 },
      },
    }),
    async (configPath) => {
      await assert.rejects(
        async () => loadConfig(configPath),
        /seller\.healthCheck\.intervalMs/
      );
    }
  );
});

test('loadConfig rejects invalid seller healthCheck failureThreshold', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        healthCheck: { failureThreshold: 0 },
      },
    }),
    async (configPath) => {
      await assert.rejects(
        async () => loadConfig(configPath),
        /seller\.healthCheck\.failureThreshold/
      );
    }
  );
});

test('loadConfig preserves seller gasCheck setting', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        gasCheck: { enabled: false, intervalMs: 30_000, minBalanceEth: 0.0001 },
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.deepEqual(config.seller.gasCheck, { enabled: false, intervalMs: 30_000, minBalanceEth: 0.0001 });
    }
  );
});

test('loadConfig rejects invalid seller gasCheck intervalMs', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        gasCheck: { intervalMs: 1_000 },
      },
    }),
    async (configPath) => {
      await assert.rejects(
        async () => loadConfig(configPath),
        /seller\.gasCheck\.intervalMs/
      );
    }
  );
});

test('loadConfig rejects invalid seller gasCheck minBalanceEth', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        gasCheck: { minBalanceEth: -1 },
      },
    }),
    async (configPath) => {
      await assert.rejects(
        async () => loadConfig(configPath),
        /seller\.gasCheck\.minBalanceEth/
      );
    }
  );
});

test('loadConfig preserves seller freeUsage setting', async () => {
  await withTempConfig(
    JSON.stringify({ seller: { freeUsage: { recordBatchSize: 64, recordFlushIntervalMs: 900_000 } } }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.deepEqual(config.seller.freeUsage, { recordBatchSize: 64, recordFlushIntervalMs: 900_000 });
    }
  );
});

test('loadConfig preserves seller freeTier setting', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        freeTier: { maxRequestsPerAddress: 100, maxRequestsPerIp: 300, windowMs: 86_400_000 },
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.deepEqual(config.seller.freeTier, { maxRequestsPerAddress: 100, maxRequestsPerIp: 300, windowMs: 86_400_000 });
    }
  );
});

test('loadConfig rejects invalid seller freeTier limits', async () => {
  for (const freeTier of [
    { maxRequestsPerAddress: 0 },
    { maxRequestsPerIp: 0 },
    { windowMs: 86_400_000 },
    { maxRequestsPerAddress: 10, windowMs: 999 },
  ]) {
    await withTempConfig(
      JSON.stringify({ seller: { freeTier } }),
      async (configPath) => {
        await assert.rejects(async () => loadConfig(configPath), /seller\.freeTier/);
      }
    );
  }
});

test('loadConfig preserves seller freeTier stake tiers, including the [] opt-out', async () => {
  for (const stakeTiers of [[{ minPower: 520_000, multiplier: 5 }, { minPower: 10_400_000, multiplier: 'unlimited' }], []]) {
    await withTempConfig(
      JSON.stringify({ seller: { freeTier: { maxRequestsPerAddress: 100, stakeTiers } } }),
      async (configPath) => {
        const config = await loadConfig(configPath);
        assert.deepEqual(config.seller.freeTier?.stakeTiers, stakeTiers);
      }
    );
  }
});

test('loadConfig rejects invalid seller freeTier stake tiers', async () => {
  for (const stakeTiers of [
    'unlimited',
    [{ minPower: 0, multiplier: 5 }],
    [{ minPower: 100, multiplier: 0 }],
    [{ minPower: 200, multiplier: 5 }, { minPower: 100, multiplier: 20 }],
    [{ minPower: 100, multiplier: 'unlimited' }, { minPower: 200, multiplier: 5 }],
  ]) {
    await withTempConfig(
      JSON.stringify({ seller: { freeTier: { maxRequestsPerAddress: 100, stakeTiers } } }),
      async (configPath) => {
        await assert.rejects(async () => loadConfig(configPath), /seller\.freeTier\.stakeTiers/);
      }
    );
  }
});

test('loadConfig preserves a service freeTier program and rejects invalid ones', async () => {
  const provider = (freeTier: unknown, plugin = 'openai') => ({ plugin, services: { 'free-model': { pricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 }, freeTier } } });
  const program = { maxRequestsPerAddress: 10, windowMs: 3_600_000, stakeTiers: [{ minPower: 520_000, multiplier: 5 }], stakersOnly: true };
  await withTempConfig(
    JSON.stringify({ seller: { providers: { openai: provider(program) } } }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.deepEqual(config.seller.providers['openai']?.services['free-model']?.freeTier, program);
    }
  );
  for (const [freeTier, error] of [
    [{ stakersOnly: true }, /services\.free-model\.freeTier requires/],
    [{ maxRequestsPerAddress: 1, stakersOnly: 'yes' }, /freeTier\.stakersOnly must be a boolean/],
    [{ maxRequestsPerAddress: 1, stakeTiers: [], stakersOnly: true }, /freeTier\.stakersOnly requires at least one stake tier/],
    ['unlimited', /services\.free-model\.freeTier requires/],
    [{ maxRequestsPerAddress: Number.MAX_SAFE_INTEGER, maxRequestsPerIp: Number.MAX_SAFE_INTEGER }, /services\.free-model\.freeTier is too large to advertise/],
  ] as const) {
    await withTempConfig(
      JSON.stringify({ seller: { providers: { openai: provider(freeTier) } } }),
      async (configPath) => {
        await assert.rejects(async () => loadConfig(configPath), error);
      }
    );
  }
  // One service id across providers needs one program.
  await withTempConfig(
    JSON.stringify({ seller: { providers: { a: provider({ maxRequestsPerAddress: 1 }), b: provider({ maxRequestsPerAddress: 2 }) } } }),
    async (configPath) => {
      await assert.rejects(async () => loadConfig(configPath), /differs from another provider's freeTier for service "free-model"/);
    }
  );
});

test('loadConfig preserves buyer freeTierDelegations and rejects malformed ones', async () => {
  const delegation = { staker: `0x${'aa'.repeat(20)}`, buyer: `0x${'11'.repeat(20)}`, expiresAt: 1_900_000_000, signature: `0x${'00'.repeat(65)}` }
  await withTempConfig(
    JSON.stringify({ buyer: { freeTierDelegations: [delegation] } }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.deepEqual(config.buyer.freeTierDelegations, [delegation]);
    }
  );
  for (const freeTierDelegations of [
    'nope',
    [{ ...delegation, staker: 'nope' }],
    [{ ...delegation, signature: '0x12' }],
    Array.from({ length: 9 }, (_, i) => ({ ...delegation, staker: `0x${i.toString(16).padStart(2, '0').repeat(20)}` })),
  ]) {
    await withTempConfig(
      JSON.stringify({ buyer: { freeTierDelegations } }),
      async (configPath) => {
        await assert.rejects(async () => loadConfig(configPath), /buyer\.freeTierDelegations/);
      }
    );
  }
});

test('loadConfig preserves seller restrictedCountries, including the [] opt-out', async () => {
  for (const restrictedCountries of [['IR', 'RU'], []]) {
    await withTempConfig(
      JSON.stringify({ seller: { restrictedCountries } }),
      async (configPath) => {
        const config = await loadConfig(configPath);
        assert.deepEqual(config.seller.restrictedCountries, restrictedCountries);
      }
    );
  }
});

test('loadConfig rejects invalid seller restrictedCountries', async () => {
  for (const restrictedCountries of ['IR', ['ir'], ['IRN'], [1]]) {
    await withTempConfig(
      JSON.stringify({ seller: { restrictedCountries } }),
      async (configPath) => {
        await assert.rejects(async () => loadConfig(configPath), /seller\.restrictedCountries/);
      }
    );
  }
});

test('loadConfig preserves seller agentDir setting', async () => {
  await withTempConfig(
    JSON.stringify({
      seller: {
        agentDir: '/etc/antseed/my-agent',
      },
    }),
    async (configPath) => {
      const config = await loadConfig(configPath);
      assert.equal(config.seller.agentDir, '/etc/antseed/my-agent');
    }
  );
});

test('buyer.verifier is read and validated like the rest of the config', () => {
  assert.deepEqual(configFromObject({ buyer: { verifier: { require: true, prefer: ['antseed-verifier'] } } }).buyer.verifier, { require: true, prefer: ['antseed-verifier'] });
  assert.equal(configFromObject({}).buyer.verifier, undefined);
  assert.throws(() => configFromObject({ buyer: { verifier: { enabled: false, require: true } } }), /buyer\.verifier\.enabled cannot be false/);
  assert.throws(() => configFromObject({ buyer: { verifier: { prefer: 'x' } } }), /buyer\.verifier\.prefer/);
});

test('seller.alerts survives a load and save, and a malformed one is refused', async () => {
  const alerts = { telegram: { chatId: '-100123', botTokenEnv: 'MY_TOKEN' }, webhook: { url: 'https://hooks.example/x' }, idleMinutes: 30, cooldownMinutes: 10, minSeverity: 'critical' };
  await withTempConfig(JSON.stringify({ seller: { alerts } }), async (configPath) => {
    const config = await loadConfig(configPath);
    config.seller.maxConcurrentBuyers = 7;
    await saveConfig(configPath, config);
    assert.deepEqual((await loadConfig(configPath)).seller.alerts, alerts);
  });
  assert.equal(configFromObject({ seller: { alerts: { telegram: { chatId: 42 } } } }).seller.alerts?.telegram?.chatId, 42, 'a numeric chat id is accepted');
  assert.throws(() => configFromObject({ seller: { alerts: { telegram: { chatId: true }, idleMinutes: '5', minSeverity: 'loud' } } }),
    /seller\.alerts\.telegram\.chatId[\s\S]*seller\.alerts\.idleMinutes[\s\S]*seller\.alerts\.minSeverity/);
});
