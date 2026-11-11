import type { GatewayKeyInfo } from '../../shared/gateway-types.js';

export type { GatewayKeyInfo };

/** The gateway's `{ data: … }` answer from `GET /v1/key`. */
export function parseGatewayKeyInfo(payload: unknown): GatewayKeyInfo | null {
  const body = (payload as { data?: Record<string, unknown> } | null)?.data;
  if (!body || typeof body !== 'object') return null;
  const str = (value: unknown) => (typeof value === 'string' ? value : null);
  const usage = (body['usage'] ?? {}) as Record<string, unknown>;
  const limits: GatewayKeyInfo['limits'] = {};
  for (const [period, raw] of Object.entries((body['limits'] ?? {}) as Record<string, Record<string, unknown>>)) {
    limits[period] = { limitUsd: str(raw?.['limit_usd']), spentUsd: str(raw?.['spent_usd']) };
  }
  return {
    label: str(body['label']),
    buyerAddress: str(body['buyer_address']),
    requests: Number(usage['requests']) || 0,
    spentUsd: str(usage['spent_usd']),
    limits,
    balance: parseBalance(body['balance']),
  };
}

function parseBalance(raw: unknown): GatewayKeyInfo['balance'] {
  if (!raw || typeof raw !== 'object') return null;
  const balance = raw as Record<string, unknown>;
  const available = balance['available_usd'];
  const reserved = balance['reserved_usd'];
  if (typeof available !== 'string' || typeof reserved !== 'string') return null;
  return { availableUsd: available, reservedUsd: reserved, stale: balance['stale'] === true };
}

/**
 * The desktop key's info with requests and spend summed over every key that
 * shares its wallet (apps with a key of their own), so Home's usage counts
 * the apps too. Limits stay the desktop key's own.
 */
export function withUsageOf(desktop: GatewayKeyInfo, others: GatewayKeyInfo[]): GatewayKeyInfo {
  const micros = (value: string | null) => Math.round((Number(value) || 0) * 1_000_000);
  const spent = [desktop, ...others].reduce((sum, info) => sum + micros(info.spentUsd), 0);
  return {
    ...desktop,
    requests: [desktop, ...others].reduce((sum, info) => sum + info.requests, 0),
    spentUsd: desktop.spentUsd === null && others.every((info) => info.spentUsd === null) ? null : (spent / 1_000_000).toFixed(6).replace(/\.?0+$/, ''),
  };
}
