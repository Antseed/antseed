/**
 * Upstream response headers a seller passes on to buyers. Everything else an
 * upstream sends stays with the seller: its account and plan (`x-codex-plan-type`,
 * credit balances, usage and reset windows), rate limits, request ids and cookies
 * say who the seller buys from and on which terms, and no buyer needs them.
 */
const FORWARDED_RESPONSE_HEADERS = new Set([
  'accept-ranges',
  'cache-control',
  'content-disposition',
  'content-language',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'last-modified',
  'location',
  'retry-after',
]);

/** Headers the seller and its providers set themselves. */
const ANTSEED_HEADER_PREFIX = 'x-antseed-';

export function buyerFacingResponseHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    if (FORWARDED_RESPONSE_HEADERS.has(lower) || lower.startsWith(ANTSEED_HEADER_PREFIX)) out[name] = value;
  }
  return out;
}
