/**
 * Block-range paging for `eth_getLogs`-style queries. Public RPCs on Base cap
 * the range a single log query may span, so a scan from a contract's
 * deployment block to head is split into fixed-size, inclusive windows.
 */

export const DEFAULT_LOG_QUERY_CHUNK_BLOCKS = 10_000;

export interface BlockRangeOptions {
  /** Maximum number of blocks covered by one query (inclusive window). */
  chunkBlocks?: number;
  /**
   * Pass `'latest'` as the upper bound of the final window instead of
   * `toBlock`. Use when `toBlock` is a head snapshot: provider block-number
   * reads can be cached and lag a just-mined block, while the `'latest'` tag
   * is resolved by the node at query time.
   */
  openEnded?: boolean;
}

/**
 * Resolve the lower bound of an event scan: an explicit `fromBlock` wins,
 * otherwise the contract's known deployment block. Scanning from genesis is
 * never implied — callers without either must pass a block explicitly.
 */
export function resolveScanFromBlock(
  fromBlock: number | undefined,
  deploymentBlock: number | undefined,
  label = 'contract',
): number {
  const resolved = fromBlock ?? deploymentBlock;
  if (resolved === undefined) {
    throw new Error(`${label} deployment block is unknown; pass an explicit fromBlock to query events`);
  }
  assertBlockNumber(resolved, 'fromBlock');
  return resolved;
}

/**
 * Run `query` over `[fromBlock, toBlock]` in sequential windows of at most
 * `chunkBlocks` blocks and concatenate the results in block order.
 */
export async function queryInBlockChunks<T>(
  fromBlock: number,
  toBlock: number,
  query: (fromBlock: number, toBlock: number | 'latest') => Promise<readonly T[]>,
  options: BlockRangeOptions = {},
): Promise<T[]> {
  const chunkBlocks = options.chunkBlocks ?? DEFAULT_LOG_QUERY_CHUNK_BLOCKS;
  assertBlockNumber(fromBlock, 'fromBlock');
  assertBlockNumber(toBlock, 'toBlock');
  if (!Number.isSafeInteger(chunkBlocks) || chunkBlocks < 1) {
    throw new Error(`chunkBlocks must be a positive integer, got ${chunkBlocks}`);
  }
  const results: T[] = [];
  if (fromBlock > toBlock) {
    // A head snapshot below the floor may simply be stale; let the node decide.
    return options.openEnded ? [...await query(fromBlock, 'latest')] : results;
  }
  for (let start = fromBlock; start <= toBlock; start += chunkBlocks) {
    const end = Math.min(start + chunkBlocks - 1, toBlock);
    const isLast = end === toBlock;
    results.push(...await query(start, isLast && options.openEnded ? 'latest' : end));
  }
  return results;
}

function assertBlockNumber(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer block number, got ${value}`);
  }
}
