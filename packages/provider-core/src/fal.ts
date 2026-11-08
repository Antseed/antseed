import type { UpstreamAccountStatus } from '@antseed/node';
import { readVideoJson as readJson } from './video-download.js';

export const FAL_PLATFORM_URL = 'https://api.fal.ai';
export const FAL_SCHEMA_URL = 'https://fal.ai/api/openapi/queue/openapi.json';

/** An endpoint's input schema in fal's OpenAPI document: its `properties` (non-empty) and `required` list. */
export interface FalEndpointInput {
  properties: Record<string, any>;
  required: string[];
}

/**
 * Resolves an endpoint's input schema in fal's OpenAPI document (the request
 * body's `$ref` into `components.schemas`), or null when it is missing or has
 * no properties.
 */
export function falEndpointInput(schema: Record<string, unknown> | null, endpointId: string): FalEndpointInput | null {
  const paths = schema?.paths as Record<string, any> | undefined;
  const ref = paths?.[`/${endpointId}`]?.post?.requestBody?.content?.['application/json']?.schema?.$ref;
  if (typeof ref !== 'string') return null;
  const input = (schema?.components as Record<string, any> | undefined)?.schemas?.[ref.split('/').pop()!];
  const properties = input?.properties;
  if (!properties || typeof properties !== 'object' || Object.keys(properties).length === 0) return null;
  const required = Array.isArray(input.required) ? input.required.filter((field: unknown): field is string => typeof field === 'string') : [];
  return { properties, required };
}

/** fal endpoint IDs: `owner/alias[/path...]`. */
const ENDPOINT_ID = /^[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)+$/;

/** Whether `id` is a fal endpoint ID of at most 64 characters (the discovery service-name limit). */
export function isFalEndpointId(id: string): boolean {
  return id.length <= 64 && ENDPOINT_ID.test(id);
}

const HEALTH_CHECK_TIMEOUT_MS = 15_000;
/** Endpoint IDs per fal model-list request. */
const MODEL_LOOKUP_BATCH = 50;
const MODEL_LOOKUP_PAUSE_MS = 200;

/**
 * A readable reason from a fal error body: `detail` as a string, the
 * messages of a validation `detail` list, or `error` / `message`.
 */
export function falErrorReason(body: Record<string, unknown> | null): string | undefined {
  if (!body) return undefined;
  const detail = body.detail;
  if (typeof detail === 'string' && detail.trim()) return detail.slice(0, 500);
  if (Array.isArray(detail)) {
    const messages = detail.map(item => {
      const entry = item as { msg?: unknown; loc?: unknown } | null;
      if (typeof entry?.msg !== 'string') return null;
      const field = Array.isArray(entry.loc) ? entry.loc.filter(part => part !== 'body').join('.') : '';
      return field ? `${field}: ${entry.msg}` : entry.msg;
    }).filter((message): message is string => !!message);
    if (messages.length > 0) return messages.join('; ').slice(0, 500);
  }
  for (const key of ['error', 'message', 'error_type'] as const) {
    const value = body[key];
    if (typeof value === 'string' && value.trim()) return value.slice(0, 500);
  }
  return detail === undefined || detail === null ? undefined : JSON.stringify(detail).slice(0, 500);
}

export type FalAccount =
  | { status: 'ok'; balanceUsd: number }
  | { status: 'rejected'; reason: string }
  | { status: 'no_permission' }
  | { status: 'unknown'; reason: string };

/**
 * Read fal's public model list for the given endpoint IDs: endpoint ID →
 * status (`active`, `deprecated`, ...). IDs missing from the result no longer
 * exist on fal. Returns null when fal does not answer clearly. fal answers a
 * whole lookup with `404 Endpoint(s) not found` when any one requested
 * endpoint is unknown, so such a lookup is repeated per endpoint, one at a
 * time with a short pause, stopping at the first unclear answer (for example
 * a rate limit). The seller's key is sent because fal rate-limits anonymous
 * lookups.
 */
export async function readFalModelStatuses(platformUrl: string, authorization: string, services: string[]): Promise<Map<string, string> | null> {
  const statuses = new Map<string, string>();
  const lookup = async (ids: string[]): Promise<boolean> => {
    const query = new URLSearchParams(ids.map((id): [string, string] => ['endpoint_id', id]));
    const response = await fetch(`${platformUrl}/v1/models?${query}`, {
      headers: { authorization },
      redirect: 'error',
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
    });
    if (response.status === 404) {
      const error = (await readJson(response))?.error as { message?: unknown } | undefined;
      if (error?.message !== 'Endpoint(s) not found') return false;
      if (ids.length === 1) return true;
      for (const id of ids) {
        await new Promise(resolve => setTimeout(resolve, MODEL_LOOKUP_PAUSE_MS));
        if (!await lookup([id])) return false;
      }
      return true;
    }
    if (!response.ok) return false;
    const models = (await readJson(response))?.models;
    if (!Array.isArray(models)) return false;
    for (const model of models as Array<{ endpoint_id?: unknown; metadata?: { status?: unknown } }>) {
      if (typeof model?.endpoint_id === 'string') {
        statuses.set(model.endpoint_id, typeof model.metadata?.status === 'string' ? model.metadata.status : 'active');
      }
    }
    return true;
  };
  try {
    for (let start = 0; start < services.length; start += MODEL_LOOKUP_BATCH) {
      if (!await lookup(services.slice(start, start + MODEL_LOOKUP_BATCH))) return null;
    }
    return statuses;
  } catch {
    return null;
  }
}

/**
 * Read the account's credit balance with the seller key. fal answers 401 for
 * an invalid key and 403 for a valid key without the `billing:usage:read`
 * permission.
 */
export async function readFalAccount(platformUrl: string, authorization: string): Promise<FalAccount> {
  try {
    const response = await fetch(`${platformUrl}/v1/account/billing?expand=credits`, {
      headers: { authorization },
      redirect: 'error',
      signal: AbortSignal.timeout(HEALTH_CHECK_TIMEOUT_MS),
    });
    if (response.status === 401) return { status: 'rejected', reason: 'fal rejected the API key (HTTP 401)' };
    if (response.status === 403) return { status: 'no_permission' };
    if (!response.ok) return { status: 'unknown', reason: `fal billing check returned HTTP ${response.status}` };
    const credits = (await readJson(response))?.credits as { current_balance?: unknown } | undefined;
    if (typeof credits?.current_balance !== 'number') return { status: 'unknown', reason: 'fal billing check returned no balance' };
    return { status: 'ok', balanceUsd: credits.current_balance };
  } catch (cause) {
    return { status: 'unknown', reason: `fal billing check failed: ${cause instanceof Error ? cause.message : String(cause)}` };
  }
}

/**
 * The upstream account status for a fal account read with billing permission:
 * unavailable when fal rejects the key or the balance is at or below
 * `minBalanceUsd` (out of credit), else available with the balance.
 */
export function falUpstreamAccountStatus(account: Exclude<FalAccount, { status: 'no_permission' }>, minBalanceUsd: number): UpstreamAccountStatus {
  if (account.status === 'rejected') return { status: 'unavailable', reason: account.reason };
  if (account.status === 'unknown') return account;
  if (account.balanceUsd <= minBalanceUsd) {
    return { status: 'unavailable', reason: `fal balance $${account.balanceUsd.toFixed(2)} is at or below the $${minBalanceUsd} minimum`, outOfCredit: true };
  }
  return { status: 'available', balanceUsd: account.balanceUsd };
}
