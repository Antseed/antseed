import { describe, expect, it, vi } from 'vitest';
import { AbiCoder, Interface, keccak256, toUtf8Bytes, type AbstractProvider } from 'ethers';
import { VerificationSignalsClient } from '../src/payments/evm/verification-signals-client.js';
import { MULTICALL3_ADDRESS } from '../src/payments/evm/multicall.js';

const VERIFICATION = '0x' + '11'.repeat(20);
const GATE = '0x' + '22'.repeat(20);
const MULTICALL_IFACE = new Interface(['function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)']);
const IFACE = new Interface([
  'function serviceStatus(uint256 agentId,bytes32 serviceHash) view returns ((bytes32 modelHash,uint8 verdict,uint64 updatedAt,uint64 epoch))',
  'function validityEpochs() view returns (uint8)',
  'function emissionsGate() view returns (address)',
  'function currentEpoch() view returns (uint256)',
]);
const coder = AbiCoder.defaultAbiCoder();
const hash = (service: string) => keccak256(toUtf8Bytes(service));

/** verdict + epoch per (agentId, service hash); missing entries are NONE. */
type Statuses = Record<string, { verdict: number; epoch: number } | 'revert'>;

function fakeProvider(statuses: Statuses, options: { currentEpoch?: number; multicall?: boolean; failValidity?: boolean } = {}) {
  const answer = (target: string, data: string): string => {
    const parsed = IFACE.parseTransaction({ data })!;
    switch (parsed.name) {
      case 'validityEpochs':
        if (options.failValidity) throw new Error('revert');
        return coder.encode(['uint8'], [2]);
      case 'emissionsGate': return coder.encode(['address'], [GATE]);
      case 'currentEpoch':
        expect(target.toLowerCase()).toBe(GATE);
        return coder.encode(['uint256'], [options.currentEpoch ?? 28]);
      case 'serviceStatus': {
        const [agentId, serviceHash] = parsed.args as unknown as [bigint, string];
        const status = statuses[`${agentId}:${serviceHash}`];
        if (status === 'revert') throw new Error('revert');
        return coder.encode(['tuple(bytes32,uint8,uint64,uint64)'], [[
          '0x' + '00'.repeat(32), status?.verdict ?? 0, 0, status?.epoch ?? 0,
        ]]);
      }
      default: throw new Error(`unexpected ${parsed.name}`);
    }
  };
  const call = vi.fn(async (tx: { to?: string; data?: string }): Promise<string> => {
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
  const provider = { call, getCode: vi.fn(async () => (options.multicall === false ? '0x' : '0x6080')), provider: undefined } as unknown as AbstractProvider;
  (provider as unknown as { provider: unknown }).provider = provider;
  return { provider, call };
}

describe('VerificationSignalsClient', () => {
  it('returns only services with a live DIFF verdict, per agent', async () => {
    const { provider, call } = fakeProvider({
      [`7:${hash('gpt-6.1-sol')}`]: { verdict: 2, epoch: 27 },     // DIFF, live through 28
      [`7:${hash('kimi-k3')}`]: { verdict: 2, epoch: 26 },         // DIFF, expired at 28
      [`7:${hash('claude-opus-5.5')}`]: { verdict: 1, epoch: 27 }, // SAME
      [`8:${hash('grok-4.7')}`]: { verdict: 3, epoch: 27 },        // UNDETERMINED
    });
    const client = new VerificationSignalsClient(provider, VERIFICATION);
    const result = await client.readDiffServices([
      { agentId: 7, services: [' GPT-6.1-Sol ', 'kimi-k3', 'claude-opus-5.5', 'unaudited-model'] },
      { agentId: 8, services: ['grok-4.7'] },
      { agentId: 0, services: ['ignored'] },
    ]);
    expect(result.get(7)).toEqual(['gpt-6.1-sol']);
    expect(result.get(8)).toEqual([]);
    expect(result.has(0)).toBe(false);
    // One batched round for statuses + one for the gate epoch.
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('caches the immutable emissions gate across reads', async () => {
    const { provider, call } = fakeProvider({ [`7:${hash('m')}`]: { verdict: 2, epoch: 28 } });
    const client = new VerificationSignalsClient(provider, VERIFICATION);
    await client.readDiffServices([{ agentId: 7, services: ['m'] }]);
    await client.readDiffServices([{ agentId: 7, services: ['m'] }]);
    const gateReads = call.mock.calls.filter(([tx]) => {
      const data = (tx as { data: string }).data;
      return data.includes(IFACE.getFunction('emissionsGate')!.selector.slice(2));
    });
    expect(gateReads).toHaveLength(1);
  });

  it('omits an agent whose status read failed so the caller can keep its last answer', async () => {
    const { provider } = fakeProvider({
      [`7:${hash('a')}`]: 'revert',
      [`8:${hash('b')}`]: { verdict: 2, epoch: 28 },
    });
    const result = await new VerificationSignalsClient(provider, VERIFICATION)
      .readDiffServices([{ agentId: 7, services: ['a'] }, { agentId: 8, services: ['b'] }]);
    expect(result.has(7)).toBe(false);
    expect(result.get(8)).toEqual(['b']);
  });

  it('throws when the validity window cannot be read', async () => {
    const { provider } = fakeProvider({}, { failValidity: true });
    await expect(new VerificationSignalsClient(provider, VERIFICATION)
      .readDiffServices([{ agentId: 7, services: ['a'] }])).rejects.toThrow(/validityEpochs/);
  });

  it('works without Multicall3', async () => {
    const { provider } = fakeProvider({ [`7:${hash('a')}`]: { verdict: 2, epoch: 28 } }, { multicall: false });
    const result = await new VerificationSignalsClient(provider, VERIFICATION)
      .readDiffServices([{ agentId: 7, services: ['a'] }]);
    expect(result.get(7)).toEqual(['a']);
  });
});
