import { EventLog, Interface, Wallet } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import {
  VERIFICATION_ABI,
  VerifierClient,
  VERIFIER_VERDICT,
  modelHash,
  serviceHash,
  sortServiceResults,
} from '../src/payments/evm/verifier-client.js';
import { queryInBlockChunks, resolveScanFromBlock } from '../src/payments/evm/block-range.js';

const VERIFICATION_ADDRESS = '0x' + '10'.repeat(20);

describe('VerifierClient audit ABI', () => {
  const results = [
    { agentId: 2n, serviceHash: '0x' + '01'.repeat(32), verdict: VERIFIER_VERDICT.UNDETERMINED },
    { agentId: 1n, serviceHash: '0x' + '02'.repeat(32), verdict: VERIFIER_VERDICT.DIFF },
    { agentId: 1n, serviceHash: '0x' + '01'.repeat(32), verdict: VERIFIER_VERDICT.SAME },
  ];

  it('normalizes service names before hashing', () => {
    expect(serviceHash('  GPT-5.6-SOL ')).toBe(serviceHash('gpt-5.6-sol'));
  });

  it('orders results by agent, then service hash', () => {
    expect(sortServiceResults(results).map((result) => [result.agentId, result.serviceHash])).toEqual([
      [1n, '0x' + '01'.repeat(32)],
      [1n, '0x' + '02'.repeat(32)],
      [2n, '0x' + '01'.repeat(32)],
    ]);
  });

  it('mirrors the contract verdict enum', () => {
    expect(VERIFIER_VERDICT).toEqual({ NONE: 0, SAME: 1, DIFF: 2, UNDETERMINED: 3 });
  });

  it('submits a model audit with results in contract order', async () => {
    const client = new VerifierClient({ rpcUrl: 'http://127.0.0.1:1', contractAddress: VERIFICATION_ADDRESS });
    const execWrite = vi.fn().mockResolvedValue('0xsubmit');
    (client as unknown as { _execWrite: typeof execWrite })._execWrite = execWrite;
    const signer = Wallet.createRandom();
    await expect(client.submitModelAudit(signer, {
      expectedEpoch: 7n,
      modelHash: modelHash('model-a'),
      evidenceHash: '0x' + '99'.repeat(32),
      evidenceUri: 'ipfs://bafytest',
      results,
    })).resolves.toBe('0xsubmit');
    expect(execWrite).toHaveBeenCalledWith(
      signer,
      VERIFICATION_ABI,
      'submitModelAudit',
      7n,
      modelHash('model-a'),
      '0x' + '99'.repeat(32),
      'ipfs://bafytest',
      sortServiceResults(results).map((result) => [result.agentId, result.serviceHash, result.verdict]),
    );
    const encoded = new Interface(VERIFICATION_ABI).encodeFunctionData('submitModelAudit', execWrite.mock.calls[0]!.slice(3));
    expect(encoded.startsWith('0x')).toBe(true);
  });

  it('exposes model and service audit events', () => {
    const iface = new Interface(VERIFICATION_ABI);
    expect(iface.getEvent('ServiceAudited')?.inputs.map((input) => input.name)).toEqual([
      'agentId',
      'serviceHash',
      'auditor',
      'modelHash',
      'verdict',
    ]);
    expect(iface.getEvent('ModelAudited')?.inputs.map((input) => input.name)).toEqual([
      'modelHash',
      'auditor',
      'epoch',
      'evidenceHash',
      'evidenceUri',
      'resultCount',
    ]);
    expect(iface.getFunction('submitAudit')).toBeNull();
    expect(iface.getFunction('auditorEpochCredits')).not.toBeNull();
  });
});

