import { safeNumber, safeString } from './safe';

export type WalletActionResultPayload = {
  ok: boolean;
  message?: string;
  error?: string;
};

export type WalletActionResult = {
  message: string;
  type: 'success' | 'error';
};

export function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString();
}

export function formatTimestamp(timestamp: unknown): string {
  const ts = safeNumber(timestamp, 0);
  if (ts <= 0) {
    return 'n/a';
  }
  return new Date(ts).toLocaleString();
}

export function formatRelativeTime(timestamp: unknown): string {
  const ts = safeNumber(timestamp, 0);
  if (ts <= 0) {
    return 'n/a';
  }

  const diffMs = Date.now() - ts;
  if (diffMs < 0) {
    return 'now';
  }

  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) {
    return `${seconds}s ago`;
  }

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    return `${minutes}m ago`;
  }

  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }

  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

export function formatDuration(durationMs: unknown): string {
  const ms = safeNumber(durationMs, 0);
  if (ms <= 0) {
    return '0s';
  }

  const totalSeconds = Math.floor(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return `${minutes}m ${seconds}s`;
  }

  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return `${hours}h ${remMinutes}m`;
}

export function formatInt(value: unknown): string {
  return Math.round(safeNumber(value, 0)).toLocaleString();
}

export function formatPercent(value: unknown): string {
  const pct = safeNumber(value, 0);
  return `${Math.max(0, Math.min(100, Math.round(pct)))}%`;
}

export function getCapacityColor(percent: number): string {
  if (percent > 80) {
    return 'var(--accent)';
  }
  if (percent > 50) {
    return 'var(--accent-yellow)';
  }
  return 'var(--accent-green)';
}

export function getWalletActionResult(
  result: WalletActionResultPayload,
  successMessage: string,
  errorMessage: string,
): WalletActionResult {
  if (result.ok) {
    return {
      message: result.message || successMessage,
      type: 'success',
    };
  }

  return {
    message: result.error || errorMessage,
    type: 'error',
  };
}

export function formatMoney(value: unknown): string {
  if (typeof value === 'string') {
    const normalized = value.trim();
    if (normalized.length === 0) {
      return '$0.00';
    }
    const numeric = Number(normalized);
    if (!Number.isNaN(numeric)) {
      return `$${numeric.toFixed(2)}`;
    }
    return `$${normalized}`;
  }

  const numeric = safeNumber(value, 0);
  return `$${numeric.toFixed(2)}`;
}

export function formatPrice(value: unknown): string {
  const numeric = safeNumber(value, 0);
  if (numeric <= 0) {
    return 'n/a';
  }
  if (numeric < 0.01) {
    return `$${numeric.toFixed(4)}`;
  }
  return `$${numeric.toFixed(2)}`;
}

export function formatLatency(value: unknown): string {
  const numeric = safeNumber(value, 0);
  if (numeric <= 0) {
    return 'n/a';
  }
  return `${Math.round(numeric)}ms`;
}

/** Bare dollar amount for the brand price displays ("$5", "$2.50") — the
 * "/m tok" unit is rendered separately, unlike formatPerMillionPrice. */
export function formatUsdShort(value: number): string {
  if (value <= 0) return 'Free';
  const digits = value < 0.01 ? 3 : Number.isInteger(value) ? 0 : 2;
  return `$${value.toFixed(digits)}`;
}

export function formatUsd(value: unknown, fractionDigits = 2): string {
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) return (0).toFixed(fractionDigits);
  return num.toLocaleString([], { minimumFractionDigits: fractionDigits, maximumFractionDigits: fractionDigits });
}

/* USDC amount as plain 2dp, with tiny non-zero balances surfaced as "<0.01"
   instead of a misleading "0.00". */
export function formatUsdcAmount(value: unknown): string {
  const numeric = safeNumber(value, 0);
  if (numeric > 0 && numeric < 0.01) return '<0.01';
  return numeric.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* Credits balance for the shell pill: always 2dp (e.g. "0.00");
   tiny non-zero balances as "<0.01". */
export function formatCredits(value: string): string {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value || '0.00';
  if (numeric > 0 && numeric < 0.01) return '<0.01';
  return numeric.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/* Compact token totals for the brand stat tiles ("656.9M"). Accepts
   bigint-strings since lifetime token counts can exceed 2^53. */
export function formatCompactTokens(input: string | undefined, output: string | undefined): string {
  let total: bigint;
  try {
    total = BigInt(input ?? '0') + BigInt(output ?? '0');
  } catch {
    return '-';
  }
  if (total < 1000n) return total.toString();
  const units: Array<[bigint, string]> = [
    [1_000_000_000_000n, 'T'],
    [1_000_000_000n, 'B'],
    [1_000_000n, 'M'],
    [1_000n, 'K'],
  ];
  for (const [divisor, suffix] of units) {
    if (total >= divisor) {
      const scaled = Number((total * 10n) / divisor) / 10;
      return `${scaled.toFixed(1)}${suffix}`;
    }
  }
  return total.toString();
}

/* Compact price tag: "Free" for zero, trailing zeros trimmed
   (0.50 -> $0.5, 1.00 -> $1), sub-cent prices at 3dp. */
export function formatCompactUsd(value: number): string {
  if (value <= 0) return 'Free';
  const fixed = value < 0.01 ? value.toFixed(3) : value.toFixed(2);
  const trimmed = fixed.replace(/\.?0+$/, '');
  return `$${trimmed}`;
}

export function shortAddress(value: string | null): string {
  if (!value) return 'Not configured';
  return value.length > 14 ? `${value.slice(0, 6)}...${value.slice(-4)}` : value;
}

export function formatShortId(id: unknown, head = 8, tail = 6): string {
  if (typeof id !== 'string' || id.length === 0) {
    return 'unknown';
  }
  if (id.length <= head + tail + 3) {
    return id;
  }
  return `${id.slice(0, head)}...${id.slice(-tail)}`;
}

export function formatEndpoint(peer: { host?: unknown; port?: unknown }): string {
  const host = safeString(peer.host, '').trim();
  const port = safeNumber(peer.port, 0);
  if (host.length > 0 && port > 0) {
    return `${host}:${port}`;
  }
  return '-';
}
