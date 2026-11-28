import type { ServiceApiProtocol, ServiceCapabilities } from '@antseed/node';
import {
  fetchUpstreamJson,
  fillReasoningCapabilities,
  namesReasoningLevel,
  servicesAwaitingReasoning,
  type UpstreamReasoning,
  warnUnreadListing,
} from '@antseed/provider-core';

function objectOf(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

/**
 * Reasoning levels of an Ollama `/api/show` answer: the named levels in
 * `thinking.values` (booleans are on/off, not levels). Null when the answer has
 * no `thinking` object or says the model cannot think.
 */
export function ollamaReasoning(show: unknown): UpstreamReasoning | null {
  const thinking = objectOf(objectOf(show)?.thinking);
  if (!thinking || !Array.isArray(thinking.values)) return null;
  const values: unknown[] = thinking.values;
  if (!values.some((value) => value === true || (typeof value === 'string' && value !== 'none'))) return null;
  return { efforts: values.filter((value) => typeof value !== 'boolean'), reasons: true };
}

/**
 * Reasoning levels of a llama.cpp server `/props` answer: the levels its chat
 * template renders distinctly (`chat_template_caps.reasoning_effort_levels`)
 * minus the ones it raises on (`reasoning_effort_rejected`). Null for any other shape.
 */
export function llamaCppReasoning(props: unknown): UpstreamReasoning | null {
  const caps = objectOf(objectOf(props)?.chat_template_caps);
  if (!caps || !Array.isArray(caps.reasoning_effort_levels)) return null;
  const rejected: unknown[] = Array.isArray(caps.reasoning_effort_rejected) ? caps.reasoning_effort_rejected : [];
  const levels = (caps.reasoning_effort_levels as unknown[]).filter((level) => !rejected.includes(level));
  return { efforts: levels, reasons: namesReasoningLevel(levels) };
}

/** The server's reasoning levels for one model; `unread` when neither endpoint answered. */
async function upstreamReasoning(
  base: string,
  model: string,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
): Promise<UpstreamReasoning | null | 'unread'> {
  // llama.cpp: one model per server, or `?model=` in router mode; `autoload=false` never loads a model to answer.
  const props = await fetchUpstreamJson(
    `${base}/props?${new URLSearchParams({ model, autoload: 'false' })}`,
    { headers },
    fetchImpl,
  );
  if (objectOf(objectOf(props)?.chat_template_caps)) return llamaCppReasoning(props);
  const show = await fetchUpstreamJson(
    `${base}/api/show`,
    { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ model }) },
    fetchImpl,
  );
  if (props === undefined && show === undefined) return 'unread';
  return ollamaReasoning(show);
}

/**
 * Announce the reasoning efforts of services the seller did not list itself, from the local server's own model metadata, read
 * at start with the relay's base URL and key. The server is recognised by the
 * shape of its answer. Leaves capabilities unchanged on any failure, and logs
 * one line when the server could not be read.
 */
export async function announceLocalReasoning(
  baseUrl: string,
  headers: Record<string, string>,
  services: string[],
  serviceApiProtocols: Record<string, ServiceApiProtocol[]> | undefined,
  serviceCapabilities: Record<string, ServiceCapabilities>,
  upstreamModelOf: (service: string) => string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const pending = servicesAwaitingReasoning(services, serviceApiProtocols, serviceCapabilities);
  if (pending.length === 0) return;
  const base = baseUrl.replace(/\/+$/, '');
  const byModel = new Map<string, Promise<UpstreamReasoning | null | 'unread'>>();
  for (const service of pending) {
    const model = upstreamModelOf(service);
    if (!byModel.has(model)) byModel.set(model, upstreamReasoning(base, model, headers, fetchImpl).catch(() => 'unread' as const));
  }
  let unread = false;
  for (const service of pending) {
    const reasoning = await byModel.get(upstreamModelOf(service));
    if (reasoning === 'unread') unread = true;
    else fillReasoningCapabilities(serviceCapabilities, service, reasoning);
  }
  // One line for the server, however many models it could not answer for.
  if (unread) warnUnreadListing(`${base}/props`, `${base}/api/show`);
}
