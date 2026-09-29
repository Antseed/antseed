import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import { registerRoutes } from './routes.js';

function mockCtx(overrides: Partial<Parameters<typeof registerRoutes>[1]> = {}): Parameters<typeof registerRoutes>[1] {
  return {
    cryptoCtx: null,
    cryptoConfig: {
      rpcUrl: 'http://localhost:8545',
      depositsContractAddress: '0x' + '0'.repeat(40),
      channelsContractAddress: '0x' + '1'.repeat(40),
      usdcContractAddress: '0x' + '2'.repeat(40),
    } as any,
    chainConfig: {
      chainId: 'base-local',
      evmChainId: 31337,
      emissionsContractAddress: '0x' + '3'.repeat(40),
    } as any,
    proxyPort: 3000,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('GET /api/config', () => {
  it('includes emissionsContractAddress', async () => {
    const app = Fastify();
    registerRoutes(app, mockCtx());
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    const body = res.json();
    expect(body).toHaveProperty('emissionsContractAddress');
    expect(body.emissionsContractAddress).toBe('0x' + '3'.repeat(40));
    expect(body.legacyEmissionsContractAddress).toBe('0x' + '3'.repeat(40));
    expect(body.usageAccountingAddress).toBeNull();
    expect(body.usageRewardsAddress).toBeNull();
    await app.close();
  });

  it('exposes separate legacy and recognized-usage claim contracts after activation', async () => {
    const app = Fastify();
    registerRoutes(app, mockCtx({
      chainConfig: {
        chainId: 'base-mainnet',
        evmChainId: 8453,
        emissionsContractAddress: '0x' + '3'.repeat(40),
        legacyEmissionsContractAddress: '0x' + '4'.repeat(40),
        usageAccountingAddress: '0x' + '5'.repeat(40),
        usageRewardsAddress: '0x' + '6'.repeat(40),
        recognizedUsage: { status: 'active', effectiveEpoch: 22 },
      } as any,
    }));
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    expect(res.json()).toMatchObject({
      legacyEmissionsContractAddress: '0x' + '4'.repeat(40),
      usageAccountingAddress: '0x' + '5'.repeat(40),
      usageRewardsAddress: '0x' + '6'.repeat(40),
      recognizedUsageEffectiveEpoch: 22,
    });
    await app.close();
  });

  it('includes networkStatsUrl when the chain config has it', async () => {
    const app = Fastify();
    registerRoutes(app, mockCtx({
      chainConfig: {
        chainId: 'base-mainnet',
        evmChainId: 8453,
        networkStatsUrl: 'https://network.antseed.com',
      } as any,
    }));
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    expect(res.json().networkStatsUrl).toBe('https://network.antseed.com');
    await app.close();
  });

  it('returns networkStatsUrl: null when the chain config has none', async () => {
    const app = Fastify();
    registerRoutes(app, mockCtx({
      chainConfig: {
        chainId: 'base-local',
        evmChainId: 31337,
      } as any,
    }));
    const res = await app.inject({ method: 'GET', url: '/api/config' });
    expect(res.json().networkStatsUrl).toBeNull();
    await app.close();
  });
});

describe('GET /api/rpc-health', () => {
  it('returns the latest RPC block number', async () => {
    const app = Fastify();
    registerRoutes(app, mockCtx());
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: '0x2a',
    }), { status: 200 })));

    const res = await app.inject({ method: 'GET', url: '/api/rpc-health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true, blockNumber: 42 });
    await app.close();
  });

  it('returns 502 when the RPC read fails', async () => {
    const app = Fastify();
    registerRoutes(app, mockCtx());
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      error: { message: 'bad rpc' },
    }), { status: 200 })));

    const res = await app.inject({ method: 'GET', url: '/api/rpc-health' });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toMatchObject({ ok: false, error: 'bad rpc' });
    await app.close();
  });
});

