import { describe, expect, it } from 'vitest';
import {
  gateMinterId,
  GATE_MINTERS,
  positionState,
  projectedEarlyExitSlashBps,
  sellerProofId,
  validateSellerProofArtifact,
  type SellerPoolPosition,
} from '../src/payments/index.js';
import { getChainConfig, resolveChainConfig, withRecognizedUsageDefaults } from '../src/payments/chain-config.js';

const position: SellerPoolPosition = {
  id: 7, owner: '0x000000000000000000000000000000000000dEaD', agentId: 3, amount: 1_000n * 10n ** 18n, weightAmount: 4_000n * 10n ** 18n,
  stakeStartEpoch: 22, stakeEndEpoch: 30, closedAtEpoch: 0, withdrawn: false,
};
const config = { maxSlashBps: 5_000, minEarlyExitSlashBps: 500 };

describe('gate minter ids', () => {
  it('match the M001 deployment ids', () => {
    const ids = Object.fromEntries(GATE_MINTERS.map((minter) => [minter.name, gateMinterId(minter.id)]));
    expect(ids['reserve']).toBe('0xc5ff0896e227b527ec15c29fed8fdddb30dd7562dccfe4eafd612355a4391db1');
    expect(ids['seller-pools']).toBe('0xa62b9f89b07ddfaebb7e521489999092e5eeba0d6f2ca72881d564ec0835e1c9');
    expect(ids['usage']).toBe('0x80b0fa4ac620ab5d40fced6c24f02a433da5e4f883f854c8b09da72e16309922');
    expect(ids['team']).toBe('0x34122b5459e2da08531926b6b4824cc655b2042f1cf2d88aaaf4c6d19308669e');
    expect(ids['verification']).toBe('0xd8018a5ea0ce31650e6d51e87c96f1d258a180b37e42ce66e7adf1c8ac666b57');
  });
});

describe('position helpers', () => {
  it('derives the lifecycle state from the epoch', () => {
    expect(positionState(position, 21)).toBe('pending');
    expect(positionState(position, 22)).toBe('active');
    expect(positionState(position, 30)).toBe('matured');
    expect(positionState({ ...position, closedAtEpoch: 25 }, 26)).toBe('closed');
    expect(positionState({ ...position, withdrawn: true }, 40)).toBe('withdrawn');
  });

  it('mirrors the contract early-exit curve with whole-epoch rounding and clamps', () => {
    expect(projectedEarlyExitSlashBps(position, 22, config)).toBe(5_000); // all 8 epochs remaining
    expect(projectedEarlyExitSlashBps(position, 26, config)).toBe(2_500); // halfway
    expect(projectedEarlyExitSlashBps(position, 29, config)).toBe(625); // 1/8 remaining
    expect(projectedEarlyExitSlashBps({ ...position, stakeEndEpoch: 122 }, 121, config)).toBe(500); // 1/100 → clamp to min
    expect(projectedEarlyExitSlashBps(position, 30, config)).toBe(0); // matured
    expect(projectedEarlyExitSlashBps(position, 10, config)).toBe(5_000); // before start uses the start epoch
    expect(projectedEarlyExitSlashBps(position, 26, config, true)).toBe(5_000); // max-locked always max
  });
});

