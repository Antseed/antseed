const ANTS_DECIMALS = 18n;
const ONE_ANTS = 10n ** ANTS_DECIMALS;

/** Format 18-decimal base units with up to `fractionDigits` fraction digits (trailing zeros trimmed). */
export function formatAnts(baseUnits: bigint | string | null, fractionDigits = 4): string {
  if (baseUnits === null) return 'unavailable';
  const value = typeof baseUnits === 'string' ? BigInt(baseUnits) : baseUnits;
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / ONE_ANTS;
  const fraction = (abs % ONE_ANTS).toString().padStart(18, '0').slice(0, fractionDigits).replace(/0+$/, '');
  const wholeText = whole.toLocaleString('en-US');
  return `${negative ? '-' : ''}${wholeText}${fraction ? `.${fraction}` : ''}`;
}

export function formatAntsExact(baseUnits: bigint | string): string {
  const value = typeof baseUnits === 'string' ? BigInt(baseUnits) : baseUnits;
  const whole = value / ONE_ANTS;
  const fraction = (value % ONE_ANTS).toString().padStart(18, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

/** Parse a human ANTS amount ("12.5") into base units; rejects zero, negatives, and more than 18 decimals. */
export function parseAnts(amount: string): bigint {
  const match = amount.trim().replace(/,/g, '').match(/^(\d+)(?:\.(\d{1,18}))?$/);
  if (!match) throw new Error('Amount must be a positive number with at most 18 decimals.');
  const baseUnits = BigInt(match[1]!) * ONE_ANTS + BigInt((match[2] ?? '').padEnd(18, '0') || '0');
  if (baseUnits <= 0n) throw new Error('Amount must be greater than zero.');
  return baseUnits;
}

export function formatUsdc(baseUnits: bigint | string): string {
  const value = typeof baseUnits === 'string' ? BigInt(baseUnits) : baseUnits;
  const whole = value / 1_000_000n;
  const fraction = (value % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}

export function formatBps(bps: number): string {
  return `${(bps / 100).toFixed(2).replace(/\.?0+$/, '')}%`;
}

export function shortAddress(address: string): string {
  return address.length > 12 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}
