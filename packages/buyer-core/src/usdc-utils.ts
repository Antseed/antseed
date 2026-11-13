/**
 * Shared USDC formatting and parsing utilities.
 * USDC uses 6 decimal places (1 USDC = 1,000,000 base units).
 */

/** Format USDC base units (bigint) to human-readable string (e.g., "10.5"). */
export function formatUsdc(baseUnits: bigint): string {
  const whole = baseUnits / 1_000_000n;
  const frac = (baseUnits % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '') || '0';
  return `${whole}.${frac}`;
}

/** Parse a decimal USDC string to base units (6 decimals) without floating-point. */
export function parseUsdc(s: string): bigint {
  const [whole = '0', frac = ''] = s.split('.');
  const fracPadded = frac.slice(0, 6).padEnd(6, '0');
  return BigInt(whole) * 1_000_000n + BigInt(fracPadded);
}
