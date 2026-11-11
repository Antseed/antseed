import type { GatewayKeyInfo, GatewayRewardsSummary, GatewaySavings } from '../../shared/gateway-types.js';

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
  const str = (value: unknown) => (typeof value === 'string' ? value : null);
  const available = str(balance['available_usd']);
  const reserved = str(balance['reserved_usd']);
  if (available === null || reserved === null) return null;
  return {
    availableUsd: available,
    reservedUsd: reserved,
    pendingUsd: str(balance['pending_usd']) ?? '0',
    walletUsd: str(balance['wallet_usd']),
    creditLimitUsd: str(balance['credit_limit_usd']),
    operator: str(balance['operator']),
    stale: balance['stale'] === true,
  };
}

/** `GET /v1/key/rewards`; null when the gateway couldn't read them. */
export function parseKeyRewards(payload: unknown): GatewayRewardsSummary | null {
  const body = (payload as { data?: Record<string, unknown> | null } | null)?.data;
  if (!body || typeof body !== 'object' || typeof body['address'] !== 'string') return null;
  return {
    available: body['available'] === true,
    address: body['address'],
    pendingAnts: typeof body['pending_ants'] === 'string' ? body['pending_ants'] : '0',
    currentEpoch: typeof body['current_epoch'] === 'number' ? body['current_epoch'] : null,
    transfersEnabled: body['transfers_enabled'] === true,
  };
}

/** `GET /v1/key/savings`; null when the gateway has none (no retail prices, or nothing matched). */
export function parseKeySavings(payload: unknown): GatewaySavings | null {
  const body = (payload as { data?: Record<string, unknown> | null } | null)?.data;
  if (!body || typeof body !== 'object') return null;
  const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null);
  const retailUsd = num(body['retail_usd']);
  const paidUsd = num(body['paid_usd']);
  if (retailUsd === null || paidUsd === null) return null;
  return { retailUsd, paidUsd, savedUsd: Math.max(0, retailUsd - paidUsd), matchedRequests: num(body['matched_requests']) ?? 0 };
}

/** What `withUsageOf` adds up from each other key: its requests and spend. */
export type KeyUsage = Pick<GatewayKeyInfo, 'requests' | 'spentUsd'>;

/**
 * `antseed gateway key usage --json` over keys the desktop retired: their
 * requests and spend, and their savings. Null when the answer isn't one.
 */
export function parseRetiredUsage(payload: unknown): { usage: KeyUsage; savings: GatewaySavings | null } | null {
  const body = (payload as { data?: Record<string, unknown> | null } | null)?.data;
  if (!body || typeof body !== 'object') return null;
  const requests = typeof body['requests'] === 'number' && Number.isFinite(body['requests']) ? body['requests'] : 0;
  const spentUsd = typeof body['spent_usd'] === 'string' ? body['spent_usd'] : null;
  return {
    usage: { requests, spentUsd },
    savings: parseKeySavings({ data: body['savings'] }),
  };
}

/** Savings over several keys (every key the desktop made), or null when none had any. */
export function sumSavings(list: ReadonlyArray<GatewaySavings | null>): GatewaySavings | null {
  const present = list.filter((entry): entry is GatewaySavings => entry !== null);
  if (present.length === 0) return null;
  const retailUsd = present.reduce((sum, entry) => sum + entry.retailUsd, 0);
  const paidUsd = present.reduce((sum, entry) => sum + entry.paidUsd, 0);
  return { retailUsd, paidUsd, savedUsd: Math.max(0, retailUsd - paidUsd), matchedRequests: present.reduce((sum, entry) => sum + entry.matchedRequests, 0) };
}

/**
 * The desktop key's info with requests and spend summed over every key that
 * shares its wallet (apps with a key of their own), so Home's usage counts
 * the apps too. Limits stay the desktop key's own.
 */
export function withUsageOf(desktop: GatewayKeyInfo, others: readonly KeyUsage[]): GatewayKeyInfo {
  const micros = (value: string | null) => Math.round((Number(value) || 0) * 1_000_000);
  const spent = [desktop, ...others].reduce((sum, info) => sum + micros(info.spentUsd), 0);
  return {
    ...desktop,
    requests: [desktop, ...others].reduce((sum, info) => sum + info.requests, 0),
    spentUsd: desktop.spentUsd === null && others.every((info) => info.spentUsd === null) ? null : (spent / 1_000_000).toFixed(6).replace(/\.?0+$/, ''),
  };
}
