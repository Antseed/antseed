import { isKeyedRequestTerms, KEYED_RELAY_REQUEST_PATH, type KeyedRelayTarget, type KeyedRequestTerms } from '@antseed/node';

export { KEYED_RELAY_REQUEST_PATH };

export interface KeyedRelayTargetOptions {
  /** The seller's upstream base URL, as the relay joins it with request paths. */
  baseUrl: string;
  apiKey: string;
  /** The service's upstream model (after the seller's alias map). */
  resolveUpstreamModel: (service: string) => string;
  extraHeaders?: Record<string, string>;
  pathRewrite?: Record<string, string>;
  /** The most output tokens one request may ask for; absent, no cap. */
  maxTokens?: number;
  /** The token-limit field the upstream reads: `max_completion_tokens` on api.openai.com, else `max_tokens`. */
  maxTokensField?: KeyedRequestTerms['maxTokensField'];
  /** Body fields the seller fixes. On api.openai.com `service_tier` is `default` unless set here. */
  pinned?: Record<string, unknown>;
}

/**
 * The seller-keyed blind relay target of an OpenAI-compatible upstream: the
 * chat completions URL the seller's own relay would call, with the seller's
 * key and extra headers. The seller writes these into the buyer's TLS session
 * without reading it, and checks each request against the terms before it
 * forwards it. Null for an upstream that is not https.
 */
export function openAiKeyedRelayTarget(options: KeyedRelayTargetOptions): ((service: string) => KeyedRelayTarget | null) | null {
  let url: URL;
  try {
    url = new URL(options.baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.search || url.hash) return null;
  const path = `${url.pathname.replace(/\/+$/, '')}${options.pathRewrite?.[KEYED_RELAY_REQUEST_PATH] ?? KEYED_RELAY_REQUEST_PATH}`;
  const openAi = url.hostname === 'api.openai.com';
  // OpenAI bills a priority tier above the list price; pin the standard one.
  const pinned = { ...(openAi ? { service_tier: 'default' } : {}), ...options.pinned };
  const request: KeyedRequestTerms = {
    maxTokensField: options.maxTokensField ?? (openAi ? 'max_completion_tokens' : 'max_tokens'),
    ...(options.maxTokens !== undefined ? { maxTokens: options.maxTokens } : {}),
    ...(Object.keys(pinned).length > 0 ? { pinned } : {}),
  };
  if (!isKeyedRequestTerms(request)) {
    throw new Error('keyed relay terms are malformed: the token cap must be a positive integer, and pinned fields may not be ones the relay writes itself');
  }
  const headers: Array<[string, string]> = [['Authorization', `Bearer ${options.apiKey}`]];
  for (const [name, value] of Object.entries(options.extraHeaders ?? {})) {
    if (name.toLowerCase() === 'authorization' || name.toLowerCase() === 'host') continue;
    headers.push([name, value]);
  }
  return (service) => ({
    host: url.hostname,
    port: url.port ? Number(url.port) : 443,
    baseUrl: options.baseUrl,
    path,
    model: options.resolveUpstreamModel(service),
    headers,
    request,
  });
}
