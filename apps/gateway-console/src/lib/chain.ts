import type { ChainInfo } from '../api/types'

/**
 * Names the console looks up in `ChainInfo.contracts`. The gateway should use
 * the first spelling; the others are accepted so a renamed key still works.
 */
const CONTRACT_ALIASES = {
  usdc: ['usdc', 'USDC', 'usdcToken'],
  deposits: ['deposits', 'AntseedDeposits', 'antseedDeposits'],
  usageRewards: ['usageRewards', 'AntseedUsageRewards', 'UsageRewards'],
} as const

export type ContractName = keyof typeof CONTRACT_ALIASES

export function contractAddress(chain: ChainInfo | null | undefined, name: ContractName): `0x${string}` | null {
  if (!chain) return null
  const entries = Object.entries(chain.contracts)
  for (const alias of CONTRACT_ALIASES[name]) {
    const hit = entries.find(([key]) => key.toLowerCase() === alias.toLowerCase())
    if (hit && /^0x[0-9a-fA-F]{40}$/.test(hit[1])) return hit[1] as `0x${string}`
  }
  return null
}

export function sameAddress(a: string | null | undefined, b: string | null | undefined): boolean {
  return !!a && !!b && a.toLowerCase() === b.toLowerCase()
}

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'

export function isSetAddress(value: string | null | undefined): value is string {
  return !!value && /^0x[0-9a-fA-F]{40}$/.test(value) && value.toLowerCase() !== ZERO_ADDRESS
}

export function explorerTxUrl(chain: ChainInfo | null | undefined, hash: string): string | null {
  if (!chain?.explorerUrl) return null
  return `${chain.explorerUrl.replace(/\/+$/, '')}/tx/${hash}`
}
