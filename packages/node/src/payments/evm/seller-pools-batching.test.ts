import { describe, expect, it, vi } from 'vitest';
import { Contract, Interface, type AbstractProvider } from 'ethers';
import { SellerPoolsClient, type SellerPoolPosition } from './seller-pools-client.js';
import { MULTICALL3_ADDRESS } from './multicall.js';

const address = '0x0000000000000000000000000000000000000001';
const aggregate = new Interface(['function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[])']);
const abi = new Interface([
  'function positions(uint256) view returns (address,uint256,uint256,uint256,uint64,uint64,uint64,bool)',
  'function positionWithdrawableEpoch(uint256) view returns (uint64)',
  'function positionMaxLockPowerAtEpoch(uint256,uint256) view returns (uint256)',
  'function earlyExitSlashBps(uint256) view returns (uint256)',
  ...['minStakeEpochs', 'MAX_STAKE_EPOCHS', 'stakeActivationDelay', 'maxSlashBps', 'minEarlyExitSlashBps', 'restakedRewardWeightBonusBps', 'moveWeightPenaltyBps'].map(name => `function ${name}() view returns (uint256)`),
]);

function fixture() {
  const read = vi.fn((method: string, _args: readonly unknown[]): unknown[] => {
    if (method === 'positions') return [address, 1n, 100n, 100n, 1n, 20n, 0n, false];
    if (method === 'positionMaxLockPowerAtEpoch') return [0n];
    if (method === 'earlyExitSlashBps') return [1250n];
    return [1n];
  });
  const encode = (data: string) => {
    const parsed = abi.parseTransaction({ data })!;
    return abi.encodeFunctionResult(parsed.fragment, read(parsed.name, parsed.args));
  };
  const call = vi.fn(async ({ to, data }: { to: string; data: string }) => {
    if (to.toLowerCase() !== MULTICALL3_ADDRESS.toLowerCase()) return encode(data);
    const [calls] = aggregate.decodeFunctionData('aggregate3', data);
    return aggregate.encodeFunctionResult('aggregate3', [calls.map((entry: { callData: string }) => {
      try { return [true, encode(entry.callData)]; } catch { return [false, '0x']; }
    })]);
  });
  const getCode = vi.fn(async () => '0x1234');
  const provider = { call, getCode } as unknown as AbstractProvider;
  const client = new SellerPoolsClient({ rpcUrl: 'http://localhost:8545', contractAddress: address, antsTokenAddress: address, evmChainId: 8453 }).withProvider(provider);
  return { client, call, getCode, read, provider };
}

async function individualStatuses(client: SellerPoolsClient, positions: SellerPoolPosition[], epoch: number) {
  return Promise.all(positions.map(async position => {
    const open = !position.withdrawn && position.closedAtEpoch === 0;
    const withdrawableEpoch = await client.positionWithdrawableEpoch(position.id);
    return {
      withdrawableEpoch,
      maxLocked: open ? await client.isMaxLocked(position.id, Math.max(epoch, position.stakeStartEpoch)) : false,
      maxLockedNext: open ? await client.isMaxLocked(position.id, Math.max(epoch + 1, position.stakeStartEpoch)) : false,
      slashBps: open && epoch >= withdrawableEpoch ? await client.earlyExitSlashBps(position.id) : null,
    };
  }));
}

describe('seller pool read batching', () => {
  it.each([
    { count: 0, before: 7, after: 2 },
    { count: 20, before: 107, after: 6 },
    // Four status reads per open position (withdrawable, max lock now and next epoch, slash) push 100 positions over one multicall chunk.
    { count: 100, before: 507, after: 11 },
  ])('preserves values for $count positions while reducing RPC calls from $before to $after', async ({ count, before, after }) => {
    const { client, call, getCode, provider } = fixture();
    const ids = Array.from({ length: count }, (_, index) => index + 1);
    const originalPositions = await Promise.all(ids.map(id => client.position(id)));
    const originalStatuses = await individualStatuses(client, originalPositions, 10);
    const configContract = new Contract(address, abi, provider);
    const configNames = ['minStakeEpochs', 'MAX_STAKE_EPOCHS', 'stakeActivationDelay', 'maxSlashBps', 'minEarlyExitSlashBps', 'restakedRewardWeightBonusBps', 'moveWeightPenaltyBps'];
    const originalConfig = await Promise.all(configNames.map(name => configContract.getFunction(name)()));
    expect(call.mock.calls.length + getCode.mock.calls.length).toBe(before);
    call.mockClear();
    getCode.mockClear();
    const positions = await client.positionsBatch(ids);
    expect(positions).toEqual(originalPositions);
    expect(await client.positionStatusesBatch(positions, 10)).toEqual(originalStatuses);
    expect(Object.values(await client.poolConfig())).toEqual(originalConfig.map(Number));
    expect(call.mock.calls.length + getCode.mock.calls.length).toBe(after);
  });

  it('does not read the chain for empty position lists', async () => {
    const { client, call, getCode } = fixture();
    expect(await client.positionsBatch([])).toEqual([]);
    expect(await client.positionStatusesBatch([], 10)).toEqual([]);
    expect(call).not.toHaveBeenCalled();
    expect(getCode).not.toHaveBeenCalled();
  });

  it('preserves duplicate ids and requested ordering', async () => {
    const { client } = fixture();
    expect((await client.positionsBatch([9, 1, 9])).map(position => position.id)).toEqual([9, 1, 9]);
  });

  it('rejects missing position and configuration values instead of returning zeros', async () => {
    const { client, read } = fixture();
    read.mockImplementation(() => { throw new Error('revert'); });
    await expect(client.positionsBatch([1])).rejects.toThrow(/positions/);
    await expect(client.poolConfig()).rejects.toThrow(/minStakeEpochs/);
  });

  it('preserves closed, withdrawn, pending, future-start and max-locked status semantics', async () => {
    const { client, read } = fixture();
    const original = await client.positionsBatch([1, 2, 3, 4, 5]);
    original[0]!.closedAtEpoch = 8;
    original[1]!.withdrawn = true;
    original[3]!.stakeStartEpoch = 12;
    read.mockImplementation((method, args) => {
      if (method === 'positionWithdrawableEpoch') return [args[0] === 3n ? 11n : 1n];
      if (method === 'positionMaxLockPowerAtEpoch') return [args[0] === 5n ? 500n : 0n];
      if (method === 'earlyExitSlashBps' && args[0] === 3n) throw new Error('pending change');
      return [1250n];
    });
    const expected = await individualStatuses(client, original, 10);
    read.mockClear();
    expect(await client.positionStatusesBatch(original, 10)).toEqual(expected);
    expect(read).toHaveBeenCalledWith('positionMaxLockPowerAtEpoch', expect.arrayContaining([4n, 12n]));
    expect(read.mock.calls.some(([method, args]) => method === 'earlyExitSlashBps' && (args[0] === 1n || args[0] === 2n))).toBe(false);
  });

  it.each(['positionWithdrawableEpoch', 'positionMaxLockPowerAtEpoch', 'earlyExitSlashBps'])('rejects a missing required %s value', async method => {
    const { client, read } = fixture();
    const positions = await client.positionsBatch([1]);
    read.mockImplementation(name => {
      if (name === method) throw new Error('revert');
      return [1n];
    });
    await expect(client.positionStatusesBatch(positions, 10)).rejects.toThrow(method);
  });
});
