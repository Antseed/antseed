/**
 * Wallet constants and pure helpers shared by the Antseed browser apps
 * (gateway console, payments pages, ANTS dashboard, desktop renderer).
 * No runtime dependencies; contract ABIs (which need viem) live in
 * `@antseed/wallet-config/abis`.
 */

/** Public WalletConnect Cloud project shared by the Antseed web apps. */
export const ANTSEED_WALLETCONNECT_PROJECT_ID = '9a1851410cb5589bc351a6dabf17140e'

/**
 * Public Base mainnet RPCs in fallback order: the same list as the
 * @antseed/node base-mainnet chain config (`payments/chain-config.ts`), so the
 * browser apps and the buyer read the chain through the same endpoints. The
 * benchmark and the reasons publicnode and llamarpc are left out are there.
 */
export const BASE_PUBLIC_RPC_URLS: readonly string[] = [
  'https://base.gateway.tenderly.co',
  'https://base.drpc.org',
  'https://base-public.nodies.app',
  'https://mainnet.base.org',
]

const USDC_DECIMALS = 6

/**
 * A dollar amount as USDC base units (6 decimals), computed on the digits (no
 * float error). Extra decimals round half up to the nearest base unit, as the
 * desktop's QR code always did; null when it is not a positive number.
 */
export function usdcAmountToBaseUnits(amount: string): bigint | null {
  const match = /^(\d*)(?:\.(\d*))?$/.exec(amount.trim())
  if (!match || (!match[1] && !match[2])) return null
  const decimals = match[2] ?? ''
  const fraction = BigInt(decimals.slice(0, USDC_DECIMALS).padEnd(USDC_DECIMALS, '0'))
  const roundUp = decimals.length > USDC_DECIMALS && decimals[USDC_DECIMALS]! >= '5' ? 1n : 0n
  const units = BigInt(match[1] || '0') * 10n ** BigInt(USDC_DECIMALS) + fraction + roundUp
  return units > 0n ? units : null
}

export interface UsdcPaymentTarget {
  usdcAddress: string
  chainId: number
  /** The wallet receiving the USDC. */
  address: string
}

/**
 * EIP-681 payment request: opens a prefilled USDC transfer in mobile wallets.
 * The amount is left out when it does not parse.
 */
export function buildUsdcPaymentUri(target: UsdcPaymentTarget, amount: string): string {
  const baseUnits = usdcAmountToBaseUnits(amount)
  const base = `ethereum:${target.usdcAddress}@${target.chainId}/transfer?address=${target.address}`
  return baseUnits ? `${base}&uint256=${baseUnits.toString()}` : base
}

/**
 * RainbowKit `darkTheme()` options in the Antseed signal green, shared so the
 * connect modal looks the same in every app (plain object: no RainbowKit
 * dependency here).
 */
export const ANTSEED_RAINBOWKIT_DARK = {
  accentColor: '#1fd87a',
  accentColorForeground: '#06281a',
  borderRadius: 'small',
  fontStack: 'system',
} as const

/**
 * RainbowKit theme options for the neutral (monochrome) dashboards: the
 * accent follows the page's own `--as-accent` / `--as-accent-contrast`
 * tokens from @antseed/ui, so the connect modal matches their primary
 * buttons in light and dark mode. Pass to `lightTheme()` or `darkTheme()`.
 */
export const ANTSEED_RAINBOWKIT_NEUTRAL = {
  accentColor: 'var(--as-accent, #0a0a0a)',
  accentColorForeground: 'var(--as-accent-contrast, #ffffff)',
  borderRadius: 'small',
  fontStack: 'system',
} as const
