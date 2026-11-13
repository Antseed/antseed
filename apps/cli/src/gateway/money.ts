/** USDC has 6 decimals; every gateway amount is an integer in base units. */
const USDC_DECIMALS = 6
const USDC_SCALE = 10 ** USDC_DECIMALS

/** Parse a user-entered dollar amount ("5", "0.25", "$12.50") into USDC base units. */
export function parseUsdToUsdc(value: string): number {
  const raw = value.trim().replace(/^\$/, '')
  const match = /^(\d+)(?:\.(\d{1,6}))?$/.exec(raw)
  if (!match) throw new Error(`Invalid USD amount "${value}". Use a number like 5 or 12.50.`)
  const whole = Number(match[1])
  const fraction = Number((match[2] ?? '').padEnd(USDC_DECIMALS, '0'))
  const amount = whole * USDC_SCALE + fraction
  if (!Number.isSafeInteger(amount)) throw new Error(`USD amount "${value}" is too large.`)
  return amount
}

/** Exact decimal string for API responses, e.g. 1500000 -> "1.500000". */
export function usdcToDecimalString(amount: number): string {
  const sign = amount < 0 ? '-' : ''
  const abs = Math.abs(amount)
  return `${sign}${Math.floor(abs / USDC_SCALE)}.${String(abs % USDC_SCALE).padStart(USDC_DECIMALS, '0')}`
}

export function optionalUsdcToDecimalString(amount: number | null): string | null {
  return amount === null ? null : usdcToDecimalString(amount)
}

/** Human display: whole cents normally, more precision for sub-cent amounts. */
export function formatUsdc(amount: number): string {
  const usd = amount / USDC_SCALE
  if (amount !== 0 && Math.abs(usd) < 0.01) return `$${usd.toFixed(4)}`
  return `$${usd.toFixed(2)}`
}

export function parseBaseUnits(value: string): number {
  const amount = Number(value)
  return Number.isSafeInteger(amount) && amount >= 0 ? amount : 0
}
