import { AbiCoder, Wallet, concat, getBytes, hexlify, toBeHex } from 'ethers';
import { describe, expect, it } from 'vitest';
import { METADATA_VERSION, ZERO_METADATA, decodeSpendingAuthMetadata, encodeMetadata } from './signatures.js';
import {
  MAX_WORKERS_PER_CHANNEL,
  WORKER_TAIL_MAGIC,
  decodeWorkerTail,
  encodeWorkerTail,
  withWorkerAttribution,
} from './worker-attribution.js';

const A = '0x1000000000000000000000000000000000000001';
const B = '0x2000000000000000000000000000000000000002';

const metadata = {
  ...ZERO_METADATA,
  cumulativeInputTokens: 1000n,
  cumulativeOutputTokens: 500n,
  cumulativeRequestCount: 2n,
};

describe('worker attribution block', () => {
  it('leaves metadata without workers byte-for-byte unchanged', () => {
    expect(encodeMetadata({ ...metadata, workers: [] })).toBe(encodeMetadata(metadata));
  });

  it('round-trips sorted entries appended after the ABI encoding', () => {
    const encoded = encodeMetadata({ ...metadata, workers: [{ worker: B, cumulativeAmount: 7n }, { worker: A, cumulativeAmount: 3000n }] });
    expect(encoded.endsWith(WORKER_TAIL_MAGIC.slice(2))).toBe(true);
    expect(decodeWorkerTail(encoded)).toEqual([
      { worker: A, cumulativeAmount: 3000n },
      { worker: B, cumulativeAmount: 7n },
    ]);
  });

  it('keeps the ABI head readable by decoders that ignore trailing bytes', () => {
    const encoded = encodeMetadata({ ...metadata, workers: [{ worker: A, cumulativeAmount: 1n }] });
    const [version, input, output, requests] = AbiCoder.defaultAbiCoder().decode(['uint256', 'uint256', 'uint256', 'uint256'], encoded);
    expect([version, input, output, requests]).toEqual([METADATA_VERSION, 1000n, 500n, 2n]);
    const decoded = decodeSpendingAuthMetadata(encoded);
    expect(decoded.services).toHaveLength(0);
    expect(decoded.workers).toEqual([{ worker: A, cumulativeAmount: 1n }]);
  });

  it('finds no block in plain metadata', () => {
    expect(decodeWorkerTail(encodeMetadata(metadata))).toBeNull();
  });

  it('rejects malformed blocks the way the contract does', () => {
    const head = encodeMetadata(metadata);
    const entry = (worker: string, amount: bigint) => concat([worker, toBeHex(amount, 16)]);
    const block = (entries: string[], count = entries.length) => hexlify(concat([head, ...entries, toBeHex(count, 1), WORKER_TAIL_MAGIC]));
    expect(decodeWorkerTail(block([entry(B, 1n), entry(A, 1n)]))).toBeNull(); // unsorted
    expect(decodeWorkerTail(block([entry(A, 1n), entry(A, 2n)]))).toBeNull(); // duplicate
    expect(decodeWorkerTail(block([entry('0x' + '00'.repeat(20), 1n)]))).toBeNull(); // zero address
    expect(decodeWorkerTail(block([], 0))).toBeNull(); // empty
    expect(decodeWorkerTail(block([entry(A, 1n)], 9))).toBeNull(); // count over cap
    // Too short to hold an ABI head plus the block.
    expect(decodeWorkerTail(hexlify(concat([entry(A, 1n), toBeHex(1, 1), WORKER_TAIL_MAGIC])))).toBeNull();
    const bytes = getBytes(block([entry(A, 1n)]));
    bytes[bytes.length - 1] ^= 1;
    expect(decodeWorkerTail(bytes)).toBeNull(); // bad magic
  });

  it('refuses to encode lists the contract would ignore', () => {
    expect(() => encodeWorkerTail([])).toThrow();
    expect(() => encodeWorkerTail([{ worker: A, cumulativeAmount: 1n }, { worker: A.toUpperCase().replace('0X', '0x'), cumulativeAmount: 1n }])).toThrow();
  });

  it('accumulates per worker and never evicts an existing entry past the cap', () => {
    let workers = withWorkerAttribution(undefined, A, 100n);
    workers = withWorkerAttribution(workers, A, 50n);
    expect(workers).toEqual([{ worker: A, cumulativeAmount: 150n }]);
    for (let i = 0; i < MAX_WORKERS_PER_CHANNEL + 2; i++) workers = withWorkerAttribution(workers, Wallet.createRandom().address, 1n);
    expect(workers).toHaveLength(MAX_WORKERS_PER_CHANNEL);
    expect(workers.find((w) => w.worker === A)?.cumulativeAmount).toBe(150n);
  });
});
