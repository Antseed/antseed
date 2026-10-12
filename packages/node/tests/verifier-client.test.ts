import { Interface, Wallet } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import {
  VERIFICATION_ABI,
  VerifierClient,
  serviceHash,
  sortServiceResults,
} from '../src/payments/evm/verifier-client.js';
import { queryInBlockChunks, resolveScanFromBlock } from '../src/payments/evm/block-range.js';

const VERIFICATION_ADDRESS = '0x' + '10'.repeat(20);

describe('VerifierClient audit ABI', () => {
  const results = [
    { serviceHash: '0x' + '02'.repeat(32), modelHash: '0x' + 'bb'.repeat(32), passed: false },
    { serviceHash: '0x' + '01'.repeat(32), modelHash: '0x' + 'aa'.repeat(32), passed: true },
  ];

  it('normalizes service names before hashing', () => {
    expect(serviceHash('  GPT-5.6-SOL ')).toBe(serviceHash('gpt-5.6-sol'));
  });

  it('orders results by service hash', () => {
    expect(sortServiceResults(results).map((result) => result.serviceHash)).toEqual([
      '0x' + '01'.repeat(32),
      '0x' + '02'.repeat(32),
    ]);
  });

  it('submits an audit with results in contract order', async () => {
    const client = new VerifierClient({ rpcUrl: 'http://127.0.0.1:1', contractAddress: VERIFICATION_ADDRESS });
    const execWrite = vi.fn().mockResolvedValue('0xsubmit');
    (client as unknown as { _execWrite: typeof execWrite })._execWrite = execWrite;
    const signer = Wallet.createRandom();
    await expect(client.submitAudit(signer, {
      agentId: 9n,
      results,
      evidenceHash: '0x' + '99'.repeat(32),
      evidenceUri: 'ipfs://bafytest',
    })).resolves.toBe('0xsubmit');
    expect(execWrite).toHaveBeenCalledWith(
      signer,
      VERIFICATION_ABI,
      'submitAudit',
      9n,
      sortServiceResults(results).map((result) => [result.serviceHash, result.modelHash, result.passed]),
      '0x' + '99'.repeat(32),
      'ipfs://bafytest',
    );
  });

  it('exposes per-service audit events for routing', () => {
    const iface = new Interface(VERIFICATION_ABI);
    expect(iface.getEvent('ServiceAudited')?.inputs.map((input) => input.name)).toEqual([
      'agentId',
      'serviceHash',
      'modelHash',
      'passed',
    ]);
    expect(iface.getFunction('submitReport')).toBeNull();
    expect(iface.getFunction('claimAuditorRewards')).not.toBeNull();
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
        AgentAudited: () => 'audit-filter',
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

    await client.queryAudits(9n);
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

    await expect(client.queryAudits()).rejects.toThrow(/explicit fromBlock/);
    await expect(client.queryServiceAudits(1n)).rejects.toThrow(/explicit fromBlock/);
    expect(queryFilter).not.toHaveBeenCalled();
    await client.queryAudits(null, 0);
    expect(queryFilter.mock.calls.map(([, from, to]) => [from, to])).toEqual([[0, 'latest']]);
  });
});
