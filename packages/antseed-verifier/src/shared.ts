import { createHash } from 'node:crypto'
import { keccak_256 } from '@noble/hashes/sha3.js'
import { antseedRdV1 } from './report-data.js'

/**
 * Shared constants and wire codecs used by both halves of the SDK (buyer verifier
 * and seller prover). The single source of truth for the attestation request and
 * response shape and the seller-bound preimage, so both sides agree byte-for-byte.
 */

/**
 * The advertised and pinned verifier id (also the seller-side prover's name).
 * Hyphenated — no '@' or '/' — so capability strings satisfy PEER_CAPABILITY_PATTERN.
 */
export const VERIFIER_ID = 'antseed-verifier'

/**
 * A claim id is the verifier id namespaced by the capability id, e.g.
 * 'antseed-verifier:seller-node-tee-genuine'. One claim per capability.
 */
export function claimId(capId: string): string {
  return `${VERIFIER_ID}:${capId}`
}

/**
 * Reserved control-plane path the buyer's verifier reaches the seller's prover at.
 * The prefix must match @antseed/node's ANTSEED_ATTEST_PATH; the seller dispatches it
 * (before provider or service matching) to the prover whose name === VERIFIER_ID.
 */
export const ATTEST_PATH = `/_antseed/attest/${VERIFIER_ID}`

/** Freshness nonce length, in bytes. */
export const NONCE_BYTES = 32

/**
 * A PeerId is the canonical AntSeed identifier: 40 lowercase hex chars (the peer's
 * EVM address, no 0x prefix). Lowercase and validate it, so bindings are symmetric on
 * both sides regardless of input casing.
 */
export function normalizePeerId(peerId: string): string {
  const p = peerId.trim().toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(p)) {
    throw new Error(`invalid peerId: expected 40 hex chars (EVM address, no 0x), got "${peerId.slice(0, 16)}..."`)
  }
  return p
}

/**
 * The seller node's report_data binding: the {peerId} instance of the compositional scheme
 * `antseed-rd-v1` (see report-data.ts). The configfs collector mints exactly this, so the
 * buyer's node cap recomputes and enforces the same bytes.
 */
export function computeReportData(nonce: Uint8Array, peerId: string): Buffer {
  return Buffer.from(antseedRdV1.build(nonce, { peerId: normalizePeerId(peerId) }))
}

/** The dependent capability whose own evidence is excluded from the bundle it signs over. */
const SELLER_BOUND_CAP_ID = 'seller-bound'

/**
 * Canonical digest over the whole attestation bundle — every cap's evidence entry
 * except seller-bound's own signature (it cannot sign over itself). A sort by cap id
 * makes both halves agree regardless of map iteration order. Length-prefixing both the id
 * and the bytes (len(id) ‖ id ‖ len(bytes) ‖ bytes) keeps the concatenation unambiguous, so
 * no cap can shift bytes across an entry boundary. One seller signature therefore covers
 * the node quote and the provider quote (and any later caps) together.
 */
export function bundleDigest(evidence: Record<string, Uint8Array>): Uint8Array {
  const ids = Object.keys(evidence).filter((id) => id !== SELLER_BOUND_CAP_ID).sort()
  const h = createHash('sha256')
  const u32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32BE(n, 0); return b }
  for (const id of ids) {
    const bytes = evidence[id]!
    const idBuf = Buffer.from(id, 'utf8')
    h.update(u32(idBuf.length))
    h.update(idBuf)
    h.update(u32(bytes.length))
    h.update(Buffer.from(bytes))
  }
  return new Uint8Array(h.digest())
}

/**
 * seller-bound preimage — the 32-byte digest the seller signs with its AntSeed
 * identity key:
 *
 *   keccak256( nonce(32) || bundleDigest(32) || utf8(peerId) )
 *
 * It binds the seller's identity signature to the entire bundle (via bundleDigest), this
 * nonce (freshness), and this peer id (identity), so nobody can pair a seller's signature
 * with different evidence or replay it. Defined here so both halves compute identical bytes.
 */
export function sellerBoundPreimage(nonce: Uint8Array, digest: Uint8Array, peerId: string): Uint8Array {
  const pid = new TextEncoder().encode(normalizePeerId(peerId))
  const preimage = new Uint8Array(nonce.length + digest.length + pid.length)
  preimage.set(nonce, 0)
  preimage.set(digest, nonce.length)
  preimage.set(pid, nonce.length + digest.length)
  return keccak_256(preimage)
}

