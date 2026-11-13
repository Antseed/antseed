import { brotliDecompressSync, gunzipSync, inflateSync } from 'node:zlib';
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

/**
 * A data provider's answer for the buyer: its body decoded when the provider sent it compressed
 * (gzip, deflate or br), since the encoding header is not forwarded, and the forwarded headers
 * without a length that no longer matches. An answer that does not decode is passed on as sent.
 */
export function buyerFacingDataResponse<T extends { headers: Record<string, string>; body: Uint8Array }>(response: T): T {
  const encodingHeader = Object.entries(response.headers).find(([name]) => name.toLowerCase() === 'content-encoding');
  const encodings = (encodingHeader?.[1] ?? '').split(',').map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0 && value !== 'identity');
  if (encodings.length === 0 || response.body.length === 0) return { ...response, headers: buyerFacingResponseHeaders(response.headers) };
  // Encodings are listed in the order they were applied: undo them last first. An encoding this
  // node cannot undo, or a body that does not decode, goes on as sent with its Content-Encoding.
  const asSent = { ...response, headers: { ...buyerFacingResponseHeaders(response.headers), [encodingHeader![0]]: encodingHeader![1] } };
  let body: Uint8Array = response.body;
  for (const encoding of [...encodings].reverse()) {
    const decode = encoding === 'gzip' || encoding === 'x-gzip' ? gunzipSync
      : encoding === 'deflate' ? inflateSync
      : encoding === 'br' ? brotliDecompressSync
      : null;
    if (!decode) return asSent;
    try {
      body = new Uint8Array(decode(body));
    } catch {
      return asSent;
    }
  }
  const headers = Object.fromEntries(Object.entries(buyerFacingResponseHeaders(response.headers))
    .filter(([name]) => name.toLowerCase() !== 'content-length'));
  return { ...response, headers, body };
}

export function buyerFacingResponseHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    if (FORWARDED_RESPONSE_HEADERS.has(lower) || lower.startsWith(ANTSEED_HEADER_PREFIX)) out[name] = value;
  }
  return out;
}
