import { Contract, Interface, isError, type AbstractProvider } from 'ethers';

/** Canonical Multicall3 deployment (same address on Base, Base Sepolia, and most EVM chains). */
export const MULTICALL3_ADDRESS = '0xcA11bde05977b3631167028862bE2a173976CA11';

const MULTICALL3_ABI = [
  'function aggregate3(tuple(address target, bool allowFailure, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)',
] as const;

export interface MulticallRequest {
  target: string;
  iface: Interface;
  method: string;
  args?: unknown[];
}

function batchCapacityError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /out of gas|gas required exceeds allowance|exceeds (?:the )?(?:block )?gas limit|(?:request|response|payload|batch)(?: size)? (?:is )?too large|(?:request|response|payload|batch) size (?:limit|exceeded)/i.test(message);
}

function contractRevert(error: unknown): boolean {
  return isError(error, 'CALL_EXCEPTION') && error.data !== null && error.data !== undefined;
}

/**
 * Batch many read calls into a few `eth_call`s via Multicall3 (`allowFailure`
 * per call: a reverting read yields `null` instead of failing the batch).
 * Falls back to individual calls when the chain has no Multicall3.
 */
export async function multicallRead(
  provider: AbstractProvider,
  requests: MulticallRequest[],
  options: { chunkSize?: number; concurrency?: number; address?: string; blockTag?: number | string; /** Skip the `eth_getCode` probe; the caller knows Multicall3 is deployed. */ assumeDeployed?: boolean } = {},
): Promise<Array<unknown[] | null>> {
  if (requests.length === 0) return [];
  const chunkSize = options.chunkSize ?? 80;
  const concurrency = options.concurrency ?? 4;
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || !Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new Error('Multicall chunkSize and concurrency must be positive integers');
  }
  const multicall = new Contract(options.address ?? MULTICALL3_ADDRESS, MULTICALL3_ABI, provider);
  const results: Array<unknown[] | null> = new Array(requests.length).fill(null);
  const code = options.assumeDeployed ? '0x1' : await provider.getCode(options.address ?? MULTICALL3_ADDRESS, options.blockTag);
  let stopped = false;
  const parallel = async (offsets: number[], read: (offset: number) => Promise<void>): Promise<void> => {
    await Promise.all(Array.from({ length: Math.min(concurrency, offsets.length) }, async () => {
      for (let next = offsets.shift(); next !== undefined && !stopped; next = offsets.shift()) {
        try {
          await read(next);
        } catch (error) {
          stopped = true;
          throw error;
        }
      }
    }));
  };
  if (code === '0x') {
    await parallel(requests.map((_, index) => index), async (index) => {
      const request = requests[index]!;
      let data: string;
      try {
        data = await provider.call({ to: request.target, data: request.iface.encodeFunctionData(request.method, request.args ?? []), ...(options.blockTag !== undefined ? { blockTag: options.blockTag } : {}) });
      } catch (error) {
        if (!contractRevert(error)) throw error;
        return;
      }
      try {
        results[index] = [...request.iface.decodeFunctionResult(request.method, data)];
      } catch {
        results[index] = null;
      }
    });
    return results;
  }
  const overrides = options.blockTag !== undefined ? { blockTag: options.blockTag } : {};
  const run = async (offset: number, size: number): Promise<void> => {
    const chunk = requests.slice(offset, offset + size);
    if (chunk.length === 0 || stopped) return;
    const calls = chunk.map((request) => ({ target: request.target, allowFailure: true, callData: request.iface.encodeFunctionData(request.method, request.args ?? []) }));
    let returned: Array<{ success: boolean; returnData: string }>;
    try {
      returned = await multicall.getFunction('aggregate3').staticCall(calls, overrides) as Array<{ success: boolean; returnData: string }>;
    } catch (error) {
      if (!batchCapacityError(error)) throw error;
      if (chunk.length === 1) return;
      const half = Math.ceil(chunk.length / 2);
      await run(offset, half);
      await run(offset + half, chunk.length - half);
      return;
    }
    returned.forEach((entry, index) => {
      const request = chunk[index]!;
      if (!entry.success || entry.returnData === '0x') return;
      try {
        results[offset + index] = [...request.iface.decodeFunctionResult(request.method, entry.returnData)];
      } catch {
        results[offset + index] = null;
      }
    });
  };
  const offsets = Array.from({ length: Math.ceil(requests.length / chunkSize) }, (_, index) => index * chunkSize);
  await parallel(offsets, offset => run(offset, chunkSize));
  return results;
}
