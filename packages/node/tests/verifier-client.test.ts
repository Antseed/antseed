import { EventLog, Interface, Log, Wallet, type Provider } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import {
  VERIFICATION_ABI,
  VERIFIER_VERDICT_DIFF,
  VerifierClient,
  serviceHash,
  type SubmitVerificationBundleInput,
} from '../src/payments/evm/verifier-client.js';
import { queryInBlockChunks, resolveScanFromBlock } from '../src/payments/evm/block-range.js';

const VERIFICATION_ADDRESS = '0x' + '10'.repeat(20);
const AUDIT_ID = '0x' + '11'.repeat(32);
const SERVICE_HASH = '0x' + '44'.repeat(32);

describe('VerifierClient combined ABI', () => {
  it('normalizes service names before hashing', () => {
    expect(serviceHash('  GPT-5.6-SOL ')).toBe(serviceHash('gpt-5.6-sol'));
  });

  it('encodes one per-model verification bundle', async () => {
    const client = new VerifierClient({
      rpcUrl: 'http://127.0.0.1:1',
      contractAddress: VERIFICATION_ADDRESS,
    });
    const signer = Wallet.createRandom();
    const execWrite = vi.fn().mockResolvedValue('0xattest');
    (client as unknown as { _execWrite: typeof execWrite })._execWrite = execWrite;
    const input: SubmitVerificationBundleInput = {
      evidenceHash: '0x' + '99'.repeat(32),
      evidenceUri: 'ipfs://bafytest',
      results: [{
        agentId: 9,
        serviceHash: SERVICE_HASH,
        verdict: VERIFIER_VERDICT_DIFF,
      }],
    };

    await expect(client.submitVerificationBundle(signer, input)).resolves.toBe('0xattest');
    expect(execWrite).toHaveBeenCalledWith(
      signer,
      VERIFICATION_ABI,
      'submitVerificationBundle',
      input.evidenceHash,
      input.evidenceUri,
      [{ agentId: 9n, serviceHash: SERVICE_HASH, verdict: VERIFIER_VERDICT_DIFF }],
    );
  });

  it('keeps the verification ABI raw and consequence-free', () => {
    const iface = new Interface(VERIFICATION_ABI);
    expect(iface.getFunction('submitVerificationBundle')).not.toBeNull();
    expect(iface.getFunction('isVerificationSubmitted')).not.toBeNull();
    expect(iface.getFunction('verificationBundle')).not.toBeNull();
    expect(iface.getFunction('verificationResult')).not.toBeNull();
    expect(iface.getFunction('activeAgentDiffVerifierCount')).toBeNull();
    expect(iface.getFunction('activeServiceDiffVerifierCount')).toBeNull();
    expect(iface.getFunction('latestVerifierVerdict')).toBeNull();
    expect(iface.getFunction('clearVerifierVerdict')).toBeNull();
    expect(iface.getFunction('claimVerifierReward')).toBeNull();
    expect(iface.getFunction('pendingVerifierReward')).toBeNull();
    expect(iface.getFunction('epochCreditUsdMicros')).toBeNull();
    expect(iface.getFunction('emissionsGate')).toBeNull();
    expect(iface.getFunction('currentEpoch')).toBeNull();
    expect(iface.getFunction('agentPointsPenaltyBps')).toBeNull();
    expect(iface.getFunction('latestAttestation')).toBeNull();
    expect(iface.getFunction('servicePointsPenaltyBps')).toBeNull();
    expect(iface.getFunction('epochRewardClaimed')).toBeNull();
    expect(iface.getFunction('getAttestation')).toBeNull();
    expect(iface.getFunction('verificationStats')).toBeNull();
    expect(iface.getFunction('agentVerificationStats')).toBeNull();
    expect(iface.getFunction('verifierRegistry')).toBeNull();
    expect(iface.getFunction('gate')).toBeNull();
    expect(iface.getFunction('commitProbes')).toBeNull();
    expect(iface.getFunction('claimDelegateReward')).toBeNull();
  });

  it('exposes shared bundle and compact result event shapes', () => {
    const iface = new Interface(VERIFICATION_ABI);
    const bundle = iface.getEvent('VerificationBundleSubmitted');
    expect(bundle?.inputs.map((input) => input.name)).toEqual([
      'evidenceHash',
      'verifier',
      'resultCount',
      'evidenceUri',
    ]);
    const result = iface.getEvent('VerificationResultSubmitted');
    expect(result?.inputs.map((input) => input.name)).toEqual([
      'evidenceHash',
      'agentId',
      'serviceHash',
      'verifier',
      'verdict',
    ]);
  });

  it('parses the on-chain IPFS evidence URI from bundle events', () => {
    const client = new VerifierClient({
      rpcUrl: 'http://127.0.0.1:1',
      contractAddress: VERIFICATION_ADDRESS,
    });
    const iface = new Interface(VERIFICATION_ABI);
    const fragment = iface.getEvent('VerificationBundleSubmitted')!;
    const evidenceUri = 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3r3eifqeedsvt2eubqtskghpm';
    const encoded = iface.encodeEventLog(fragment, [AUDIT_ID, VERIFICATION_ADDRESS, 1, evidenceUri]);
    const log = new Log({
      transactionHash: '0x' + '22'.repeat(32),
      blockHash: '0x' + '33'.repeat(32),
      blockNumber: 12,
      removed: false,
      address: VERIFICATION_ADDRESS,
      data: encoded.data,
      topics: encoded.topics,
      index: 3,
      transactionIndex: 1,
    }, null as unknown as Provider);
    const parsed = (client as unknown as {
      _bundleEvents(logs: readonly unknown[]): Array<{ evidenceUri: string }>;
    })._bundleEvents([new EventLog(log, iface, fragment)]);

    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.evidenceUri).toBe(evidenceUri);
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
        VerificationBundleSubmitted: () => 'bundle-filter',
        VerificationResultSubmitted: () => 'result-filter',
      },
      queryFilter,
    };
    const internals = client as unknown as { _contract(): unknown; _provider: { getBlockNumber(): Promise<number> } };
    internals._contract = () => contract;
    internals._provider = { getBlockNumber: async () => head };
    return queryFilter;
  }

  it('scans bundles from the deployment block to head in 10k windows', async () => {
    const client = new VerifierClient({
      rpcUrl: 'http://127.0.0.1:1',
      contractAddress: VERIFICATION_ADDRESS,
      deploymentBlock: 1_000,
    });
    const queryFilter = stubContract(client, 25_500);

    await client.queryBundles(AUDIT_ID);
    expect(queryFilter.mock.calls.map(([, from, to]) => [from, to])).toEqual([
      [1_000, 10_999],
      [11_000, 20_999],
      [21_000, 'latest'],
    ]);

    queryFilter.mockClear();
    await client.queryAttestations(9n, 25_000, 25_100);
    expect(queryFilter.mock.calls.map(([, from, to]) => [from, to])).toEqual([[25_000, 25_100]]);
  });

  it('requires an explicit fromBlock when the deployment block is unknown', async () => {
    const client = new VerifierClient({ rpcUrl: 'http://127.0.0.1:1', contractAddress: VERIFICATION_ADDRESS });
    const queryFilter = stubContract(client, 100);

    await expect(client.queryBundles()).rejects.toThrow(/explicit fromBlock/);
    await expect(client.queryAttestations(1n)).rejects.toThrow(/explicit fromBlock/);
    expect(queryFilter).not.toHaveBeenCalled();
    await client.queryBundles(null, 0);
    expect(queryFilter.mock.calls.map(([, from, to]) => [from, to])).toEqual([[0, 'latest']]);
  });
});
