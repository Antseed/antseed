/**
 * Client credential headers the buyer never forwards to a seller (#1104).
 *
 * A seller authenticates its own upstream with its own credentials — every
 * provider plugin relays through provider-core's `swapAuthHeader`, which drops
 * whatever auth the request carried — and the buyer pays on-chain through the
 * payment channel. So nothing on the network consumes a client's provider key,
 * session cookie, or proxy credential; forwarding one would only hand it to a
 * seller, which sees the raw request before any swap.
 *
 * Applied by the buyer proxy when it builds the request for a seller, and by
 * the local front doors (API-key gateway, system proxy) before they forward
 * to the buyer.
 */
export const CLIENT_CREDENTIAL_HEADERS: ReadonlySet<string> = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
  'x-goog-api-key',
  // Azure OpenAI's key header. Matched by exact name only: pattern matching
  // (anything containing "auth"/"key"/"token") would also strip AntSeed's own
  // `x-antseed-spending-auth`, which buyer-core reads after the proxy.
  'api-key',
])

export function isClientCredentialHeader(name: string): boolean {
  return CLIENT_CREDENTIAL_HEADERS.has(name.toLowerCase())
}
