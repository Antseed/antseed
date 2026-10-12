/**
 * Generic HTTP collector: it fetches a TDX quote from a seller-configured attestation endpoint.
 * Everything provider-specific (host, path, JSON location of the quote) comes from the caller
 * — no hardcoded hosts or schemas — so any HTTP attestation service wires up through config
 * alone. The {nonce} placeholder in `urlTemplate` is replaced with the hex nonce. `field` is a
 * dot-path to the base64 quote in the response (e.g. "quote" or "data.quote").
 */

/** Resolve a dot-separated path (e.g. "data.quote") against a parsed JSON value. */
function pluck(obj: unknown, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, key) => {
    if (acc && typeof acc === 'object' && key in (acc as Record<string, unknown>)) {
      return (acc as Record<string, unknown>)[key]
    }
    return undefined
  }, obj)
}

/** Hard timeout on an outbound evidence fetch — a hung or slow provider cannot stall the round. */
const FETCH_TIMEOUT_MS = 20_000
/** Reject an over-large declared response body so a hostile endpoint cannot force an OOM parse. */
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** Replace {nonce}, fetch with a timeout and size guard, then parse JSON. */
async function fetchAttestJson(urlTemplate: string, nonce: Uint8Array): Promise<unknown> {
  const url = urlTemplate.replace(/\{nonce\}/g, Buffer.from(nonce).toString('hex'))
  const resp = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) })
  if (!resp.ok) {
    throw new Error(`http attestation endpoint returned HTTP ${resp.status}`)
  }
  const declared = Number(resp.headers?.get('content-length') ?? '0')
  if (declared > MAX_RESPONSE_BYTES) {
    throw new Error(`http attestation response too large (${declared} bytes)`)
  }
  return resp.json()
}

/**
 * Fetch the provider evidence route once. It returns the base64-decoded quote and, when a pubkey
 * field is named, the report_data-binding pubkey string. One fetch keeps the quote and the pubkey
 * from the same response — a two-fetch split could pair a quote with a different instance's key.
 */
export async function collectTdxAndPubkey(
  urlTemplate: string,
  nonce: Uint8Array,
  quoteField: string,
  pubkeyField?: string,
): Promise<{ quote: Uint8Array; pubkey?: string }> {
  const json = await fetchAttestJson(urlTemplate, nonce)
  const q = pluck(json, quoteField)
  if (typeof q !== 'string' || q.length === 0) {
    throw new Error(`http attestation response has no base64 quote at "${quoteField}"`)
  }
  const quote = new Uint8Array(Buffer.from(q, 'base64'))
  if (quote.length === 0) {
    throw new Error(`http attestation quote at "${quoteField}" is not valid base64`)
  }
  if (!pubkeyField) return { quote }
  const pk = pluck(json, pubkeyField)
  if (typeof pk !== 'string' || pk.length === 0) {
    throw new Error(`http attestation response has no string at "${pubkeyField}"`)
  }
  return { quote, pubkey: pk }
}

export async function collectViaHttp(
  urlTemplate: string,
  nonce: Uint8Array,
  field: string,
): Promise<Uint8Array> {
  const json = await fetchAttestJson(urlTemplate, nonce)
  const value = pluck(json, field)
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`http attestation response has no base64 quote at "${field}"`)
  }
  const quote = new Uint8Array(Buffer.from(value, 'base64'))
  if (quote.length === 0) {
    throw new Error(`http attestation quote at "${field}" is not valid base64`)
  }
  return quote
}

/**
 * Like collectViaHttp, but it returns the extracted field re-encoded as JSON bytes instead of
 * base64-decoding it. Why separate: the TDX path wants a lone base64 quote decoded to raw bytes;
 * the GPU path's field holds a structured value (e.g. { arch, evidence_list }) whose shape must
 * survive intact to the NRAS submit, so the code keeps it as JSON rather than decode it.
 */
export async function collectJsonFieldViaHttp(
  urlTemplate: string,
  nonce: Uint8Array,
  field: string,
): Promise<Uint8Array> {
  const json = await fetchAttestJson(urlTemplate, nonce)
  const value = pluck(json, field)
  if (value === undefined || value === null) {
    throw new Error(`http attestation response has no value at "${field}"`)
  }
  return new TextEncoder().encode(JSON.stringify(value))
}