describe('seller proof artifacts', () => {
  const chunkA = { index: 0, references: [{ number: 100, blockHash: `0x${'aa'.repeat(32)}` }, { number: 101, blockHash: `0x${'ab'.repeat(32)}` }], proof: [`0x${'11'.repeat(32)}`] };
  const chunkB = { index: 1, references: [{ number: 102, blockHash: `0x${'ac'.repeat(32)}` }], proof: [`0x${'22'.repeat(32)}`] };
  const artifact = {
    version: 3, kind: 'antseed-wash-trading-seller-proof', proofArchitecture: 'direct-seller-v1', chainId: 8453,
    seller: '0x48F4142F4AbF7b77a03f0cDffcd511eDD9B6d54a', publicValues: '0x1234', proofBytes: '0xabcdef',
    blockReferenceCount: 3, blockAuthenticationChunkSize: 2, blockAuthenticationChunkCount: 2, blockAuthenticationChunks: [chunkA, chunkB],
  };

  it('accepts a well-formed direct seller artifact', () => {
    const validated = validateSellerProofArtifact(artifact);
    expect(validated.blockAuthenticationChunks).toHaveLength(2);
    expect(validated.blockAuthenticationChunks[0]!.references[1]!.number).toBe(101);
    expect(sellerProofId(validated.publicValues)).toBe(sellerProofId('0x1234'));
  });

  it('rejects other artifact kinds, unordered references, and count mismatches', () => {
    expect(() => validateSellerProofArtifact({ ...artifact, kind: 'antseed-wash-trading-proof-result' })).toThrow(/kind/);
    expect(() => validateSellerProofArtifact({ ...artifact, blockReferenceCount: 4 })).toThrow(/declare 4/);
    expect(() => validateSellerProofArtifact({ ...artifact, blockAuthenticationChunks: [chunkA, { ...chunkB, references: [{ number: 50, blockHash: chunkB.references[0]!.blockHash }] }] })).toThrow(/strictly increasing/);
    expect(() => validateSellerProofArtifact({ ...artifact, blockAuthenticationChunks: [{ ...chunkA, references: chunkA.references.slice(0, 1) }, chunkB], blockReferenceCount: 2 })).toThrow(/exactly 2/);
    expect(() => validateSellerProofArtifact({ ...artifact, proofArchitecture: 'aggregate-v0' })).toThrow(/direct-seller-v1/);
  });
});

describe('recognized-usage chain defaults', () => {
  it('fills the individual contract fields from the deployment record without overriding explicit values', () => {
    const base = getChainConfig('base-mainnet');
    expect(base.recognizedUsage?.status).toBe('active');
    expect(base.sellerPoolsAddress?.toLowerCase()).toBe(base.recognizedUsage?.contracts.sellerPools.toLowerCase());
    expect(base.washTradingRegistryAddress?.toLowerCase()).toBe(base.recognizedUsage?.contracts.washTradingRegistry.toLowerCase());
    const overridden = resolveChainConfig({ chainId: 'base-mainnet', sellerPoolsAddress: '0x0000000000000000000000000000000000000001' });
    expect(overridden.sellerPoolsAddress).toBe('0x0000000000000000000000000000000000000001');
    expect(overridden.usageAccountingAddress?.toLowerCase()).toBe(base.recognizedUsage?.contracts.usageAccounting.toLowerCase());
    expect(withRecognizedUsageDefaults({ ...base, recognizedUsage: undefined, sellerPoolsAddress: undefined }).sellerPoolsAddress).toBeUndefined();
  });
});

describe('multicallRead', () => {
  it('runs chunks a few at a time and keeps results in request order', async () => {
    const { Interface } = await import('ethers');
    const { multicallRead, MULTICALL3_ADDRESS } = await import('../src/payments/evm/multicall.js');
    const iface = new Interface(['function value(uint256 id) view returns (uint256)']);
    const aggregate = new Interface(['function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)']);
    let inFlight = 0;
    let maxInFlight = 0;
    const provider = {
      getCode: async () => '0x60',
      call: async (tx: { data: string }) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight -= 1;
        const [calls] = aggregate.decodeFunctionData('aggregate3', tx.data) as unknown as [Array<{ callData: string }>];
        const returnData = calls.map((call) => {
          const [id] = iface.decodeFunctionData('value', call.callData) as unknown as [bigint];
          return { success: true, returnData: iface.encodeFunctionResult('value', [id * 10n]) };
        });
        return aggregate.encodeFunctionResult('aggregate3', [returnData]);
      },
      resolveName: async (name: string) => name,
    };
    const requests = Array.from({ length: 95 }, (_, id) => ({ target: MULTICALL3_ADDRESS, iface, method: 'value', args: [id] }));
    const results = await multicallRead(provider as never, requests, { chunkSize: 10, concurrency: 3 });
    expect(results.map((entry) => entry?.[0])).toEqual(requests.map((_, id) => BigInt(id * 10)));
    expect(maxInFlight).toBe(3);
  });
});