/** Prefix of the config keys under which a prover exposes collected evidence to later collectors. */
const EVIDENCE_KEY_PREFIX = 'evidence:'

/**
 * Config key under which a prover exposes an already-collected capability's evidence
 * (base64) to later collectors in the same request. It lets a dependent capability
 * (seller-bound) read the whole bundle it must bind to, without provider specifics.
 */
export function evidenceConfigKey(capId: string): string {
  return `${EVIDENCE_KEY_PREFIX}${capId}`
}

/** Inverse of evidenceConfigKey: the cap id an "evidence:<capId>" config key carries, else undefined. */
export function parseEvidenceConfigKey(key: string): string | undefined {
  return key.startsWith(EVIDENCE_KEY_PREFIX) ? key.slice(EVIDENCE_KEY_PREFIX.length) : undefined
}

/** Body the buyer sends to the prover: a fresh nonce and the menu of caps it wants. */
export interface AttestRequestBody {
  /** base64 of the 32-byte freshness nonce. */
  nonce: string
  /** capability ids the buyer is asking the seller to attest. */
  caps: string[]
}

/** Body the seller's prover returns: per-capability evidence (a cap may have none). */
export interface AttestResponseBody {
  /** capId -> base64 of that capability's opaque evidence bytes. */
  evidence: Record<string, string>
}

export function encodeAttestRequest(nonce: Uint8Array, caps: string[]): Uint8Array {
  const body: AttestRequestBody = { nonce: Buffer.from(nonce).toString('base64'), caps }
  return new TextEncoder().encode(JSON.stringify(body))
}

/**
 * Upper bound on an attestation request or response body before JSON.parse. Both halves
 * parse counterparty-controlled bytes (the prover reads buyer requests; the buyer reads
 * seller responses), so a hostile peer must not be able to force an unbounded parse.
 */
export const MAX_ATTEST_BODY_BYTES = 512 * 1024

function assertBodySize(body: Uint8Array, what: string): void {
  if (body.length > MAX_ATTEST_BODY_BYTES) {
    throw new Error(`${what} exceeds ${MAX_ATTEST_BODY_BYTES} bytes (${body.length})`)
  }
}

export function decodeAttestRequest(body: Uint8Array): { nonce: Uint8Array; caps: string[] } {
  assertBodySize(body, 'attestation request')
  const parsed = JSON.parse(new TextDecoder().decode(body)) as Partial<AttestRequestBody>
  if (typeof parsed.nonce !== 'string' || parsed.nonce.length === 0) {
    throw new Error('attestation request missing "nonce"')
  }
  const nonce = Buffer.from(parsed.nonce, 'base64')
  if (nonce.length !== NONCE_BYTES) {
    throw new Error(`attestation nonce must be ${NONCE_BYTES} bytes, got ${nonce.length}`)
  }
  if (!Array.isArray(parsed.caps) || !parsed.caps.every((c) => typeof c === 'string')) {
    throw new Error('attestation request missing "caps" (string[])')
  }
  return { nonce, caps: parsed.caps }
}

export function encodeAttestResponse(evidence: Record<string, Uint8Array>): Uint8Array {
  const enc: Record<string, string> = {}
  for (const [capId, bytes] of Object.entries(evidence)) {
    enc[capId] = Buffer.from(bytes).toString('base64')
  }
  const body: AttestResponseBody = { evidence: enc }
  return new TextEncoder().encode(JSON.stringify(body))
}

export function decodeAttestResponse(body: Uint8Array): Record<string, Uint8Array> {
  assertBodySize(body, 'attestation response')
  const parsed = JSON.parse(new TextDecoder().decode(body)) as Partial<AttestResponseBody>
  if (parsed.evidence === null || typeof parsed.evidence !== 'object') {
    throw new Error('attestation response missing "evidence" object')
  }
  const out: Record<string, Uint8Array> = {}
  for (const [capId, b64] of Object.entries(parsed.evidence)) {
    if (typeof b64 !== 'string') {
      throw new Error(`attestation evidence for "${capId}" is not base64`)
    }
    out[capId] = new Uint8Array(Buffer.from(b64, 'base64'))
  }
  return out
}
