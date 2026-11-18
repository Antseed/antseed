/** The one read the chain clock needs: `ethers.Provider.getBlock('latest')`. */
export interface LatestBlockReader {
  getBlock(tag: 'latest'): Promise<{ timestamp: number } | null>
}

/**
 * Unix seconds now, as the chain sees it: the latest block's timestamp. On Base a block lands every
 * two seconds, so it is the wall clock give or take seconds, but it is the same for every auditor,
 * and on a local fork it follows the fork's time (`evm_increaseTime`, `--timestamp`), so everything
 * that depends on how far the epoch has come (the confirmation fallback, the auditor handover, the
 * time left) can be tested by moving the fork. Falls back to the wall clock when the block cannot
 * be read.
 */
export async function chainNow(provider: LatestBlockReader, wallClockMs: number = Date.now()): Promise<number> {
  try {
    const block = await provider.getBlock('latest')
    if (block) return Number(block.timestamp)
  } catch {
    // Fall through to the wall clock.
  }
  return Math.floor(wallClockMs / 1_000)
}
