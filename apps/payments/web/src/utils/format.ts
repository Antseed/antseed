import { formatUnits } from 'viem';

const DEFAULT_DATE_OPTIONS = { month: 'short', day: 'numeric' } as const;
const ANTS_DECIMALS = 18;

export function formatNumber(value: string | number): string {
  const num = typeof value === 'string' ? Number(value) : value;
  if (!Number.isFinite(num)) return '0';
  return num.toLocaleString('en-US');
}

export function formatCompact(value: string | number | bigint): string {
  const num =
    typeof value === 'bigint' ? Number(value)
    : typeof value === 'string' ? Number(value)
    : value;
  if (!Number.isFinite(num)) return '0';
  if (num >= 1_000_000_000) return `${(num / 1_000_000_000).toFixed(2)}B`;
  if (num >= 1_000_000) return `${(num / 1_000_000).toFixed(2)}M`;
  if (num >= 10_000) return `${(num / 1_000).toFixed(1)}K`;
  return num.toLocaleString('en-US');
}

export function bigintFromString(s: string | undefined): bigint {
  if (!s) return 0n;
  try { return BigInt(s); } catch { return 0n; }
}

export function parseUsd(value?: string | null): number {
  const parsed = Number.parseFloat(value ?? '0');
  return Number.isFinite(parsed) ? parsed : 0;
}

export function formatUsd(value: string | number | null | undefined): string {
  const num = typeof value === 'string' ? Number(value) : value ?? 0;
  return Number.isFinite(num)
    ? num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    : '0.00';
}

export function formatAmountInput(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '';
  return value.toFixed(6).replace(/\.?(0+)$/, '');
}

export function truncateAddress(address: string, leading = 6, trailing = 4, separator = '…'): string {
  return `${address.slice(0, leading)}${separator}${address.slice(-trailing)}`;
}

export function timestampToMs(timestamp: number): number {
  return timestamp > 1e12 ? timestamp : timestamp * 1000;
}

export function formatTimestampDate(
  timestamp: number,
  options: Intl.DateTimeFormatOptions = DEFAULT_DATE_OPTIONS,
): string {
  if (!timestamp) return '—';
  return new Date(timestampToMs(timestamp)).toLocaleDateString('en-US', options);
}

/** A colony pool's ANTS, as the Mac app shows them: two decimals, "<0.01" below that. */
export function formatColonyAnts(wei: bigint): string {
  const value = Number(formatUnits(wei, ANTS_DECIMALS));
  if (value === 0) return '0';
  if (value < 0.01) return '<0.01';
  return value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

export function formatAntsAmount(amountWei: string | bigint): string {
  const amount = typeof amountWei === 'bigint' ? amountWei : bigintFromString(amountWei);
  if (amount === 0n) return '0';
  const num = Number(formatUnits(amount, ANTS_DECIMALS));
  if (num > 0 && num < 0.0001) return '< 0.0001';
  return num.toLocaleString('en-US', { maximumFractionDigits: 4 });
}