describe('verifier event block ranges', () => {
  it('pages an inclusive range in bounded windows', async () => {
    const query = vi.fn(async (from: number, to: number) => [`${from}-${to}`]);
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
    await expect(queryInBlockChunks(0, 15_000, query, { openEnded: true })).resolves.toEqual([
      '0-9999',
      '10000-latest',
    ]);
    // A stale head snapshot below the floor still asks the node for new blocks.
    await expect(queryInBlockChunks(20, 10, query, { openEnded: true })).resolves.toEqual(['20-latest']);
  });

  it('defaults the lower bound to the deployment block and never to genesis', () => {
    expect(resolveScanFromBlock(undefined, 500)).toBe(500);
    expect(resolveScanFromBlock(0, 500)).toBe(0);
    expect(() => resolveScanFromBlock(undefined, undefined)).toThrow(/explicit fromBlock/);
  });

  function stubContract(client: VerifierClient, head: number) {
    const queryFilter = vi.fn(async (_event: unknown, _from: number, _to: number | 'latest') => [] as unknown[]);
    const contract = {
      filters: {
        ModelAudited: () => 'model-filter',
        ServiceAudited: () => 'service-filter',
      },
      queryFilter,
    };
    const internals = client as unknown as { _contract(): unknown; _provider: { getBlockNumber(): Promise<number> } };
    internals._contract = () => contract;
    internals._provider = { getBlockNumber: async () => head };
    return queryFilter;
  }

  it('scans audits from the deployment block to head in 10k windows', async () => {
    const client = new VerifierClient({
      rpcUrl: 'http://127.0.0.1:1',
      contractAddress: VERIFICATION_ADDRESS,
      deploymentBlock: 1_000,
    });
    const queryFilter = stubContract(client, 25_500);

    await client.queryModelAudits({ model: modelHash('model-a') });
    expect(queryFilter.mock.calls.map(([, from, to]) => [from, to])).toEqual([
      [1_000, 10_999],
      [11_000, 20_999],
      [21_000, 'latest'],
    ]);

    queryFilter.mockClear();
    await client.queryServiceAudits(9n, null, 25_000, 25_100);
    expect(queryFilter.mock.calls.map(([, from, to]) => [from, to])).toEqual([[25_000, 25_100]]);
  });

  it('requires an explicit fromBlock when the deployment block is unknown', async () => {
    const client = new VerifierClient({ rpcUrl: 'http://127.0.0.1:1', contractAddress: VERIFICATION_ADDRESS });
    const queryFilter = stubContract(client, 100);

    await expect(client.queryModelAudits()).rejects.toThrow(/explicit fromBlock/);
    await expect(client.queryServiceAudits(1n)).rejects.toThrow(/explicit fromBlock/);
    expect(queryFilter).not.toHaveBeenCalled();
    await client.queryModelAudits({}, 0);
    expect(queryFilter.mock.calls.map(([, from, to]) => [from, to])).toEqual([[0, 'latest']]);
  });

  it('reads AuditorSet events in order with their block timestamps', async () => {
    const client = new VerifierClient({ rpcUrl: 'http://127.0.0.1:1', contractAddress: VERIFICATION_ADDRESS, deploymentBlock: 10 });
    const iface = new Interface(VERIFICATION_ABI);
    const fragment = iface.getEvent('AuditorSet')!;
    const log = (auditor: string, approved: boolean, blockNumber: number, index: number) => {
      const encoded = iface.encodeEventLog(fragment, [auditor, approved]);
      return new EventLog({
        ...encoded, address: VERIFICATION_ADDRESS, blockNumber, index, transactionHash: '0x' + 'ab'.repeat(32),
        blockHash: '0x' + 'cd'.repeat(32), transactionIndex: 0, removed: false,
      } as never, iface, fragment);
    };
    const a = '0x' + '11'.repeat(20);
    const b = '0x' + '22'.repeat(20);
    const queryFilter = vi.fn(async () => [log(b, true, 30, 1), log(a, true, 20, 0), log(a, false, 30, 0)]);
    const getBlock = vi.fn(async (blockNumber: number) => ({ timestamp: blockNumber * 2 }));
    const internals = client as unknown as { _contract(): unknown; _provider: unknown };
    internals._contract = () => ({ filters: { AuditorSet: () => 'auditor-filter' }, queryFilter });
    internals._provider = { getBlockNumber: async () => 40, getBlock };

    const events = await client.queryAuditorSetEvents();
    expect(events.map((event) => [event.auditor.toLowerCase(), event.approved, event.blockNumber, event.logIndex, event.timestamp])).toEqual([
      [a, true, 20, 0, 40],
      [a, false, 30, 0, 60],
      [b, true, 30, 1, 60],
    ]);
    expect(getBlock).toHaveBeenCalledTimes(2);
  });
});
