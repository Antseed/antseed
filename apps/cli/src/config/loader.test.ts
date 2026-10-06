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
import { loadConfig } from './loader.js';
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

test('loadConfig preserves and validates verifier settings', async () => {
  const referenceEndpoint = {
    baseUrl: 'https://reference.example/v1',
    sourceId: 'trusted-reference-v1',
    trust: 'trusted',
    models: {
      'gpt-5.6-sol': {
        upstreamModel: 'gpt-5.6-sol',
        serviceAliases: ['gpt-5.6.sol'],
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
        upstreamModel: 'moonshot/kimi-k3',
        contrastModels: ['gpt-5.6-sol'],
        referenceProvider: { order: ['Provider-A'] },
      },
    },
  };
  await withTempConfig(JSON.stringify({
    verifier: {
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
      referenceEndpoint,
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
    assert.deepEqual(config.verifier?.referenceEndpoint?.models['gpt-5.6-sol']?.excludedDomains, ['medical']);
    assert.deepEqual(config.verifier?.referenceEndpoint?.models['gpt-5.6-sol']?.serviceAliases, ['gpt-5.6.sol']);
    assert.equal(config.verifier?.referenceEndpoint?.models['gpt-5.6-sol']?.referenceRoute?.service, 'gpt-5.6-sol-reference');
    assert.deepEqual(config.verifier?.referenceEndpoint?.models['kimi-k3']?.referenceProvider, { order: ['Provider-A'] });
    assert.equal(config.verifier?.referenceMaxRequestsPerBuild, 500);
    assert.equal(config.verifier?.referenceMinimumProbeCount, 120);
    assert.equal(config.verifier?.referenceMaximumProbeCount, 240);
    assert.equal(config.verifier?.referenceProbeStep, 20);
    assert.equal(config.verifier?.referenceMinimumStatisticalPower, 0.95);
  });
});

test('loadConfig accepts OpenRouter-sourced prices and intelligence scores', async () => {
  await withTempConfig(JSON.stringify({
    verifier: {
      contrastSelection: {
        catalogSource: 'openrouter', inputWeight: 0.9, maxPriceRatio: 0.3,
        maxModels: 3, minimumIntelligenceIndex: 30,
      },
      referenceEndpoint: {
        baseUrl: 'https://openrouter.ai/api/v1', sourceId: 'openrouter', trust: 'trusted',
        models: { target: { upstreamModel: 'provider/target' } },
      },
    },
  }), async (configPath) => {
    const config = await loadConfig(configPath);
    assert.equal(config.verifier?.contrastSelection?.catalogSource, 'openrouter');
    assert.equal(config.verifier?.contrastSelection?.minimumIntelligenceIndex, 30);
    assert.equal(config.verifier?.referenceEndpoint?.models.target?.pricing, undefined);
  });
});

test('loadConfig rejects invalid verifier settings', async () => {
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
    await withTempConfig(JSON.stringify({
      verifier: {
        referenceEndpoint: {
          baseUrl: 'https://reference.example/v1', sourceId: 'test', trust: 'trusted',
          models: { target: { upstreamModel: 'target', contrastModels: ['contrast'], referenceRoute } },
        },
      },
    }), async (configPath) => {
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
      baseUrl: 'https://openrouter.ai/api/v1', sourceId: 'openrouter', trust: 'trusted',
      models: { target: {
        upstreamModel: 'provider/target',
        pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
      } },
      contrastModelBank: { manual: {
        upstreamModel: 'provider/manual',
        pricing: { inputUsdPerMillion: 0.1, outputUsdPerMillion: 0.2 },
        capabilityRank: 10,
      } },
    },
  } }), async (configPath) => {
    await assert.rejects(loadConfig(configPath), /must be omitted/);
  });
  await withTempConfig(JSON.stringify({ verifier: {
    referenceEndpoint: {
      baseUrl: 'https://reference.example/v1', sourceId: 'test', trust: 'trusted',
      models: { target: {
        upstreamModel: 'target', contrastModels: ['contrast'], excludedDomains: ['medicine'],
      } },
    },
  } }), async (configPath) => {
    await assert.rejects(loadConfig(configPath), /excludedDomains\[0\].*canonical KBF domain/);
  });
  await withTempConfig(JSON.stringify({ verifier: {
    referenceEndpoint: {
      baseUrl: 'https://reference.example/v1', sourceId: 'test', trust: 'trusted',
      models: { target: {
        upstreamModel: 'target', contrastModels: ['contrast'], excludedDomains: ['medical', 'medical'],
      } },
    },
  } }), async (configPath) => {
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
    await withTempConfig(JSON.stringify({ verifier: {
      referenceEndpoint: {
        baseUrl: 'https://reference.example/v1', sourceId: 'test', trust: 'trusted',
        models: { target: { upstreamModel: 'target', contrastModels: ['contrast'], referenceProvider, ...extra } },
      },
    } }), async (configPath) => {
      await assert.rejects(loadConfig(configPath), message);
    });
  }
  for (const [serviceAliases, message] of [
    [['target'], /serviceAliases must not duplicate/],
    [['alias', 'ALIAS'], /serviceAliases must not duplicate/],
    [[''], /serviceAliases must be a string array/],
  ] as const) {
    await withTempConfig(JSON.stringify({ verifier: {
      referenceEndpoint: {
        baseUrl: 'https://reference.example/v1', sourceId: 'test', trust: 'trusted',
        models: { target: { upstreamModel: 'target', contrastModels: ['contrast'], serviceAliases } },
      },
    } }), async (configPath) => {
      await assert.rejects(loadConfig(configPath), message);
    });
  }
  await withTempConfig(JSON.stringify({ verifier: {
    referenceEndpoint: {
      baseUrl: 'https://reference.example/v1', sourceId: 'test', trust: 'trusted',
      models: { automatic: { upstreamModel: 'automatic' } },
    },
  } }), async (configPath) => {
    await assert.rejects(loadConfig(configPath), /pricing is required/);
  });
  await withTempConfig(JSON.stringify({ verifier: {
    referenceEndpoint: {
      baseUrl: 'https://reference.example/v1', sourceId: 'test', trust: 'trusted',
      models: { automatic: {
        upstreamModel: 'automatic',
        pricing: { inputUsdPerMillion: 10, outputUsdPerMillion: 20 },
        contrastModels: [],
      } },
    },
  } }), async (configPath) => {
    await assert.rejects(loadConfig(configPath), /contrastModelBank is required/);
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
