import { describe, expect, it, vi } from 'vitest';
import { AbiCoder, Interface, type AbstractProvider } from 'ethers';
import { VerificationSignalsClient } from '../src/payments/evm/verification-signals-client.js';
import { KBF_AUDITS_ABI, VERIFICATION_RESULTS_ABI, serviceHash } from '../src/payments/evm/verifier-client.js';
import { MULTICALL3_ADDRESS } from '../src/payments/evm/multicall.js';

const VERIFICATION = '0x' + '11'.repeat(20);
const RESULTS = '0x' + '33'.repeat(20);
const GATE = '0x' + '22'.repeat(20);
const MULTICALL_IFACE = new Interface(['function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)']);
// The results layer's reads, the KBF contract's `results()`, and the emissions gate's epoch read.
const IFACE = new Interface([
  ...VERIFICATION_RESULTS_ABI.filter((entry) => !entry.includes('currentEpoch')),
  ...KBF_AUDITS_ABI.filter((entry) => entry.includes('function results()')),
  'function currentEpoch() view returns (uint256)',
  'function bonusBps() view returns (uint256)',
  'function penaltyBps() view returns (uint256)',
]);
const POLICY = '0x' + '44'.repeat(20);
const coder = AbiCoder.defaultAbiCoder();
const hash = serviceHash;

/** verdict + epoch given per (agentId, service hash), counting two epochs as KBF does; missing entries are NONE. */
type Statuses = Record<string, { verdict: number; epoch: number } | 'revert'>;

