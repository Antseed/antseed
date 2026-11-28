import type { ServiceApiProtocol, ServiceCapabilities } from '@antseed/node';
import { validateServiceCapabilityFields } from '@antseed/node';

/** Services in these API formats announce reasoning efforts. */
export const REASONING_EFFORT_PROTOCOLS: readonly ServiceApiProtocol[] = ['openai-chat-completions', 'openai-responses'];

export const UPSTREAM_LISTING_MAX_BYTES = 4 * 1024 * 1024;
export const UPSTREAM_LISTING_TIMEOUT_MS = 10_000;

/**
 * What an upstream's own model listing says about one model's reasoning, as it
 * came off the wire. {@link fillReasoningCapabilities} validates every value.
 */
export interface UpstreamReasoning {
  /** The levels the upstream documents as accepted for its reasoning-effort field. */
  efforts?: unknown;
  /** The upstream says the model reasons. */
  reasons?: boolean;
}

/** Whether a level list names a level other than `none`, so the model can reason. */
export function namesReasoningLevel(levels: unknown): boolean {
  return Array.isArray(levels) && levels.some((level) => typeof level === 'string' && level !== 'none');
}

/**
 * Services whose effort list an upstream listing may fill: a Chat Completions
 * or Responses service that announces no list and not `reasoning: false`.
 */
export function servicesAwaitingReasoning(
  services: readonly string[],
  serviceApiProtocols: Record<string, ServiceApiProtocol[]> | undefined,
  serviceCapabilities: Record<string, ServiceCapabilities> | undefined,
): string[] {
  return services.filter((service) => {
    if (!serviceApiProtocols?.[service]?.some((protocol) => REASONING_EFFORT_PROTOCOLS.includes(protocol))) return false;
    const caps = serviceCapabilities?.[service];
    return caps?.reasoning !== false && caps?.reasoningEfforts === undefined;
  });
}

/**
 * Fill one service's effort list from its upstream, in place. What the seller
 * configured wins: the list is filled only when the seller set none, never with
 * `reasoning: false`, and `reasoning: true` is set only when the upstream says
 * the model reasons. A list with any label that breaks the shared label rule,
 * or an empty one, fills nothing. Returns whether the list was filled.
 */
export function fillReasoningCapabilities(
  serviceCapabilities: Record<string, ServiceCapabilities>,
  service: string,
  upstream: UpstreamReasoning | null | undefined,
): boolean {
  if (!upstream || !Array.isArray(upstream.efforts) || upstream.efforts.length === 0) return false;
  const configured = serviceCapabilities[service] ?? {};
  if (configured.reasoning === false || configured.reasoningEfforts !== undefined) return false;
  const next: ServiceCapabilities = { ...configured, reasoningEfforts: [...upstream.efforts] as string[] };
  if (configured.reasoning === undefined && upstream.reasons === true) next.reasoning = true;
  // The announce path's own rule (label pattern, count, duplicates), so a filled list always announces.
  if (validateServiceCapabilityFields(next).length > 0) return false;
  serviceCapabilities[service] = next;
  return true;
}

/**
 * GET or POST a free, read-only upstream listing and parse its JSON. Returns
 * undefined on any failure: a non-2xx answer, a redirect, a body over
 * {@link UPSTREAM_LISTING_MAX_BYTES}, a timeout or invalid JSON.
 */
export async function fetchUpstreamJson(
  url: string,
  init: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: string } = {},
  fetchImpl: typeof fetch = fetch,
  timeoutMs = UPSTREAM_LISTING_TIMEOUT_MS,
): Promise<unknown> {
  try {
    const signal = AbortSignal.timeout(timeoutMs);
    const response = await fetchImpl(url, { ...init, redirect: 'error', signal });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > UPSTREAM_LISTING_MAX_BYTES) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const reader = response.body?.getReader();
    if (!reader) return undefined;
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > UPSTREAM_LISTING_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return undefined;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return undefined;
  }
}

/** Where a listing was read from, as host and path: never the query, a key or a body. */
export function listingPlace(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname}`;
  } catch {
    return 'the upstream';
  }
}

/** One log line for a listing that could not be read at start, so a seller sees why no list is announced. */
export function warnUnreadListing(...urls: string[]): void {
  console.warn(`reasoning efforts: could not read ${urls.map(listingPlace).join(' or ')}; announcing no list`);
}
