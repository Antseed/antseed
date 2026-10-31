import { AbiCoder, Interface, Wallet, ZeroHash, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import {
  KBF_ROUND_ABI,
  KbfRoundClient,
  kbfEpochDeadlines,
  type KbfServiceResult,
} from '../src/payments/evm/kbf-round-client.js';
import { VERIFIER_VERDICT, modelHash, serviceHash } from '../src/payments/evm/kbf-verdict.js';
import { queryInBlockChunks, resolveScanFromBlock } from '../src/payments/evm/block-range.js';

const CONTRACT = getAddress('0x' + '10'.repeat(20));
const GATE = getAddress('0x' + '20'.repeat(20));
const PUBLISHER = getAddress('0x' + '30'.repeat(20));
const VERIFIER = getAddress('0x' + '40'.repeat(20));
const iface = new Interface(KBF_ROUND_ABI);
const gateIface = new Interface([
  'function currentEpoch() view returns (uint256)',
  'function genesis() view returns (uint256)',
  'function epochDuration() view returns (uint256)',
]);

const SCHEDULE = [3n * 86_400n, 86_400n, 43_200n, 100n, 8n];
const EPOCH_INFO = [
  1_000n, 55n, '0x' + 'ab'.repeat(32), 2n, 3n, SCHEDULE,
  '0x' + '01'.repeat(32), '0x' + '02'.repeat(32), ZeroHash, '0x' + '03'.repeat(32),
  '0x' + '04'.repeat(32), false, PUBLISHER, 77n, '0x' + '05'.repeat(32),
];

interface RawLog {
  address: string;
  topics: string[];
  data: string;
  blockNumber: number;
  blockHash: string;
  transactionHash: string;
  transactionIndex: number;
  index: number;
  removed: boolean;
}

function log(name: string, args: unknown[], index = 0): RawLog {
  const encoded = iface.encodeEventLog(name, args);
  return {
    address: CONTRACT, topics: encoded.topics, data: encoded.data, blockNumber: 900 + index,
    blockHash: '0x' + 'ee'.repeat(32), transactionHash: '0x' + String(index).padStart(64, '0'), transactionIndex: 0, index, removed: false,
  };
}

/** An ethers runner that answers contract calls from fixtures and serves logs. */
function fakeProvider(options: { logs?: RawLog[]; head?: number; send?: (method: string, params: unknown[]) => Promise<unknown> } = {}) {
  const getLogs = vi.fn(async (filter: { topics?: Array<string | null> }) =>
    (options.logs ?? []).filter((entry) => !filter.topics?.[0] || entry.topics[0] === filter.topics[0]));
  const provider = {
    provider: null as unknown,
    async call(tx: { to: string; data: string }) {
      if (getAddress(tx.to) === GATE) {
        const parsed = gateIface.parseTransaction({ data: tx.data })!;
        const value = { currentEpoch: 7n, genesis: 1_000n, epochDuration: 604_800n }[parsed.name as 'currentEpoch'];
        return gateIface.encodeFunctionResult(parsed.name, [value]);
      }
      const parsed = iface.parseTransaction({ data: tx.data })!;
      switch (parsed.name) {
        case 'emissionsGate': return iface.encodeFunctionResult('emissionsGate', [GATE]);
        case 'epochInfo': return iface.encodeFunctionResult('epochInfo', [EPOCH_INFO]);
        case 'schedule': return iface.encodeFunctionResult('schedule', [SCHEDULE]);
        case 'models': return iface.encodeFunctionResult('models', [[[modelHash('model-a'), 'model-a']]]);
        case 'pendingReward': return iface.encodeFunctionResult('pendingReward', [123n]);
        default: throw new Error(`unexpected call ${parsed.name}`);
      }
    },
    getLogs,
    getBlockNumber: async () => options.head ?? 1_000,
    send: options.send,
    async getNetwork() { return { chainId: 8453n }; },
    resolveName: async (name: string) => name,
  };
  provider.provider = provider;
  return provider;
}

function client(config: { deploymentBlock?: number; logQueryChunkBlocks?: number } = { deploymentBlock: 500 }, provider = fakeProvider()) {
  const instance = new KbfRoundClient({ rpcUrl: 'http://127.0.0.1:1', contractAddress: CONTRACT, ...config });
  (instance as unknown as { _provider: unknown })._provider = provider;
  return instance;
}

describe('KbfRoundClient reads', () => {
  it('decodes the nested epoch tuple and schedule', async () => {
    const info = await client().epochInfo(7n);
    expect(info).toEqual({
      epoch: 7n, startedAt: 1_000, seedBlock: 55n, seed: '0x' + 'ab'.repeat(32), modelsVersion: 2, verifierCount: 3,
      schedule: { collectSeconds: 259_200, backupSeconds: 86_400, attestSeconds: 43_200, probesPerService: 100, slicesPerService: 8 },
      bankHash: '0x' + '01'.repeat(32), bankKeyHash: '0x' + '02'.repeat(32), bankKey: ZeroHash, planHash: '0x' + '03'.repeat(32),
      finalizedRoot: '0x' + '04'.repeat(32), voided: false, publisher: PUBLISHER, takenOverAt: 77,
      keySharesHash: '0x' + '05'.repeat(32),
    });
    expect(await client().schedule()).toEqual(info.schedule);
    expect(kbfEpochDeadlines(info, 604_800)).toEqual({
      startedAt: 1_000, commitDeadline: 260_200, backupDeadline: 346_600, attestDeadline: 389_800, endsAt: 605_800,
    });
  });

  it('reads epochs and models through the emissions gate and the model list', async () => {
    const c = client();
    expect(await c.currentEpoch()).toBe(7n);
    expect(await c.genesis()).toBe(1_000);
    expect(await c.epochDuration()).toBe(604_800);
    expect(await c.models(2)).toEqual([{ modelHash: modelHash('model-a'), service: 'model-a' }]);
    expect(await c.pendingReward(VERIFIER, 7n, 3, 8, [])).toBe(123n);
  });

  it('reads chain time and head uncached, falling back across providers', async () => {
    const send = vi.fn(async (method: string) => method === 'eth_blockNumber' ? '0x10' : { timestamp: '0x64' });
    const direct = client(undefined, fakeProvider({ send }));
    expect(await direct.now()).toBe(100);
    expect(await direct.latestBlockNumber()).toBe(16);
    expect(send).toHaveBeenCalledWith('eth_getBlockByNumber', ['latest', false]);

    const failing = { send: vi.fn(async () => { throw new Error('rate limited'); }) };
    const working = { send: vi.fn(async () => ({ timestamp: '0xc8' })) };
    const fallback = client();
    (fallback as unknown as { _provider: unknown })._provider = { providerConfigs: [{ provider: failing }, { provider: working }] };
    expect(await fallback.now()).toBe(200);
    expect(failing.send).toHaveBeenCalledOnce();

    const down = client();
    (down as unknown as { _provider: unknown })._provider = { providerConfigs: [{ provider: failing }] };
    await expect(down.now()).rejects.toThrow(/rate limited/);
    const empty = client(undefined, fakeProvider({ send: async () => null }));
    await expect(empty.now()).rejects.toThrow(/latest block unavailable/);
  });
});

describe('KbfRoundClient events', () => {
  it('maps each event field to its place', async () => {
    const logs = [
      log('BankCommitted', [7n, '0x' + '01'.repeat(32), '0x' + '02'.repeat(32), 'ipfs://bank'], 1),
      log('PlanCommitted', [7n, '0x' + '03'.repeat(32), 'ipfs://plan'], 2),
      log('SlicesCommitted', [7n, VERIFIER, true, '0x' + '06'.repeat(32), 'ipfs://slices'], 3),
      log('Attested', [7n, VERIFIER, '0x' + '07'.repeat(32), 'ipfs://results'], 4),
      log('KeySharesCommitted', [7n, '0x' + '05'.repeat(32), 'ipfs://shares'], 5),
      log('KeyShareRevealed', [7n, VERIFIER, '0x01aa'], 6),
    ];
    const c = client({ deploymentBlock: 500 }, fakeProvider({ logs }));
    expect(await c.bankCommits(7n)).toEqual([
      { epoch: 7n, bankHash: '0x' + '01'.repeat(32), bankKeyHash: '0x' + '02'.repeat(32), bankUri: 'ipfs://bank', blockNumber: 901 },
    ]);
    expect(await c.planCommits(7n)).toMatchObject([
      { epoch: 7n, hash: '0x' + '03'.repeat(32), uri: 'ipfs://plan', sender: PUBLISHER, logIndex: 2 },
    ]);
    expect(await c.sliceCommits(7n)).toMatchObject([
      { epoch: 7n, sender: VERIFIER, backup: true, hash: '0x' + '06'.repeat(32), uri: 'ipfs://slices', blockNumber: 903 },
    ]);
    expect(await c.attestationEvents(7n)).toMatchObject([
      { epoch: 7n, sender: VERIFIER, backup: false, hash: '0x' + '07'.repeat(32), uri: 'ipfs://results' },
    ]);
    expect(await c.keySharesCommits(7n)).toMatchObject([
      { epoch: 7n, hash: '0x' + '05'.repeat(32), uri: 'ipfs://shares', sender: PUBLISHER },
    ]);
    expect(await c.keyShareReveals(7n)).toEqual([{ epoch: 7n, verifier: VERIFIER, share: '0x01aa', blockNumber: 906, logIndex: 6 }]);
  });

  it('scans from the deployment block to head in bounded windows, open-ended at the top', async () => {
    const provider = fakeProvider({ head: 25_500 });
    const c = client({ deploymentBlock: 1_000 }, provider);
    await c.sliceCommits(7n);
    expect(provider.getLogs.mock.calls.map(([filter]) => [(filter as { fromBlock: number }).fromBlock, (filter as { toBlock: number | string }).toBlock]))
      .toEqual([[1_000, 10_999], [11_000, 20_999], [21_000, 'latest']]);

    provider.getLogs.mockClear();
    await c.sliceCommits(7n, 25_000);
    expect(provider.getLogs.mock.calls.map(([filter]) => [(filter as { fromBlock: number }).fromBlock, (filter as { toBlock: number | string }).toBlock]))
      .toEqual([[25_000, 'latest']]);
  });

  it('requires an explicit fromBlock when the deployment block is unknown', async () => {
    const provider = fakeProvider({ head: 100 });
    const c = client({}, provider);
    await expect(c.sliceCommits(7n)).rejects.toThrow(/explicit fromBlock/);
    expect(provider.getLogs).not.toHaveBeenCalled();
    await c.sliceCommits(7n, 0);
    expect(provider.getLogs).toHaveBeenCalledOnce();
  });
});

describe('KbfRoundClient writes', () => {
  function writer() {
    const c = client();
    const execWrite = vi.fn().mockResolvedValue('0xtx');
    (c as unknown as { _execWrite: typeof execWrite })._execWrite = execWrite;
    return { c, execWrite };
  }

  it('encodes results and proofs for applyResults', async () => {
    const { c, execWrite } = writer();
    const signer = Wallet.createRandom();
    const results: KbfServiceResult[] = [
      { agentId: 3n, serviceHash: serviceHash('Model-A '), modelHash: modelHash('model-a'), verdict: VERIFIER_VERDICT.DIFF },
    ];
    const proofs = [['0x' + '09'.repeat(32)]];
    await expect(c.applyResults(signer, 7n, results, proofs)).resolves.toBe('0xtx');
    const call = execWrite.mock.calls[0]!;
    expect(call.slice(2)).toEqual([
      'applyResults', 7n, [[3n, serviceHash('model-a'), modelHash('model-a'), VERIFIER_VERDICT.DIFF]], proofs,
    ]);
    const decoded = iface.decodeFunctionData('applyResults', iface.encodeFunctionData('applyResults', call.slice(3)));
    expect(decoded[1][0].agentId).toBe(3n);
    expect(Number(decoded[1][0].verdict)).toBe(2);
  });

  it('encodes claims, commitments and reveals in contract order', async () => {
    const { c, execWrite } = writer();
    const signer = Wallet.createRandom();
    await c.claimRewards(signer, 7n, 3, 8, ['0x' + '0a'.repeat(32)]);
    await c.commitPlan(signer, 7n, '0x' + '03'.repeat(32), 'ipfs://plan');
    await c.commitSlices(signer, 7n, '0x' + '06'.repeat(32), 'ipfs://slices');
    await c.revealKeyShare(signer, 7n, '0x01aa');
    await c.takeOverBank(signer, 7n, '0x' + '01'.repeat(32), keccak256(AbiCoder.defaultAbiCoder().encode(['bytes32'], ['0x' + '0b'.repeat(32)])), 'ipfs://bank');
    const names = execWrite.mock.calls.map((call) => call[2]);
    expect(names).toEqual(['claimRewards', 'commitPlan', 'commitSlices', 'revealKeyShare', 'takeOverBank']);
    expect(execWrite.mock.calls[0]!.slice(3)).toEqual([7n, 3, 8, ['0x' + '0a'.repeat(32)]]);
    for (const call of execWrite.mock.calls) {
      expect(() => iface.encodeFunctionData(call[2] as string, call.slice(3))).not.toThrow();
    }
    expect(serviceHash('  Model-A ')).toBe(keccak256(toUtf8Bytes('model-a')));
  });
});

describe('block ranges', () => {
  it('pages an inclusive range in bounded windows', async () => {
    const query = vi.fn(async (from: number, to: number | 'latest') => [`${from}-${to}`]);
    await expect(queryInBlockChunks(100, 25_099, query, { chunkBlocks: 10_000 })).resolves.toEqual([
      '100-10099',
      '10100-20099',
      '20100-25099',
    ]);
    await expect(queryInBlockChunks(7, 7, query)).resolves.toEqual(['7-7']);
    query.mockClear();
    await expect(queryInBlockChunks(10, 9, query)).resolves.toEqual([]);
    expect(query).not.toHaveBeenCalled();
    await expect(queryInBlockChunks(0, 1, query, { chunkBlocks: 0 })).rejects.toThrow(/chunkBlocks/);
  });

  it('leaves the final window open-ended when scanning to head', async () => {
    const query = vi.fn(async (from: number, to: number | 'latest') => [`${from}-${to}`]);
    await expect(queryInBlockChunks(0, 15_000, query, { openEnded: true })).resolves.toEqual(['0-9999', '10000-latest']);
    // A stale head snapshot below the floor still asks the node for new blocks.
    await expect(queryInBlockChunks(20, 10, query, { openEnded: true })).resolves.toEqual(['20-latest']);
  });

  it('defaults the lower bound to the deployment block and never to genesis', () => {
    expect(resolveScanFromBlock(undefined, 500)).toBe(500);
    expect(resolveScanFromBlock(0, 500)).toBe(0);
    expect(() => resolveScanFromBlock(undefined, undefined)).toThrow(/explicit fromBlock/);
  });
});
