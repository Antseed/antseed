/**
 * Which response headers leave a seller. Whatever a provider plugin relays,
 * a buyer only ever sees Antseed's own `x-antseed-*` headers and the generic
 * ones clients act on. The rest of what an upstream API sends (the account's
 * plan and usage limits, request and session ids, cookies, CDN and security
 * headers) describes the seller's own setup and is never passed on.
 */
const EXPOSED_RESPONSE_HEADERS = new Set([
  'content-type', 'content-disposition', 'content-language', 'cache-control', 'retry-after',
]);

export function isExposedResponseHeader(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith('x-antseed-') || EXPOSED_RESPONSE_HEADERS.has(lower);
}

/** `headers` without the ones a seller must not expose. */
export function exposedResponseHeaders(headers: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(headers).filter(([name]) => isExposedResponseHeader(name)));
}
