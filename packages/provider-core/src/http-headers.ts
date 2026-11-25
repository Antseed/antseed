import pkg from '../package.json' with { type: 'json' };

/**
 * The user agent the relay sends upstream unless the plugin sets one. The buyer's is never sent:
 * it names the buyer's client, and bot protection in front of an upstream may refuse it.
 */
export const SELLER_USER_AGENT = `antseed-seller/${pkg.version}`;

const HOP_BY_HOP_HEADERS = new Set([
  'connection', 'expect', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailers', 'transfer-encoding', 'upgrade',
]);

const INTERNAL_HEADERS = new Set([
  'x-antseed-provider',
  'x-antseed-service',
]);

export interface StripRelayRequestHeadersOptions {
  stripHeaderPrefixes?: string[];
  stripHeaderNames?: string[];
}

export function stripRelayRequestHeaders(
  headers: Record<string, string>,
  options: StripRelayRequestHeadersOptions = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  const stripPrefixes = options.stripHeaderPrefixes ?? [];
  const stripNames = new Set((options.stripHeaderNames ?? []).map((name) => name.toLowerCase()));

  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(lower)
      || INTERNAL_HEADERS.has(lower)
      || lower === 'host'
      || lower === 'content-length'
      || lower === 'accept-encoding'
      || stripNames.has(lower)
      || stripPrefixes.some((prefix) => lower.startsWith(prefix))
    ) {
      continue;
    }
    out[key] = value;
  }

  return out;
}

export function stripRelayResponseHeaders(response: Response): Record<string, string> {
  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (!HOP_BY_HOP_HEADERS.has(lower) && lower !== 'content-encoding' && lower !== 'content-length') {
      headers[lower] = value;
    }
  });
  return headers;
}
