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
  };
}
