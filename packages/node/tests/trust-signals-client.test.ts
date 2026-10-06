import { describe, expect, it, vi } from 'vitest';
import { AbiCoder, Interface, type AbstractProvider } from 'ethers';
import { TrustSignalsClient } from '../src/payments/evm/trust-signals-client.js';
import { MULTICALL3_ADDRESS } from '../src/payments/evm/multicall.js';

const REGISTRY = '0x' + '11'.repeat(20);
const CHANNELS = '0x' + '22'.repeat(20);
const POOLS = '0x' + '33'.repeat(20);
const USAGE = '0x' + '44'.repeat(20);
const WASH = '0x' + '55'.repeat(20);
const SELLER_A = '0x' + 'aa'.repeat(20);
const SELLER_B = '0x' + 'bb'.repeat(20);
const SELLER_C = '0x' + 'cc'.repeat(20);

const MULTICALL_IFACE = new Interface(['function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)']);
const IFACE = new Interface([
  'function getAgentId(address seller) view returns (uint256)',
  'function getAgentStats(uint256 agentId) view returns (uint64 channelCount, uint64 ghostCount, uint256 totalVolumeUsdc, uint64 lastSettledAt)',
  'function poolWeightAtEpoch(uint256 agentId, uint256 epoch) view returns (uint256)',
  'function poolActiveStakeAtEpoch(uint256 agentId, uint256 epoch) view returns (uint256)',
  'function totalPowerWeightAtEpoch(uint256 epoch) view returns (uint256)',
  'function currentEpoch() view returns (uint256)',
  'function sellerPointsByEpoch(uint256 epoch, address seller) view returns (uint256)',
  'function totalPoolPointsByEpoch(uint256 epoch) view returns (uint256)',
  'function isProvenWashTrader(address seller) view returns (bool)',
  'function provenWashShareBps(address seller) view returns (uint256)',
]);
const coder = AbiCoder.defaultAbiCoder();

/** Simulates the contracts; throws for unknown sellers like a reverting read. */
function answer(target: string, data: string): string {
  const parsed = IFACE.parseTransaction({ data })!;
  const [arg0, arg1] = parsed.args as unknown[];
  const seller = typeof arg0 === 'string' ? arg0.toLowerCase() : typeof arg1 === 'string' ? arg1.toLowerCase() : undefined;
  const agentOf: Record<string, bigint> = { [SELLER_A]: 7n, [SELLER_B]: 8n };
  switch (parsed.name) {
    case 'getAgentId': return coder.encode(['uint256'], [agentOf[seller!] ?? 0n]);
    case 'currentEpoch': return coder.encode(['uint256'], [22n]);
    case 'isProvenWashTrader': return coder.encode(['bool'], [seller === SELLER_B]);
    case 'provenWashShareBps': return coder.encode(['uint256'], [seller === SELLER_B ? 4_000n : 0n]);
    case 'getAgentStats': return coder.encode(['uint64', 'uint64', 'uint256', 'uint64'], [120n, 3n, 9_000_000_000n, 1_700_000_000n]);
    case 'totalPowerWeightAtEpoch': return coder.encode(['uint256'], [4_000n * 10n ** 18n]);
    case 'poolWeightAtEpoch': return coder.encode(['uint256'], [(arg0 === 7n ? 1_000n : 0n) * 10n ** 18n]);
    case 'poolActiveStakeAtEpoch': return coder.encode(['uint256'], [arg0 === 7n ? 125n * 10n ** 17n : 0n]);
    case 'sellerPointsByEpoch': return coder.encode(['uint256'], [arg0 === 21n && seller === SELLER_A ? 90_000_000n : 0n]);
    case 'totalPoolPointsByEpoch': return coder.encode(['uint256'], [arg0 === 21n ? 360_000_000n : 0n]);
    default: throw new Error(`unexpected ${parsed.name} on ${target}`);
  }
}

function fakeProvider(multicall: boolean) {
  const calls = vi.fn(async (tx: { to?: string; data?: string }): Promise<string> => {
    if (tx.to?.toLowerCase() === MULTICALL3_ADDRESS.toLowerCase()) {
      const [requests] = MULTICALL_IFACE.decodeFunctionData('aggregate3', tx.data!) as unknown as [Array<{ target: string; callData: string }>];
      const results = requests.map((request) => {
        try { return { success: true, returnData: answer(request.target, request.callData) }; }
        catch { return { success: false, returnData: '0x' }; }
      });
      return MULTICALL_IFACE.encodeFunctionResult('aggregate3', [results]);
    }
    return answer(tx.to!, tx.data!);
  });
  const provider = { call: calls, getCode: vi.fn(async () => (multicall ? '0x6080' : '0x')), provider: undefined } as unknown as AbstractProvider;
  (provider as unknown as { provider: unknown }).provider = provider;
  return { provider, calls };
}

const addresses = { sellerRegistry: REGISTRY, channels: CHANNELS, sellerPools: POOLS, usageAccounting: USAGE, washTradingRegistry: WASH };

describe('TrustSignalsClient', () => {
  it('reads every signal for a batch of sellers in two multicall round trips', async () => {
    const { provider, calls } = fakeProvider(true);
    const client = new TrustSignalsClient(provider, addresses);
    const signals = await client.read([SELLER_A, SELLER_B, SELLER_C]);
    expect(calls).toHaveBeenCalledTimes(2);
    expect(signals.get(SELLER_C)).toBeUndefined();
    expect(signals.get(SELLER_A)).toEqual({
      agentId: 7, channelCount: 120, ghostCount: 3, totalVolumeUsdcMicros: 9_000_000_000, lastSettledAtSec: 1_700_000_000,
      usageEpoch: 22, usageShareBps: 2_500, usageLastEpochUsdcMicros: 90_000_000,
      poolStakeAnts: 12.5, poolPowerShareBps: 2_500, washFlagged: false, washShareBps: 0,
    });
    expect(signals.get(SELLER_B)).toMatchObject({ agentId: 8, washFlagged: true, washShareBps: 4_000, poolPowerShareBps: 0, poolStakeAnts: 0, usageShareBps: 0, usageLastEpochUsdcMicros: 0 });
    // The Multicall3 probe runs once per client, not per read.
    await client.read([SELLER_A]);
    expect(provider.getCode).toHaveBeenCalledTimes(1);
  });

  it('skips unconfigured contracts and leaves their signals undefined', async () => {
    const { provider } = fakeProvider(true);
    const client = new TrustSignalsClient(provider, { sellerRegistry: REGISTRY, channels: CHANNELS });
    const signals = await client.read([SELLER_A]);
    expect(signals.get(SELLER_A)).toEqual({ agentId: 7, channelCount: 120, ghostCount: 3, totalVolumeUsdcMicros: 9_000_000_000, lastSettledAtSec: 1_700_000_000 });
  });

  it('falls back to individual calls on chains without Multicall3', async () => {
    const { provider, calls } = fakeProvider(false);
    const signals = await new TrustSignalsClient(provider, addresses).read([SELLER_A]);
    expect(signals.get(SELLER_A)?.usageShareBps).toBe(2_500);
    expect(calls.mock.calls.length).toBeGreaterThan(2);
  });
});
