const MICROS = 1_000_000n;

/** A decimal USD amount ("12.5") in USDC base units (6 decimals); 0 for anything else. */
export function usdcToMicros(value: string | null): bigint {
  const match = value === null ? null : /^(\d+)(?:\.(\d{1,6})\d*)?$/.exec(value.trim());
  if (!match) return 0n;
  return BigInt(match[1]!) * MICROS + BigInt((match[2] ?? '').padEnd(6, '0'));
}

/** USDC base units as a decimal USD amount without trailing zeros: 1500000n → "1.5". */
export function usdcFromMicros(value: bigint): string {
  const whole = value / MICROS;
  const fraction = (value % MICROS).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
