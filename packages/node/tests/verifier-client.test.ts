import { EventLog, Interface, Wallet, getAddress } from 'ethers';
import { describe, expect, it, vi } from 'vitest';
import {
  KBF_AUDITS_ABI,
  VERIFICATION_RESULTS_ABI,
  VerifierClient,
  VERIFICATION_REWARDS_OFF,
  VERIFIER_VERDICT,
  validateAuditorProfile,
  modelHash,
  serviceHash,
  sortServiceResults,
} from '../src/payments/evm/verifier-client.js';
import { queryInBlockChunks, resolveScanFromBlock } from '../src/payments/evm/block-range.js';

const VERIFICATION_ADDRESS = '0x' + '10'.repeat(20);
const RESULTS_ADDRESS = '0x' + '20'.repeat(20);

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
      KBF_AUDITS_ABI,
      'submitModelAudit',
      7n,
      modelHash('model-a'),
      '0x' + '99'.repeat(32),
      'ipfs://bafytest',
      sortServiceResults(results).map((result) => [result.agentId, result.serviceHash, result.verdict]),
    );
    const encoded = new Interface(KBF_AUDITS_ABI).encodeFunctionData('submitModelAudit', execWrite.mock.calls[0]!.slice(3));
    expect(encoded.startsWith('0x')).toBe(true);
  });

  it('exposes model and service audit events', () => {
    const iface = new Interface(KBF_AUDITS_ABI);
    expect(iface.getEvent('ServiceAudited')?.inputs.map((input) => input.name)).toEqual([
      'agentId',
      'serviceHash',
      'auditor',
      'modelHash',
      'verdict',
      'round',
      'reports',
      'required',
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
    expect(iface.getFunction('reportKey')).not.toBeNull();
    expect(iface.getFunction('evidenceAuditor')).toBeNull();
    expect(iface.getFunction('diffChanges')).toBeNull();
    expect(new Interface(VERIFICATION_RESULTS_ABI).getFunction('diffChanges')).not.toBeNull();
    expect(iface.getFunction('auditorEpochCredits')).toBeNull();
  });

  it('splits the ABI across the KBF audit and the results layer', () => {
    const results = new Interface(VERIFICATION_RESULTS_ABI);
    expect(results.getFunction('serviceStatus')?.outputs[0]?.components?.map((part) => part.name)).toEqual([
      'modelHash', 'verdict', 'updatedAt', 'epoch', 'audit', 'validUntilEpoch',
    ]);
    expect(results.getEvent('ServiceStatusChanged')?.inputs.map((input) => input.name)).toEqual([
      'agentId', 'serviceHash', 'modelHash', 'previous', 'current', 'audit', 'epoch', 'validUntilEpoch',
    ]);
    expect(results.getEvent('ServiceCleared')?.inputs.map((input) => input.name)).toEqual([
      'agentId', 'serviceHash', 'epoch', 'clears',
    ]);
    expect(results.getFunction('claimAuditorReward')?.inputs.map((input) => input.type)).toEqual(['address', 'uint256']);
    expect(results.getFunction('pendingAuditorReward')?.inputs.map((input) => input.name)).toEqual(['audit', 'auditor', 'epoch']);
    for (const removed of ['claimRewards', 'settleEpochRemainder', 'unclaimableRemainder', 'voidCredits', 'validityEpochs', 'registry']) {
      expect(results.getFunction(removed), removed).toBeNull();
    }
    expect(results.getFunction('submitModelAudit')).toBeNull();
    const kbf = new Interface(KBF_AUDITS_ABI);
    expect(kbf.getEvent('AuditorSet')?.inputs.map((input) => input.name)).toEqual(['auditor', 'approved', 'revocations']);
    expect(kbf.getFunction('approvedAuditors')).not.toBeNull();
    expect(kbf.getFunction('validityEpochs')).not.toBeNull();
    expect(kbf.getEvent('AuditCredited')?.inputs.map((input) => input.name)).toEqual(['epoch', 'auditor', 'modelHash', 'credits']);
    expect(kbf.getFunction('verifierSet')).toBeNull();
  });
});