describe('GET /api/emissions/pending', () => {
  it('rejects malformed addresses with 400', async () => {
    const app = Fastify();
    registerRoutes(app, mockCtx());
    const res = await app.inject({ method: 'GET', url: '/api/emissions/pending?address=not-an-address' });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('returns 503 when emissions contract is not configured', async () => {
    const app = Fastify();
    registerRoutes(app, mockCtx({
      chainConfig: { chainId: 'base-local', evmChainId: 31337 } as any,
    }));
    const res = await app.inject({ method: 'GET', url: '/api/emissions/pending?address=0x' + '4'.repeat(40) });
    expect(res.statusCode).toBe(503);
    await app.close();
  });
});

describe('GET /api/emissions/transfers-enabled', () => {
  it('returns configured:false when ANTS token address is missing', async () => {
    const app = Fastify();
    registerRoutes(app, mockCtx());
    const res = await app.inject({ method: 'GET', url: '/api/emissions/transfers-enabled' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.enabled).toBe(false);
    expect(body.configured).toBe(false);
    await app.close();
  });
});

// The registry's emissions slot now holds UsageAccounting. Legacy ABI reads and
// browser claim transactions must use the legacy reward contract instead.
describe('recognized-usage contract selection', () => {
  const usage = '0x' + '4'.repeat(40);
  const gate = '0x' + '5'.repeat(40);
  const v2 = '0x' + '6'.repeat(40);
  const v1 = '0x' + '7'.repeat(40);
  const chain = { ...mockCtx().chainConfig, emissionsContractAddress: usage, usageAccountingAddress: usage,
    emissionsGateAddress: gate, legacyEmissionsContractAddress: v2, legacyEmissionsV1ContractAddress: v1 };

  it('exposes the legacy V2 address used by the existing browser claim button', async () => {
    const app = Fastify();
    registerRoutes(app, mockCtx({ chainConfig: chain }));
    expect((await app.inject('/api/config')).json().emissionsContractAddress).toBe(v2);
    await app.close();
  });

  it('does not expose UsageAccounting as a claim target when legacy rewards are absent', async () => {
    const app = Fastify();
    registerRoutes(app, mockCtx({ chainConfig: { ...chain, legacyEmissionsContractAddress: undefined } }));
    expect((await app.inject('/api/config')).json().emissionsContractAddress).toBeNull();
    expect((await app.inject('/api/emissions/pending?address=0x' + '8'.repeat(40))).statusCode).toBe(503);
    await app.close();
  });

  it('reads the current emission schedule from the gate, never the legacy ABI at UsageAccounting', async () => {
    const { EmissionsClient, EmissionsGateClient } = await import('@antseed/node');
    const oldRead = vi.spyOn(EmissionsClient.prototype, 'getEpochInfo').mockRejectedValue(new Error('Wrong emission schedule client'));
    for (const [method, value] of [['currentEpoch', 25], ['epochDuration', 604800], ['genesis', 1000], ['halvingInterval', 52]] as const) {
      vi.spyOn(EmissionsGateClient.prototype, method).mockImplementation(async function (this: { contractAddress: string }) {
        expect(this.contractAddress).toBe(gate); return value;
      });
    }
    vi.spyOn(EmissionsGateClient.prototype, 'currentEmissionRate').mockResolvedValue(100n);
    const epochEmission = vi.spyOn(EmissionsGateClient.prototype, 'getEpochEmission').mockResolvedValue(200n);
    const app = Fastify(); registerRoutes(app, mockCtx({ chainConfig: chain }));
    const response = await app.inject('/api/emissions');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ currentEpoch: 25, currentRate: '100', epochEmission: '200', epochDuration: 604800 });
    expect(oldRead).not.toHaveBeenCalled();
    expect(epochEmission).toHaveBeenCalledWith(25);
    await app.close();
  });

  it.each(['recognized', 'legacy'] as const)('reads legacy V2 rewards with %s configuration', async (mode) => {
    const { EmissionsClient } = await import('@antseed/node');
    const shares = { sellerSharePct: 50, buyerSharePct: 30, reserveSharePct: 10, teamSharePct: 10, maxSellerSharePct: 100, maxBuyerSharePct: 100, initialized: true };
    const v1Reads: string[] = [];
    vi.spyOn(EmissionsClient.prototype, 'getEpochInfo').mockImplementation(async function (this: { contractAddress: string }) {
      expect(this.contractAddress).toBe(v2); return { epoch: 23, emission: 100n, epochDuration: 604800 };
    });
    vi.spyOn(EmissionsClient.prototype, 'getMigrationEpoch').mockImplementation(async function (this: { contractAddress: string }) {
      expect(this.contractAddress).toBe(v2); return 22;
    });
    vi.spyOn(EmissionsClient.prototype, 'pendingEmissions').mockImplementation(async function (this: { contractAddress: string }) {
      expect(this.contractAddress).toBe(v2); return { seller: 10n, buyer: 20n };
    });
    for (const method of ['userSellerPoints', 'userBuyerPoints', 'epochTotalSellerPoints', 'epochTotalBuyerPoints', 'getEpochEmission'] as const) {
      vi.spyOn(EmissionsClient.prototype, method).mockImplementation(async function (this: { contractAddress: string }) {
        expect([v1, v2]).toContain(this.contractAddress);
        if (this.contractAddress === v1) v1Reads.push(method);
        return 100n;
      });
    }
    for (const method of ['sellerEpochClaimed', 'buyerEpochClaimed'] as const) {
      vi.spyOn(EmissionsClient.prototype, method).mockImplementation(async function (this: { contractAddress: string }) {
        expect([v1, v2]).toContain(this.contractAddress);
        if (this.contractAddress === v1) v1Reads.push(method);
        return false;
      });
    }
    vi.spyOn(EmissionsClient.prototype, 'getEpochParams').mockResolvedValue(shares);
    vi.spyOn(EmissionsClient.prototype, 'getShares').mockImplementation(async function (this: { contractAddress: string }) {
      expect(this.contractAddress).toBe(v2); return shares;
    });
    const selected = mode === 'recognized' ? chain : { ...chain, emissionsGateAddress: undefined, emissionsContractAddress: v2, legacyEmissionsContractAddress: v1, legacyEmissionsV1ContractAddress: undefined };
    const app = Fastify(); registerRoutes(app, mockCtx({ chainConfig: selected }));
    const response = await app.inject('/api/emissions/pending?address=0x' + '8'.repeat(40) + '&epochs=3');
    expect(response.statusCode).toBe(200);
    expect(response.json().rows[0]).toMatchObject({ epoch: 21, protocol: 'legacy', seller: { amount: '10' }, buyer: { amount: '20' } });
    expect(v1Reads).toEqual([]);
    expect((await app.inject('/api/emissions/shares')).json()).toEqual(shares);
    await app.close();
  });
});
