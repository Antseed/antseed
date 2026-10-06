/** Number, address, epoch and explorer formatting. All on-chain amounts arrive as decimal strings in base units. */

export function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function toBigInt(value: string | number | bigint | null | undefined): bigint | null {
  if (value === null || value === undefined || value === '') return null;
  try {
    return BigInt(value);
  } catch {
    return null;
  }
}

/** Format a base-unit amount with `decimals` decimals, truncated to `digits` fraction digits, zeros trimmed. */
export function formatUnits(value: string | bigint | null | undefined, decimals: number, digits = 2): string {
  const parsed = typeof value === 'bigint' ? value : toBigInt(value);
  if (parsed === null) return '—';
  const negative = parsed < 0n;
  const abs = negative ? -parsed : parsed;
  const base = 10n ** BigInt(decimals);
  const whole = abs / base;
  const fraction = abs % base;
  let fractionText = '';
  if (digits > 0 && decimals > 0) {
    fractionText = fraction.toString().padStart(decimals, '0').slice(0, digits).replace(/0+$/, '');
  }
  if (abs > 0n && whole === 0n && fractionText === '') {
    const floor = digits === 0 ? '1' : `0.${'0'.repeat(digits - 1)}1`;
    return `${negative ? '-' : ''}<${floor}`;
  }
  return `${negative ? '-' : ''}${groupThousands(whole.toString())}${fractionText ? `.${fractionText}` : ''}`;
}

export function formatAnts(value: string | bigint | null | undefined, digits = 2): string {
  return formatUnits(value, 18, digits);
}

export function formatUsdc(value: string | bigint | null | undefined, digits = 2): string {
  return formatUnits(value, 6, digits);
}

export function formatEth(value: string | bigint | null | undefined, digits = 4): string {
  return formatUnits(value, 18, digits);
}

/** Raw integer (points, counts) with thousands separators. */
export function formatInt(value: string | number | bigint | null | undefined): string {
  if (typeof value === 'number') return Number.isFinite(value) ? groupThousands(Math.trunc(value).toString()) : '—';
  const parsed = typeof value === 'bigint' ? value : toBigInt(value);
  if (parsed === null) return '—';
  const negative = parsed < 0n;
  return `${negative ? '-' : ''}${groupThousands((negative ? -parsed : parsed).toString())}`;
}

export function formatBps(bps: number | null | undefined): string {
  if (bps === null || bps === undefined || !Number.isFinite(bps)) return '—';
  return `${(bps / 100).toFixed(2)}%`;
}

export function isZero(value: string | null | undefined): boolean {
  const parsed = toBigInt(value);
  return parsed === null || parsed === 0n;
}

export function cmpBig(a: string, b: string): number {
  const x = toBigInt(a) ?? 0n;
  const y = toBigInt(b) ?? 0n;
  return x < y ? -1 : x > y ? 1 : 0;
}

export function sumBig(values: Array<string | null | undefined>): string {
  return values.reduce<bigint>((sum, v) => sum + (toBigInt(v) ?? 0n), 0n).toString();
}

export function shortAddress(address: string): string {
  if (address.length <= 13) return address;
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function shortHash(hash: string): string {
  if (hash.length <= 18) return hash;
  return `${hash.slice(0, 10)}…${hash.slice(-6)}`;
}

export function isAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/.test(value);
}

export function formatUtc(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds)) return '—';
  return `${new Date(unixSeconds * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

export function formatUtcDate(unixSeconds: number): string {
  if (!Number.isFinite(unixSeconds)) return '—';
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

export function formatLocalTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour12: false });
}

export function epochStartAt(epoch: number, genesis: number, epochDuration: number): number {
  return genesis + epoch * epochDuration;
}

export function formatDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const days = Math.floor(s / 86400);
  const hours = Math.floor((s % 86400) / 3600);
  const minutes = Math.floor((s % 3600) / 60);
  const seconds = s % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${days}d ${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

export function formatEpochLength(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400} days`;
  if (seconds % 3600 === 0) return `${seconds / 3600} hours`;
  return `${formatInt(seconds)} s`;
}

export function explorerBase(evmChainId: number): string | null {
  if (evmChainId === 8453) return 'https://basescan.org';
  if (evmChainId === 84532) return 'https://sepolia.basescan.org';
  return null;
}

/** Display name of the block explorer for link labels ("View on Basescan"); null when there is none. */
export function explorerName(evmChainId: number): string | null {
  return explorerBase(evmChainId) ? 'Basescan' : null;
}

/** "just now" / "42s ago" / "2m ago" / "3h ago" / "5d ago". */
export function formatRelativeTime(ms: number, now = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - ms) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

export function explorerTxUrl(evmChainId: number, hash: string): string | null {
  const base = explorerBase(evmChainId);
  return base ? `${base}/tx/${hash}` : null;
}

export function explorerAddressUrl(evmChainId: number, address: string): string | null {
  const base = explorerBase(evmChainId);
  return base ? `${base}/address/${address}` : null;
}

export function isPositiveDecimal(value: string): boolean {
  if (!/^\d+(\.\d+)?$/.test(value.trim())) return false;
  return /[1-9]/.test(value);
}

export function isPositiveInt(value: string): boolean {
  return /^\d+$/.test(value.trim()) && Number(value) > 0;
}

/** Human decimal string → base units (for client-side comparisons only; the server parses the human string itself). */
export function parseUnits(value: string, decimals: number): bigint | null {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(value.trim());
  if (!match) return null;
  const whole = match[1] ?? '0';
  const fraction = (match[2] ?? '').slice(0, decimals).padEnd(decimals, '0');
  try {
    return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction || '0');
  } catch {
    return null;
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

/** Emission shares (gate minters, dynamic staker/usage bounds) are fractions of `denominator`, not bps of 10,000. */
export function formatShare(value: number | null | undefined, denominator: number): string {
  if (value === null || value === undefined || !Number.isFinite(value) || !denominator) return '—';
  return `${((value * 100) / denominator).toFixed(2)}%`;
}

/** USDC (6 decimals) as a compact dollar figure: "$0", "$12.34", "$12.3k", "$1.2M". */
export function formatUsdcCompact(value: string | bigint | null | undefined): string {
  const parsed = typeof value === 'bigint' ? value : toBigInt(value);
  if (parsed === null) return '—';
  const negative = parsed < 0n;
  const cents = (negative ? -parsed : parsed) / 10_000n; // hundredths of a dollar
  const dollars = Number(cents) / 100;
  const sign = negative ? '-' : '';
  if (dollars >= 1_000_000) return `${sign}$${(dollars / 1_000_000).toFixed(dollars >= 10_000_000 ? 0 : 1)}M`;
  if (dollars >= 1_000) return `${sign}$${(dollars / 1_000).toFixed(dollars >= 10_000 ? 0 : 1)}k`;
  if (dollars >= 100) return `${sign}$${dollars.toFixed(0)}`;
  return `${sign}$${dollars.toFixed(2)}`;
}
