import { describe, expect, it, vi } from 'vitest';
import { Interface, type AbstractProvider } from 'ethers';
import { createCachedMulticallReader, multicallRead, MULTICALL3_ADDRESS } from './multicall.js';

const aggregate = new Interface(['function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[])']);
const iface = new Interface(['function value(uint256) view returns (uint256)']);
const requests = Array.from({ length: 80 }, (_, index) => ({ target: '0x0000000000000000000000000000000000000001', iface, method: 'value', args: [index] }));

function fixture() {
  const getCode = vi.fn(async () => '0x1234');
  const call = vi.fn(async ({ to, data }: { to: string; data: string }) => {
    if (to.toLowerCase() !== MULTICALL3_ADDRESS.toLowerCase()) return iface.encodeFunctionResult('value', [iface.decodeFunctionData('value', data)[0]]);
    const [calls] = aggregate.decodeFunctionData('aggregate3', data);
    return aggregate.encodeFunctionResult('aggregate3', [calls.map((entry: { callData: string }) => [true, iface.encodeFunctionResult('value', [iface.decodeFunctionData('value', entry.callData)[0]])])]);
  });
  return { provider: { call, getCode } as unknown as AbstractProvider, call, getCode };
}

describe('multicall failure budgets', () => {
  it('batches 80 reads into one eth_call', async () => {
    const { provider, call, getCode } = fixture();
    expect(await multicallRead(provider, requests)).toEqual(requests.map((_, index) => [BigInt(index)]));
    expect(call).toHaveBeenCalledTimes(1);
    expect(getCode).toHaveBeenCalledTimes(1);
  });

  it('does not fan out when the deployment probe fails', async () => {
    const { provider, call, getCode } = fixture();
    getCode.mockRejectedValue(new Error('HTTP 429'));
    await expect(multicallRead(provider, requests)).rejects.toThrow('HTTP 429');
    expect(call).not.toHaveBeenCalled();
  });

  it.each(['HTTP 429', 'network error', 'timeout', 'HTTP 503', 'Every RPC endpoint is rate limiting requests'])('does not split a batch on %s', async (message) => {
    const { provider, call } = fixture();
    call.mockRejectedValue(new Error(message));
    await expect(multicallRead(provider, requests)).rejects.toThrow(message);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('still splits a batch that exceeds a gas limit', async () => {
    const { provider, call } = fixture();
    call.mockRejectedValueOnce(new Error('gas required exceeds allowance'));
    expect(await multicallRead(provider, requests)).toHaveLength(80);
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('stops scheduling chunks after an infrastructure failure', async () => {
    const { provider, call } = fixture();
    call.mockRejectedValue(new Error('HTTP 503'));
    await expect(multicallRead(provider, requests, { chunkSize: 10, concurrency: 2 })).rejects.toThrow('HTTP 503');
    expect(call.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it('bounds individual fallback concurrency when Multicall is absent', async () => {
    const { provider, call, getCode } = fixture();
    getCode.mockResolvedValue('0x');
    let active = 0;
    let peak = 0;
    call.mockImplementation(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, 1));
      active--;
      return iface.encodeFunctionResult('value', [1n]);
    });
    expect(await multicallRead(provider, requests, { concurrency: 3 })).toHaveLength(80);
    expect(peak).toBeLessThanOrEqual(3);
  });

  it('stops individual fallback on infrastructure failure instead of returning zero-like results', async () => {
    const { provider, call, getCode } = fixture();
    getCode.mockResolvedValue('0x');
    call.mockRejectedValue(new Error('timeout'));
    await expect(multicallRead(provider, requests, { concurrency: 1 })).rejects.toThrow('timeout');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('preserves per-call revert isolation without Multicall', async () => {
    const { provider, call, getCode } = fixture();
    getCode.mockResolvedValue('0x');
    call.mockRejectedValueOnce(Object.assign(new Error('execution reverted'), { code: 'CALL_EXCEPTION', data: '0x' }));
    expect(await multicallRead(provider, requests.slice(0, 2), { concurrency: 1 })).toEqual([null, [1n]]);
  });

  it('does not treat an ethers missing-data transport error as a contract revert', async () => {
    const { provider, call, getCode } = fixture();
    getCode.mockResolvedValue('0x');
    call.mockRejectedValue(Object.assign(new Error('missing revert data: HTTP 429'), { code: 'CALL_EXCEPTION', data: null }));
    await expect(multicallRead(provider, requests, { concurrency: 1 })).rejects.toThrow('HTTP 429');
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('preserves failed subcalls and malformed return data without retrying the batch', async () => {
    const { provider, call } = fixture();
    call.mockResolvedValue(aggregate.encodeFunctionResult('aggregate3', [[[true, iface.encodeFunctionResult('value', [7n])], [false, '0x'], [true, '0x1234']]]));
    expect(await multicallRead(provider, requests.slice(0, 3))).toEqual([[7n], null, null]);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('uses the requested block for both the deployment probe and the calls', async () => {
    const { provider, call, getCode } = fixture();
    await multicallRead(provider, requests.slice(0, 1), { blockTag: 123 });
    expect(getCode).toHaveBeenCalledWith(MULTICALL3_ADDRESS, 123);
    expect(call).toHaveBeenCalledWith(expect.objectContaining({ blockTag: 123 }));
  });
});

describe('createCachedMulticallReader', () => {
  it('probes for Multicall3 once across reads', async () => {
    const { provider, call, getCode } = fixture();
    const read = createCachedMulticallReader(provider);
    expect(await read([])).toEqual([]);
    expect(getCode).not.toHaveBeenCalled();
    expect(await read(requests.slice(0, 2))).toEqual([[0n], [1n]]);
    expect(await read(requests.slice(2, 4))).toEqual([[2n], [3n]]);
    expect(getCode).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledTimes(2);
  });

  it('reads calls one by one, failures as null, after a failed probe and probes again next time', async () => {
    const { provider, call, getCode } = fixture();
    getCode.mockRejectedValueOnce(new Error('HTTP 503'));
    call.mockImplementationOnce(async () => { throw new Error('HTTP 429'); });
    const read = createCachedMulticallReader(provider);
    expect(await read(requests.slice(0, 2))).toEqual([null, [1n]]);
    expect(call).toHaveBeenCalledTimes(2);
    expect(await read(requests.slice(0, 2))).toEqual([[0n], [1n]]);
    expect(getCode).toHaveBeenCalledTimes(2);
    expect(call).toHaveBeenCalledTimes(3);
  });

  it('keeps reading calls one by one on a chain without Multicall3', async () => {
    const { provider, call, getCode } = fixture();
    getCode.mockResolvedValue('0x');
    const read = createCachedMulticallReader(provider);
    expect(await read(requests.slice(0, 2))).toEqual([[0n], [1n]]);
    expect(await read(requests.slice(0, 1))).toEqual([[0n]]);
    expect(getCode).toHaveBeenCalledTimes(1);
    expect(call).toHaveBeenCalledTimes(3);
  });
});
