import { parseEther } from 'ethers'

/**
 * An ETH amount from config as wei. `String(1e-7)` is "1e-7", which parseEther
 * refuses, so the number is written out in plain decimals (wei precision) first.
 */
export function ethToWei(eth: number): bigint {
  return parseEther(eth.toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 18 }))
}
