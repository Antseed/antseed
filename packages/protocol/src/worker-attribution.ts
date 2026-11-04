import { concat, getAddress, getBytes, hexlify, id, toBeHex, zeroPadValue } from 'ethers';

/**
 * Worker attribution block appended to SpendingAuth metadata.
 *
 * A buyer of a worker pool appends, after the ABI-encoded metadata, how much
 * of the channel's cumulative amount it paid for requests each worker served:
 *
 *   entries ‖ uint8 count ‖ bytes32 WORKER_TAIL_MAGIC
 *   entry = address worker (20 bytes) ‖ uint128 cumulativeAmount (16 bytes)
 *
 * ABI decoders read the metadata head by offset and ignore trailing bytes, so
 * existing readers are unaffected. AntseedWorkerPool reads the block from the
 * end of the buyer-signed metadata to split payouts. See
 * docs/protocol/worker-pool.md.
 */

export interface WorkerAttribution {
  /** Worker address (checksummed or lowercase). */
  worker: string;
  /** USDC base units paid on this channel for requests the worker served. */
  cumulativeAmount: bigint;
}

export const WORKER_TAIL_MAGIC = id('antseed:worker-attribution:v1');
export const MAX_WORKERS_PER_CHANNEL = 8;

const ENTRY_BYTES = 36;
const TRAILER_BYTES = 33;
/** The v4 ABI head is eight words; anything shorter cannot carry a block. */
const MIN_HEAD_BYTES = 256;
const UINT128_MAX = (1n << 128n) - 1n;

function sortedEntries(workers: readonly WorkerAttribution[]): WorkerAttribution[] {
  return [...workers]
    .map((entry) => ({ worker: getAddress(entry.worker), cumulativeAmount: entry.cumulativeAmount }))
    .sort((a, b) => (a.worker.toLowerCase() < b.worker.toLowerCase() ? -1 : 1));
}

/** Encode the block for `workers`. Throws on input the contract would ignore. */
export function encodeWorkerTail(workers: readonly WorkerAttribution[]): string {
  if (workers.length === 0 || workers.length > MAX_WORKERS_PER_CHANNEL) {
    throw new Error(`Worker attribution needs 1–${MAX_WORKERS_PER_CHANNEL} entries`);
  }
  const entries = sortedEntries(workers);
  const parts: string[] = [];
  let previous = '';
  for (const entry of entries) {
    const lower = entry.worker.toLowerCase();
    if (lower === '0x0000000000000000000000000000000000000000') throw new Error('Worker attribution has a zero address');
    if (lower === previous) throw new Error(`Worker ${entry.worker} is listed twice`);
    if (entry.cumulativeAmount < 0n || entry.cumulativeAmount > UINT128_MAX) throw new Error('Worker amount out of range');
    previous = lower;
    parts.push(entry.worker, zeroPadValue(toBeHex(entry.cumulativeAmount), 16));
  }
  parts.push(toBeHex(entries.length, 1), WORKER_TAIL_MAGIC);
  return hexlify(concat(parts));
}

/** Append the block to ABI-encoded metadata (unchanged when there are no workers). */
export function appendWorkerTail(encodedMetadata: string, workers: readonly WorkerAttribution[] | undefined): string {
  if (!workers || workers.length === 0) return encodedMetadata;
  return hexlify(concat([encodedMetadata, encodeWorkerTail(workers)]));
}

/**
 * Read the block from the end of metadata bytes, applying the same rules as
 * AntseedWorkerPool: anything malformed yields null (no attribution).
 */
export function decodeWorkerTail(metadata: string | Uint8Array): WorkerAttribution[] | null {
  const bytes = typeof metadata === 'string' ? getBytes(metadata) : metadata;
  if (bytes.length < MIN_HEAD_BYTES + TRAILER_BYTES) return null;
  if (hexlify(bytes.slice(bytes.length - 32)) !== WORKER_TAIL_MAGIC) return null;
  const count = bytes[bytes.length - TRAILER_BYTES]!;
  if (count === 0 || count > MAX_WORKERS_PER_CHANNEL) return null;
  if (bytes.length < MIN_HEAD_BYTES + TRAILER_BYTES + count * ENTRY_BYTES) return null;
  const start = bytes.length - TRAILER_BYTES - count * ENTRY_BYTES;
  const entries: WorkerAttribution[] = [];
  let previous = 0n;
  for (let i = 0; i < count; i++) {
    const offset = start + i * ENTRY_BYTES;
    const workerHex = hexlify(bytes.slice(offset, offset + 20));
    const workerNum = BigInt(workerHex);
    if (workerNum === 0n || workerNum <= previous) return null;
    previous = workerNum;
    entries.push({
      worker: getAddress(workerHex),
      cumulativeAmount: BigInt(hexlify(bytes.slice(offset + 20, offset + ENTRY_BYTES))),
    });
  }
  return entries;
}

/**
 * Add `amount` to `worker`'s cumulative total. Past the per-channel cap, a new
 * worker is left unattributed (its share goes to the pool's remainder) rather
 * than dropping an existing entry, whose total must only grow.
 */
export function withWorkerAttribution(
  workers: readonly WorkerAttribution[] | undefined,
  worker: string,
  amount: bigint,
): WorkerAttribution[] {
  const list = (workers ?? []).map((entry) => ({ ...entry }));
  if (amount <= 0n) return list;
  const lower = worker.toLowerCase();
  const existing = list.find((entry) => entry.worker.toLowerCase() === lower);
  if (existing) existing.cumulativeAmount += amount;
  else if (list.length < MAX_WORKERS_PER_CHANNEL) list.push({ worker: getAddress(worker), cumulativeAmount: amount });
  return sortedEntries(list);
}