function fakeProvider(statuses: Statuses, options: { currentEpoch?: number; multicall?: boolean; failEpoch?: boolean; agentStatus?: Record<number, [number, number]>; failAgentStatus?: boolean } = {}) {
  const answer = (target: string, data: string): string => {
    const parsed = IFACE.parseTransaction({ data })!;
    switch (parsed.name) {
      case 'results':
        expect(target.toLowerCase()).toBe(VERIFICATION);
        return coder.encode(['address'], [RESULTS]);
      case 'emissionsGate': return coder.encode(['address'], [GATE]);
      case 'currentEpoch':
        expect(target.toLowerCase()).toBe(GATE);
        if (options.failEpoch) throw new Error('revert');
        return coder.encode(['uint256'], [options.currentEpoch ?? 28]);
      case 'serviceStatus': {
        const [agentId, serviceHash] = parsed.args as unknown as [bigint, string];
        const status = statuses[`${agentId}:${serviceHash}`];
        if (status === 'revert') throw new Error('revert');
        expect(target.toLowerCase()).toBe(RESULTS);
        const epoch = status?.epoch ?? 0;
        return coder.encode(['tuple(bytes32,uint8,uint64,uint64,address,uint64)'], [[
          '0x' + '00'.repeat(32), status?.verdict ?? 0, 0, epoch, VERIFICATION, status ? epoch + 2 : 0,
        ]]);
      }
      case 'agentStatus': {
        const [agentId] = parsed.args as unknown as [bigint];
        const counts = options.agentStatus?.[Number(agentId)] ?? [0, 0];
        if (options.failAgentStatus) throw new Error('revert');
        return coder.encode(['tuple(uint16,uint16)'], [[counts[0], counts[1]]]);
      }
      case 'bonusBps': expect(target.toLowerCase()).toBe(POLICY); return coder.encode(['uint256'], [200]);
      case 'penaltyBps': expect(target.toLowerCase()).toBe(POLICY); return coder.encode(['uint256'], [400]);
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
    // The results address once, then one batched round for statuses + one for the gate epoch.
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('returns live SAME services next to DIFF ones from the same reads', async () => {
    const { provider, call } = fakeProvider({
      [`7:${hash('gpt-6.1-sol')}`]: { verdict: 2, epoch: 27 },     // DIFF, live
      [`7:${hash('claude-opus-5.5')}`]: { verdict: 1, epoch: 27 }, // SAME, live
      [`7:${hash('kimi-k3')}`]: { verdict: 1, epoch: 26 },         // SAME, expired
      [`7:${hash('grok-4.7')}`]: { verdict: 3, epoch: 27 },        // UNDETERMINED
    });
    const client = new VerificationSignalsClient(provider, VERIFICATION);
    const result = await client.readServiceVerdicts([
      { agentId: 7, services: ['gpt-6.1-sol', 'Claude-Opus-5.5', 'kimi-k3', 'grok-4.7'] },
    ]);
    expect(result.get(7)).toEqual({ diff: ['gpt-6.1-sol'], same: ['claude-opus-5.5'], agent: { sameCount: 0, diffCount: 0, pointsMultiplierBps: null } });
    const calls = call.mock.calls.length;
    await client.readDiffServices([{ agentId: 7, services: ['gpt-6.1-sol'] }]);
    // readDiffServices is the same read: one status multicall and one epoch read, no extra calls.
    expect(call.mock.calls.length - calls).toBeLessThanOrEqual(2);
  });

  it('reads the agent status and the policy rates (once an hour) into a points multiplier', async () => {
    let now = 1_000_000;
    const { provider, call } = fakeProvider({ [`7:${hash('a')}`]: { verdict: 2, epoch: 27 } }, { agentStatus: { 7: [2, 4] } });
    const client = new VerificationSignalsClient(provider, VERIFICATION, RESULTS, POLICY, () => now);
    const first = await client.readServiceVerdicts([{ agentId: 7, services: ['a'] }]);
    expect(first.get(7)?.agent).toEqual({ sameCount: 2, diffCount: 4, pointsMultiplierBps: 4_000 });
    const policyCalls = () => call.mock.calls.filter(([tx]) => JSON.stringify(tx).toLowerCase().includes('44'.repeat(20))).length;
    const readsBefore = policyCalls();
    now += 60_000;
    await client.readServiceVerdicts([{ agentId: 7, services: ['a'] }]);
    expect(policyCalls()).toBe(readsBefore);
  });

  it('omits an agent whose status read failed, so the caller keeps its last good penalty', async () => {
    const { provider } = fakeProvider({ [`7:${hash('a')}`]: { verdict: 2, epoch: 27 } }, { failAgentStatus: true });
    const client = new VerificationSignalsClient(provider, VERIFICATION, RESULTS, POLICY);
    expect((await client.readServiceVerdicts([{ agentId: 7, services: ['a'] }])).has(7)).toBe(false);
  });

  it('leaves the multiplier null without a policy address', async () => {
    const { provider } = fakeProvider({}, { agentStatus: { 7: [1, 0] } });
    const client = new VerificationSignalsClient(provider, VERIFICATION, RESULTS);
    expect((await client.readServiceVerdicts([{ agentId: 7, services: ['a'] }])).get(7)?.agent)
      .toEqual({ sameCount: 1, diffCount: 0, pointsMultiplierBps: null });
  });

  it('reads a configured results address without asking the KBF contract', async () => {
    const { provider, call } = fakeProvider({ [`7:${hash('a')}`]: { verdict: 2, epoch: 28 } });
    const client = new VerificationSignalsClient(provider, VERIFICATION, RESULTS);
    expect((await client.readDiffServices([{ agentId: 7, services: ['a'] }])).get(7)).toEqual(['a']);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('discovers the results address once', async () => {
    const { provider, call } = fakeProvider({ [`7:${hash('a')}`]: { verdict: 2, epoch: 28 } });
    const client = new VerificationSignalsClient(provider, VERIFICATION);
    await client.readDiffServices([{ agentId: 7, services: ['a'] }]);
    await client.readDiffServices([{ agentId: 7, services: ['a'] }]);
    const resultsReads = call.mock.calls.filter(([tx]) => (tx as { data: string }).data.includes(IFACE.getFunction('results')!.selector.slice(2)));
    expect(resultsReads).toHaveLength(1);
  });

  it('ignores a DIFF still waiting for its second auditor: serviceStatus keeps the recorded result', async () => {
    // One auditor reported DIFF this epoch; the contract needs two, so the
    // recorded status is still the earlier SAME (or NONE when never recorded).
    const { provider } = fakeProvider({
      [`1135214:${hash('gpt-6-astra')}`]: { verdict: 1, epoch: 28 },
    });
    const result = await new VerificationSignalsClient(provider, VERIFICATION)
      .readDiffServices([{ agentId: 1135214, services: ['gpt-6-astra', 'never-recorded'] }]);
    expect(result.get(1135214)).toEqual([]);
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

  it('uses the expiry each verdict carries', async () => {
    const { provider } = fakeProvider({ [`7:${hash('a')}`]: { verdict: 2, epoch: 26 } }, { currentEpoch: 27 });
    // Given in 26 and counting until 28 (exclusive), so still live in 27.
    expect((await new VerificationSignalsClient(provider, VERIFICATION)
      .readDiffServices([{ agentId: 7, services: ['a'] }])).get(7)).toEqual(['a']);
  });

  it('throws when the current epoch cannot be read', async () => {
    const { provider } = fakeProvider({}, { failEpoch: true });
    await expect(new VerificationSignalsClient(provider, VERIFICATION)
      .readDiffServices([{ agentId: 7, services: ['a'] }])).rejects.toThrow(/currentEpoch/);
  });

  it('works without Multicall3', async () => {
    const { provider } = fakeProvider({ [`7:${hash('a')}`]: { verdict: 2, epoch: 28 } }, { multicall: false });
    const result = await new VerificationSignalsClient(provider, VERIFICATION)
      .readDiffServices([{ agentId: 7, services: ['a'] }]);
    expect(result.get(7)).toEqual(['a']);
  });
});