describe('VerifierClient contract routing', () => {
  /** Answers eth_call for the three contracts from `answers[address][method]`. */
  function stubProvider(client: VerifierClient, answers: Record<string, Record<string, (args: unknown[]) => unknown[]>>) {
    const ifaces = [new Interface(KBF_AUDITS_ABI), new Interface(VERIFICATION_RESULTS_ABI)];
    const calls: Array<{ to: string; method: string; args: unknown[] }> = [];
    const call = vi.fn(async (tx: { to: string; data: string }) => {
      const to = tx.to.toLowerCase();
      for (const iface of ifaces) {
        const parsed = iface.parseTransaction({ data: tx.data });
        const answer = parsed && answers[to]?.[parsed.name];
        if (!parsed || !answer) continue;
        calls.push({ to, method: parsed.name, args: [...parsed.args] });
        return iface.encodeFunctionResult(parsed.fragment, answer([...parsed.args]));
      }
      throw new Error(`unexpected call to ${to}`);
    });
    const provider = {
      call,
      resolveName: async (name: string) => name,
      getNetwork: async () => ({ chainId: 8453n }),
      provider: undefined as unknown,
    };
    provider.provider = provider;
    (client as unknown as { _provider: unknown })._provider = provider;
    return calls;
  }

  it('discovers the results layer from the KBF contract once and reads auditors from the KBF contract', async () => {
    const client = new VerifierClient({ rpcUrl: 'http://127.0.0.1:1', contractAddress: VERIFICATION_ADDRESS });
    const auditor = '0x' + '44'.repeat(20);
    const calls = stubProvider(client, {
      [VERIFICATION_ADDRESS]: {
        results: () => [RESULTS_ADDRESS],
        creditedAudits: () => [1n],
        creditsFor: () => [3n],
        maxCreditsPerModelPerEpoch: () => [1n],
        validityEpochs: () => [2n],
        identityRegistry: () => ['0x' + '66'.repeat(20)],
        approvedAuditors: () => [true],
        auditorProfile: () => [['Acme Labs', 'ipfs://icon', 'https://acme.example']],
      },
      [RESULTS_ADDRESS]: {
        pendingAuditorReward: () => [5n],
        auditorEpochCredits: () => [2n],
        epochCredits: () => [4n],
        maxCreditsPerAuditorPerEpoch: () => [100n],
        rewardsStartEpoch: () => [VERIFICATION_REWARDS_OFF],
        auditShareBps: () => [10_000n],
        auditShareBpsAt: () => [5_000n],
        maxAuditorShareBps: () => [2_000n],
        serviceStatus: () => [['0x' + 'aa'.repeat(32), 2n, 7n, 9n, VERIFICATION_ADDRESS, 11n]],
      },
    });

    expect(await client.resultsAddress()).toBe(getAddress(RESULTS_ADDRESS));
    expect(await client.pendingAuditorReward(auditor, 8)).toBe(5n);
    expect(await client.auditCredits(auditor, 8)).toEqual({ auditor: 2n, total: 4n });
    expect(await client.creditLimits()).toEqual({ perAuditor: 100n, perModel: 1n });
    expect(await client.approvedAuditor(auditor)).toBe(true);
    expect(await client.auditorProfile(auditor)).toEqual({
      name: 'Acme Labs', iconUri: 'ipfs://icon', url: 'https://acme.example',
    });
    expect(await client.rewardSettings()).toEqual({
      rewardsStartEpoch: VERIFICATION_REWARDS_OFF, shareBps: 10_000, maxAuditorShareBps: 2_000,
    });
    expect((await client.rewardSettings(8)).shareBps).toBe(5_000);
    expect(await client.creditedAudits(8, auditor, '0x' + 'bb'.repeat(32))).toBe(1n);
    expect(await client.creditsFor('0x' + 'bb'.repeat(32))).toBe(3n);
    expect(await client.validityEpochs()).toBe(2);
    expect(await client.identityRegistry()).toBe(getAddress('0x' + '66'.repeat(20)));
    expect(await client.serviceStatusByHash(1n, '0x' + '01'.repeat(32))).toEqual({
      modelHash: '0x' + 'aa'.repeat(32), verdict: 2, updatedAt: 7n, epoch: 9n,
      audit: getAddress(VERIFICATION_ADDRESS), validUntilEpoch: 11n,
    });

    expect(calls.filter((entry) => entry.method === 'results')).toHaveLength(1);
    const kbf = getAddress(VERIFICATION_ADDRESS);
    expect(calls.find((entry) => entry.method === 'pendingAuditorReward')).toMatchObject({ to: RESULTS_ADDRESS, args: [kbf, getAddress(auditor), 8n] });
    expect(calls.find((entry) => entry.method === 'auditorEpochCredits')).toMatchObject({ args: [kbf, 8n, getAddress(auditor)] });
    expect(calls.find((entry) => entry.method === 'epochCredits')).toMatchObject({ args: [kbf, 8n] });
    expect(calls.find((entry) => entry.method === 'approvedAuditors')).toMatchObject({ to: VERIFICATION_ADDRESS });
    expect(calls.find((entry) => entry.method === 'maxCreditsPerAuditorPerEpoch')).toMatchObject({ to: RESULTS_ADDRESS, args: [kbf] });
    expect(calls.find((entry) => entry.method === 'rewardsStartEpoch')).toMatchObject({ args: [kbf] });
    expect(calls.find((entry) => entry.method === 'auditShareBpsAt')).toMatchObject({ args: [kbf, 8n] });
    for (const method of ['validityEpochs', 'identityRegistry', 'creditsFor', 'creditedAudits']) {
      expect(calls.find((entry) => entry.method === method), method).toMatchObject({ to: VERIFICATION_ADDRESS });
    }
  });

  it('validates auditor profiles the way the KBF contract does', () => {
    expect(() => validateAuditorProfile({ name: 'Acme ✓', iconUri: 'ipfs://bafy', url: 'https://acme.example/a?b=1' })).not.toThrow();
    expect(() => validateAuditorProfile({ name: '', iconUri: '', url: '' })).not.toThrow();
    expect(() => validateAuditorProfile({ name: 'a'.repeat(65), iconUri: '', url: '' })).toThrow(/longer than 64/);
    expect(() => validateAuditorProfile({ name: 'a\nb', iconUri: '', url: '' })).toThrow(/control/);
    for (const bad of ['javascript:alert(1)', 'http://x.example', 'https://', 'https://x.example/a b', 'https://x.example/"x', 'https://x.example/<x>']) {
      expect(() => validateAuditorProfile({ name: '', iconUri: bad, url: '' }), bad).toThrow(/profile icon/);
    }
    expect(() => validateAuditorProfile({ name: '', iconUri: '', url: `https://${'a'.repeat(250)}` })).toThrow(/longer than 256/);
  });

  it('sets the profile on the KBF contract', async () => {
    const client = new VerifierClient({ rpcUrl: 'http://127.0.0.1:1', contractAddress: VERIFICATION_ADDRESS, resultsAddress: RESULTS_ADDRESS });
    const execWrite = vi.fn().mockResolvedValue('0xtx');
    const writerPrototype = Object.getPrototypeOf(Object.getPrototypeOf(client)) as { _execWrite: unknown };
    const spy = vi.spyOn(writerPrototype as { _execWrite: typeof execWrite }, '_execWrite').mockImplementation(async function (this: { contractAddress: string }, ...args: unknown[]) {
      return execWrite(this.contractAddress, ...args);
    });
    try {
      const signer = Wallet.createRandom();
      await client.setAuditorProfile(signer, { name: 'Acme', iconUri: 'ipfs://icon', url: '' });
      expect(execWrite).toHaveBeenCalledWith(
        getAddress(VERIFICATION_ADDRESS), signer, KBF_AUDITS_ABI, 'setAuditorProfile', 'Acme', 'ipfs://icon', '',
      );
      await expect(client.setAuditorProfile(signer, { name: '', iconUri: 'javascript:x', url: '' })).rejects.toThrow(/https/);
    } finally {
      spy.mockRestore();
    }
  });

  it('uses a configured results address without asking the KBF contract', async () => {
    const client = new VerifierClient({
      rpcUrl: 'http://127.0.0.1:1', contractAddress: VERIFICATION_ADDRESS, resultsAddress: RESULTS_ADDRESS,
    });
    const calls = stubProvider(client, { [RESULTS_ADDRESS]: { isVerified: () => [true] } });
    expect(await client.isVerified(7)).toBe(true);
    expect(calls.map((entry) => entry.to)).toEqual([RESULTS_ADDRESS]);
  });

  it('claims KBF rewards on the results contract, one epoch per transaction, with the KBF contract as the audit', async () => {
    const client = new VerifierClient({ rpcUrl: 'http://127.0.0.1:1', contractAddress: VERIFICATION_ADDRESS, resultsAddress: RESULTS_ADDRESS });
    const execWrite = vi.fn().mockResolvedValue('0xclaim');
    const writerPrototype = Object.getPrototypeOf(Object.getPrototypeOf(client)) as { _execWrite: unknown };
    const spy = vi.spyOn(writerPrototype as { _execWrite: typeof execWrite }, '_execWrite').mockImplementation(async function (this: { contractAddress: string }, ...args: unknown[]) {
      return execWrite(this.contractAddress, ...args);
    });
    try {
      const signer = Wallet.createRandom();
      await expect(client.claimAuditorRewards(signer, [3, 4n])).resolves.toEqual(['0xclaim', '0xclaim']);
      expect(execWrite).toHaveBeenNthCalledWith(
        1, getAddress(RESULTS_ADDRESS), signer, VERIFICATION_RESULTS_ABI, 'claimAuditorReward', getAddress(VERIFICATION_ADDRESS), 3n,
      );
      expect(execWrite).toHaveBeenNthCalledWith(
        2, getAddress(RESULTS_ADDRESS), signer, VERIFICATION_RESULTS_ABI, 'claimAuditorReward', getAddress(VERIFICATION_ADDRESS), 4n,
      );
    } finally {
      spy.mockRestore();
    }
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
    const iface = new Interface(KBF_AUDITS_ABI);
    const fragment = iface.getEvent('AuditorSet')!;
    const log = (auditor: string, approved: boolean, blockNumber: number, index: number) => {
      const encoded = iface.encodeEventLog(fragment, [auditor, approved, approved ? 0n : 1n]);
      return new EventLog({
        ...encoded, address: VERIFICATION_ADDRESS, blockNumber, index, transactionHash: '0x' + 'ab'.repeat(32),
        blockHash: '0x' + 'cd'.repeat(32), transactionIndex: 0, removed: false,
      } as never, iface, fragment);
    };
    const a = '0x' + '11'.repeat(20);
    const b = '0x' + '22'.repeat(20);
    const queryFilter = vi.fn(async (_event: unknown, _from: number, _to: number | 'latest') => [log(b, true, 30, 1), log(a, true, 20, 0), log(a, false, 30, 0)]);
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
    expect(queryFilter.mock.calls[0]?.[1]).toBe(10); // scans from the KBF deployment block
  });
});
