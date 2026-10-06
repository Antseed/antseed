import { createHash } from 'node:crypto'

/**
 * Compositional report_data schemes. A TDX quote has one 64-byte report_data; how a
 * provider commits this round's freshness (and any TEE-bound key or payload) into it varies by
 * hardware stack. The SDK verifies against a closed, version-pinned registry:
 *
 *   - antseed-rd-v1           the canonical, compositional scheme. The nonce is always bound;
 *                             optional fields (peerId, e2ePubkey) are included only when their
 *                             ingredient is present, in canonical tag order, each tagged and
 *                             length-prefixed. One rule covers every combination — the node
 *                             cap is the {peerId} case. A new field takes a new tag and version bump.
 *   - nonce-pubkey-sha256-v1  a foreign construction (e.g. Chutes) the SDK does not control:
 *                             report_data[0:32] = SHA-256(nonce_hex ‖ e2ePubkey_b64). The SDK
 *                             replicates its exact bytes only to verify a quote it minted.
 *
 * The same build() runs on the prover (to mint report_data) and the buyer (to recompute and
 * compare). Determinism is the safety property, and because the nonce is always bound, a
 * mis-declared or downgraded field set can only fail, never falsely pass. This registry is
 * frozen per SDK version; the trust registry pins the SDK, so prover and verifier agree.
 */

export interface BindingIngredients {
  /** 40-hex EVM address — identity binding (the node cap's ingredient). */
  peerId?: string
  /** base64 TEE-generated public key — E2E or signing providers. */
  e2ePubkey?: string
  /** ACI workload keyset digest, "sha256:<64 hex>" — the ACI ingredient. */
  keysetDigest?: string
}

export interface ReportDataScheme {
  id: string
  /** Leading report_data bytes this scheme commits (the rest may be provider-defined). */
  compareLen: 32 | 64
  /** Build the report_data commitment (prover mints it; buyer recomputes it). */
  build(nonce: Uint8Array, ing: BindingIngredients): Uint8Array
  /** The nonce a downstream GPU (NRAS) verifier must bind to under this scheme. */
  gpuNonce(nonce: Uint8Array, ing: BindingIngredients): Uint8Array
}

const RD_DOMAIN = 'antseed-rd-v1'

/** Prefix a value with its 4-byte big-endian length, so concatenated values stay unambiguous. */
function lenPrefixed(b: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(b.length, 0)
  return Buffer.concat([len, b])
}

/**
 * Frozen field table for antseed-rd-v1. `tag` is the canonical ordering key and a per-field
 * domain separator. To add a field, use a new tag and an SDK version bump; never reorder or
 * reuse a tag.
 */
const FIELDS: { tag: number; get: (i: BindingIngredients) => Buffer | null }[] = [
  { tag: 0x01, get: (i) => (i.peerId ? Buffer.from(i.peerId.toLowerCase(), 'hex') : null) },
  { tag: 0x02, get: (i) => (i.e2ePubkey ? Buffer.from(i.e2ePubkey, 'base64') : null) },
]

export const antseedRdV1: ReportDataScheme = {
  id: RD_DOMAIN,
  compareLen: 64,
  build(nonce, ing) {
    // Unambiguous TLV: fixed domain tag, then every value length-prefixed (including the nonce)
    // in fixed ascending field order, so no two distinct inputs share a preimage.
    const h = createHash('sha512')
    h.update(Buffer.from(RD_DOMAIN, 'utf8'))
    h.update(lenPrefixed(Buffer.from(nonce)))
    for (const f of FIELDS) {
      const b = f.get(ing)
      if (!b) continue
      h.update(Buffer.from([f.tag]))
      h.update(lenPrefixed(b))
    }
    return new Uint8Array(h.digest())
  },
  gpuNonce(nonce) {
    return nonce // the GPU evidence binds the raw round nonce
  },
}

export const noncePubkeySha256V1: ReportDataScheme = {
  id: 'nonce-pubkey-sha256-v1',
  compareLen: 32,
  build(nonce, ing) {
    if (!ing.e2ePubkey) throw new Error(`${this.id} requires e2ePubkey`)
    const commit = createHash('sha256')
      .update(Buffer.from(nonce).toString('hex'), 'utf8') // nonce as its hex string (their choice)
      .update(ing.e2ePubkey, 'utf8') // pubkey as its base64 string (their choice)
      .digest()
    const rd = Buffer.alloc(64) // [0:32] = commitment, [32:64] provider-defined
    commit.copy(rd, 0)
    return new Uint8Array(rd)
  },
  gpuNonce(nonce, ing) {
    // The GPU evidence's NRAS eat_nonce is this derived value, SHA-256(nonce_hex ‖ pubkey_b64) —
    // the same commitment report_data[0:32] carries. (NRAS returns overall-att-result true only
    // for this value, not the raw nonce.)
    return this.build(nonce, ing).subarray(0, 32)
  },
}

export const aciKeysetV1: ReportDataScheme = {
  id: 'aci-keyset-v1',
  compareLen: 32,
  build(nonce, ing) {
    // ACI report_data (private-ai-gateway digest.ts): SHA-256 of a fixed statement over the
    // workload keyset digest and the nonce, which the TEE places zero-padded to 64 in the quote.
    const digest = ing.keysetDigest
    if (!digest || !/^sha256:[0-9a-f]{64}$/.test(digest)) {
      throw new Error(`${this.id} requires keysetDigest "sha256:<64 hex>"`)
    }
    if (nonce.length !== 32) throw new Error(`${this.id} requires a 32-byte nonce`)
    const statement = `{"keyset_digest":"${digest}","nonce":"${Buffer.from(nonce).toString('hex')}","purpose":"aci.report_data.v1"}`
    const rd = Buffer.alloc(64)
    createHash('sha256').update(statement, 'utf8').digest().copy(rd, 0)
    return new Uint8Array(rd)
  },
  gpuNonce(nonce) {
    return nonce // ACI treats GPU CC as supplemental; bind the raw round nonce
  },
}

export const REPORT_DATA_SCHEMES: Record<string, ReportDataScheme> = {
  [antseedRdV1.id]: antseedRdV1,
  [noncePubkeySha256V1.id]: noncePubkeySha256V1,
  [aciKeysetV1.id]: aciKeysetV1,
}

export function getReportDataScheme(id: string): ReportDataScheme | undefined {
  return REPORT_DATA_SCHEMES[id]
}

/**
 * Verify a quote's report_data against a frozen scheme. It returns null on a match, else a reason.
 * It compares only the scheme's `compareLen` leading bytes (a provider may use the rest).
 */
export function verifyReportData(
  schemeId: string,
  reportData: Uint8Array,
  nonce: Uint8Array,
  ing: BindingIngredients,
): string | null {
  const scheme = getReportDataScheme(schemeId)
  if (!scheme) return `unknown report_data scheme "${schemeId}" (not in this SDK's frozen registry)`
  let want: Uint8Array
  try {
    want = scheme.build(nonce, ing)
  } catch (err) {
    return `report_data scheme "${schemeId}": ${err instanceof Error ? err.message : String(err)}`
  }
  const n = scheme.compareLen
  if (reportData.length < n || !Buffer.from(reportData.subarray(0, n)).equals(Buffer.from(want.subarray(0, n)))) {
    return `report_data does not match scheme "${schemeId}" for this nonce`
  }
  return null
}
