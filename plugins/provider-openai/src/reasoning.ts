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
 * Reasoning levels of one model entry from an OpenAI-compatible `/models`
 * listing, by the entry's shape: `capabilities.reasoning_effort` (xAI) or
 * `effort.supported_levels` (DeepSeek). Null for any other shape.
 */
export function modelEntryReasoning(entry: unknown): UpstreamReasoning | null {
  const model = objectOf(entry);
  if (!model) return null;
  const capabilities = objectOf(model.capabilities);
  if (capabilities && Array.isArray(capabilities.reasoning_effort)) {
    return { efforts: capabilities.reasoning_effort, reasons: namesReasoningLevel(capabilities.reasoning_effort) };
  }
  const effort = objectOf(model.effort);
  if (effort && Array.isArray(effort.supported_levels)) {
    return { efforts: effort.supported_levels, reasons: namesReasoningLevel(effort.supported_levels) };
  }
  return null;
}

/**
 * The models listing next to the chat endpoint the relay calls: an explicit
 * `/v1/models` rewrite, else the chat rewrite's prefix (`/v3/chat/completions`
 * gives `/v3/models`), else `/v1/models`. A rewrite that is not a string is ignored.
 */
export function modelsListingPath(pathRewrite: Record<string, string> | undefined): string {
  const explicit: unknown = pathRewrite?.['/v1/models'];
  if (typeof explicit === 'string' && explicit) return explicit;
  const chat: unknown = pathRewrite?.['/v1/chat/completions'];
  if (typeof chat === 'string' && chat.endsWith('/chat/completions')) return `${chat.slice(0, -'/chat/completions'.length)}/models`;
  return '/v1/models';
}

/**
 * Announce the reasoning efforts of chat services that the seller did not list
 * itself, from the upstream's own model listing, read once at start with the
 * relay's base URL, key and extra headers. Leaves capabilities unchanged when
 * the listing can't be read (and logs one line) or names no reasoning levels.
 */
export async function announceUpstreamReasoning(
  baseUrl: string,
  pathRewrite: Record<string, string> | undefined,
  headers: Record<string, string>,
  services: string[],
  serviceApiProtocols: Record<string, ServiceApiProtocol[]> | undefined,
  serviceCapabilities: Record<string, ServiceCapabilities>,
  upstreamModelOf: (service: string) => string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const pending = servicesAwaitingReasoning(services, serviceApiProtocols, serviceCapabilities);
  if (pending.length === 0) return;
  const url = `${baseUrl.replace(/\/+$/, '')}${modelsListingPath(pathRewrite)}`;
  const listing = await fetchUpstreamJson(url, { headers }, fetchImpl);
  if (listing === undefined) {
    warnUnreadListing(url);
    return;
  }
  const entries = objectOf(listing)?.data;
  if (!Array.isArray(entries)) return;
  for (const service of pending) {
    const upstream = upstreamModelOf(service);
    const entry = entries.find((candidate) => objectOf(candidate)?.id === upstream);
    fillReasoningCapabilities(serviceCapabilities, service, modelEntryReasoning(entry));
  }
}
