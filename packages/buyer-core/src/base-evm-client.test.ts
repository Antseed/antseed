import { describe, expect, it, vi } from 'vitest';
import { FallbackProvider, JsonRpcProvider, Network, type AbstractProvider } from 'ethers';
import { BaseEvmClient, DEFAULT_PRIORITY_FEE_WEI } from './base-evm-client.js';

class TestClient extends BaseEvmClient {
  feeFields() { return this._feeFields(); }
}

const baseFee = 5_000_000n; // 0.005 gwei, a quiet Base block
const newClient = () => new TestClient('http://127.0.0.1:1', '0x0000000000000000000000000000000000000001', undefined, 8453);

/** A JSON-RPC provider whose suggested tip and recent-block tips (eth_feeHistory 10th percentile) are stubbed. */
function rpcWithTips(suggested: bigint, recent: bigint[] | Error) {
  const network = Network.from(8453);
  const provider = new JsonRpcProvider('http://127.0.0.1:1', network, { staticNetwork: network });
  vi.spyOn(provider, '_perform').mockImplementation(async (req) => {
    if (req.method !== 'getPriorityFee') throw new Error(`unexpected ${req.method}`);
    return `0x${suggested.toString(16)}`;
  });
  vi.spyOn(provider, 'send').mockImplementation(async (method) => {
    if (method !== 'eth_feeHistory') throw new Error(`unexpected ${method}`);
    if (recent instanceof Error) throw recent;
    return { reward: recent.map((tip) => [`0x${tip.toString(16)}`]) };
  });
  vi.spyOn(provider, 'getBlock').mockResolvedValue({ baseFeePerGas: baseFee } as never);
  return provider;
}

function fakeProvider(perform: () => Promise<unknown>, block: unknown = { baseFeePerGas: baseFee }) {
  return { getBlock: async () => block, _perform: perform } as unknown as AbstractProvider;
}

/** A real FallbackProvider over two JSON-RPC backends whose eth_maxPriorityFeePerGas answers are stubbed. */
function fallbackWith(...tips: Array<bigint | Error>) {
  const network = Network.from(8453);
  const backends = tips.map(() => new JsonRpcProvider('http://127.0.0.1:1', network, { staticNetwork: network }));
  backends.forEach((backend, i) => {
    vi.spyOn(backend, '_perform').mockImplementation(async (req) => {
      if (req.method !== 'getPriorityFee') throw new Error(`unexpected ${req.method}`);
      const tip = tips[i]!;
      if (tip instanceof Error) throw tip;
      return `0x${tip.toString(16)}`;
    });
    // getFeeData() is what FallbackProvider would use; it must not be what prices the tx.
    vi.spyOn(backend, 'getFeeData').mockRejectedValue(new Error('getFeeData must not be used'));
  });
  const fallback = new FallbackProvider(backends.map((provider, i) => ({ provider, priority: i + 1 })), network, { quorum: 1 });
  vi.spyOn(fallback, 'getBlock').mockResolvedValue({ baseFeePerGas: baseFee } as never);
  return fallback;
}

describe('BaseEvmClient fee fields', () => {
  it('uses the tip the RPC reports', async () => {
    const client = newClient().withProvider(fakeProvider(async () => '0x1e8480'));
    expect(await client.feeFields()).toEqual({ maxPriorityFeePerGas: 2_000_000n, maxFeePerGas: baseFee * 2n + 2_000_000n });
  });

  it('falls back to a small tip, not 1 gwei, when the tip read fails', async () => {
    const client = newClient().withProvider(fakeProvider(async () => { throw new Error('rate limited'); }));
    const fees = await client.feeFields();
    expect(fees.maxPriorityFeePerGas).toBe(DEFAULT_PRIORITY_FEE_WEI);
    expect(fees.maxFeePerGas).toBe(baseFee * 2n + DEFAULT_PRIORITY_FEE_WEI);
  });

  it('asks a FallbackProvider backend by backend, skipping one that fails', async () => {
    const client = newClient().withProvider(fallbackWith(new Error('timeout'), 3_000_000n));
    expect(await client.feeFields()).toEqual({ maxPriorityFeePerGas: 3_000_000n, maxFeePerGas: baseFee * 2n + 3_000_000n });
  });

  it('never prices a FallbackProvider tx at the 1 gwei default when every backend fails', async () => {
    const client = newClient().withProvider(fallbackWith(new Error('timeout'), new Error('rate limited')));
    const fees = await client.feeFields();
    expect(fees.maxPriorityFeePerGas).toBe(DEFAULT_PRIORITY_FEE_WEI);
    expect(fees.maxPriorityFeePerGas).toBeLessThan(1_000_000_000n);
  });

  it('raises a tip the RPC suggests below what recent blocks include', async () => {
    // The RPC suggests 0.001 gwei while recent blocks' low-end tips are around 0.02 gwei.
    const client = newClient().withProvider(rpcWithTips(1_000_000n, [20_000_000n, 13_000_000n, 22_000_000n]));
    expect(await client.feeFields()).toEqual({ maxPriorityFeePerGas: 20_000_000n, maxFeePerGas: baseFee * 2n + 20_000_000n });
  });

  it('keeps the suggested tip when it is above recent blocks', async () => {
    const client = newClient().withProvider(rpcWithTips(30_000_000n, [20_000_000n]));
    expect((await client.feeFields()).maxPriorityFeePerGas).toBe(30_000_000n);
  });

  it('caps how far recent blocks raise the tip', async () => {
    const client = newClient().withProvider(rpcWithTips(1_000_000n, [5_000_000_000n]));
    expect((await client.feeFields()).maxPriorityFeePerGas).toBe(100_000_000n);
  });

  it('uses the suggested tip when fee history cannot be read', async () => {
    const client = newClient().withProvider(rpcWithTips(2_000_000n, new Error('method not found')));
    expect((await client.feeFields()).maxPriorityFeePerGas).toBe(2_000_000n);
  });

  it('leaves pricing to the signer when the base fee cannot be read', async () => {
    const client = newClient().withProvider({ getBlock: async () => { throw new Error('ECONNREFUSED'); } } as unknown as AbstractProvider);
    expect(await client.feeFields()).toEqual({});
  });

  it('leaves pricing to the signer on chains without a base fee', async () => {
    const client = newClient().withProvider(fakeProvider(async () => '0x1', { baseFeePerGas: null }));
    expect(await client.feeFields()).toEqual({});
  });
});
