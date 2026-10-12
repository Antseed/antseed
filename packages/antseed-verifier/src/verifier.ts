import { randomBytes } from 'node:crypto'
import type { AntseedVerifierPlugin, ClaimResult, VerifyContext, VerifyResult } from './antseed-node-types.js'
import './caps/index.js' // side-effect: register the capability menu
import { capabilityIds, getCapability } from './capability.js'
import {
  NODE_TEE_CAP_ID,
  PROVIDER_TEE_CAP_ID,
  defaultVerifyQuote,
  verifyTdxEvidence,
  type ParsedTdxQuote,
  type VerifyQuoteFn,
} from './caps/tee-tdx.js'
import { PROVIDER_CLAIMS_CAP_ID } from './caps/provider-claims.js'
import { readFileSync } from 'node:fs'
import type { MeasuredImagePolicy } from './caps/measured-image.js'
import {
  NONCE_BYTES,
  VERIFIER_ID,
  claimId,
  decodeAttestResponse,
  encodeAttestRequest,
  normalizePeerId,
} from './shared.js'

/**
 * Buyer half. It fetches per-capability evidence from the seller in one attestation round,
 * verifies each requested capability, and returns one ClaimResult per capability. The
 * overall verdict passes only when every required capability passed; extra caps the seller
 * evidenced are reported as informational claims.
 */

/** measured-image derives from (targets) the provider quote; it has no own evidence. */
const MEASURED_IMAGE_ID = 'seller-provider-measured-image'
const SELLER_BOUND_ID = 'seller-bound'

/**
 * The caps that must pass for ok=true. It defaults to the seller node's genuine TDX hardware
 * and the seller-identity binding (the provider TEE, measured-image, and gpu are then
 * informational). A buyer can override the set via ANTSEED_VERIFIER_REQUIRED_CAPS
 * (comma-separated cap ids) to gate on a different guarantee — e.g. a provenance-focused
 * buyer that requires the downstream provider's TEE: "seller-provider-tee-genuine,seller-bound".
 * Note: requiring the provider TEE proves genuine, round-bound provider hardware, not that
 * the seller node kept the buyer's data private (a non-TEE seller node still sees plaintext).
 */
const DEFAULT_REQUIRED_CAPS = [NODE_TEE_CAP_ID, SELLER_BOUND_ID]

/**
 * Buyer's required-cap set. Reads ANTSEED_VERIFIER_REQUIRED_CAPS (comma-separated), else the
 * default. An unknown or absent required cap never has a passing claim, so ok fails closed.
 */
export function readRequiredCaps(): string[] {
  const ids = (process.env['ANTSEED_VERIFIER_REQUIRED_CAPS'] ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean)
  return ids.length > 0 ? ids : DEFAULT_REQUIRED_CAPS
}
/** The TDX caps whose own evidence is DCAP-verified independently into a per-cap parse. */
const TDX_CAP_IDS = [NODE_TEE_CAP_ID, PROVIDER_TEE_CAP_ID]
/** Derived cap (no own evidence): always worth reporting; verifies the provider quote. */
const DERIVED_CAPS = [MEASURED_IMAGE_ID]
/** Which TDX parse each cap's verify consumes (TDX caps read their own; provider-derived caps the provider's). */
const PARSE_SOURCE: Record<string, string> = {
  [NODE_TEE_CAP_ID]: NODE_TEE_CAP_ID,
  [PROVIDER_TEE_CAP_ID]: PROVIDER_TEE_CAP_ID,
  [MEASURED_IMAGE_ID]: PROVIDER_TEE_CAP_ID,
  [PROVIDER_CLAIMS_CAP_ID]: PROVIDER_TEE_CAP_ID,
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Buyer measured-image policy: the approved-measurement allow-list, read from
 * ANTSEED_VERIFIER_MEASURED_IMAGE_POLICY — inline JSON, or "@/path/to/policy.json". Without it,
 * measured-image reports ok:false ("no approved measurement set configured"). A parse failure
 * disables the policy instead of throwing the whole verification round.
 */
export function readMeasuredImagePolicy(): MeasuredImagePolicy | undefined {
  const raw = process.env['ANTSEED_VERIFIER_MEASURED_IMAGE_POLICY']?.trim()
  if (!raw) return undefined
  try {
    const json = raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw
    return JSON.parse(json) as MeasuredImagePolicy
  } catch (err) {
    process.stderr.write(`[verifier] ignoring ANTSEED_VERIFIER_MEASURED_IMAGE_POLICY: ${msg(err)}\n`)
    return undefined
  }
}

/** When no evidence is available, fail every required cap with the same reason. */
function failAll(detail: string, requiredCaps: string[]): VerifyResult {
  return { ok: false, claims: requiredCaps.map((id) => ({ claim: claimId(id), ok: false, detail })) }
}

/** Core orchestration; the DCAP check is injectable for testing. */
export async function runVerify(
  ctx: VerifyContext,
  verifyQuote: VerifyQuoteFn = defaultVerifyQuote,
): Promise<VerifyResult> {
  const requiredCaps = readRequiredCaps()
  let peerId: string
  try {
    peerId = normalizePeerId(ctx.peerId)
  } catch (err) {
    return failAll(msg(err), requiredCaps)
  }

  const nonce = randomBytes(NONCE_BYTES)
  // Offer the whole menu; the seller returns evidence only for the caps its infra supports.
  const requested = capabilityIds()

  let resp
  try {
    resp = await ctx.fetchFromSeller({
      method: 'POST',
      path: ctx.attestPath,
      headers: { 'content-type': 'application/json' },
      body: encodeAttestRequest(nonce, requested),
    })
  } catch (err) {
    return failAll(`attestation request failed: ${msg(err)}`, requiredCaps)
  }

  if (resp.statusCode !== 200) {
    return failAll(`attestation service returned HTTP ${resp.statusCode}`, requiredCaps)
  }

  let evidence: Record<string, Uint8Array>
  try {
    evidence = decodeAttestResponse(resp.body)
  } catch (err) {
    return failAll(`malformed attestation response: ${msg(err)}`, requiredCaps)
  }

  // DCAP-verify each TDX cap's own evidence independently; share each parse with its dependents.
  const now = Math.floor(Date.now() / 1000)
  const parsedByCap = new Map<string, ParsedTdxQuote>()
  for (const id of TDX_CAP_IDS) {
    const ev = evidence[id]
    if (ev) parsedByCap.set(id, await verifyTdxEvidence(ev, verifyQuote, now))
  }

  // Verify the required caps, any cap the seller returned evidence for, and derived caps.
  const wanted = new Set([...requiredCaps, ...Object.keys(evidence), ...DERIVED_CAPS])
  const measuredImagePolicy = readMeasuredImagePolicy()
  const claims: ClaimResult[] = []
  for (const capId of capabilityIds()) {
    if (!wanted.has(capId)) continue
    const cap = getCapability(capId)
    if (!cap) continue
    const source = PARSE_SOURCE[capId]
    const parsed = source ? parsedByCap.get(source) : undefined
    const policy = capId === MEASURED_IMAGE_ID ? measuredImagePolicy : undefined
    try {
      const out = await cap.verify({ nonce, peerId, evidence: evidence[capId], parsedQuote: parsed, evidenceBundle: evidence, policy })
      claims.push(...(Array.isArray(out) ? out : [out]))
    } catch (err) {
      claims.push({ claim: claimId(capId), ok: false, detail: `verify threw: ${msg(err)}` })
    }
  }

  const ok = requiredCaps.every((id) => claims.some((c) => c.claim === claimId(id) && c.ok))
  return { ok, claims }
}

const verifierPlugin: AntseedVerifierPlugin = {
  type: 'verifier',
  name: VERIFIER_ID,
  displayName: 'TEE attestation verifier (Intel TDX / DCAP)',
  version: '0.1.0',
  description:
    'Capability-based seller attestation: one claim per capability. Requires the seller node\'s genuine Intel TDX hardware (seller-node-tee-genuine) and a seller-identity binding over the whole bundle (seller-bound); also reports the provider TEE (seller-provider-tee-genuine), measured-image and gpu-cc when available.',
  verify: (ctx) => runVerify(ctx),
}

export default verifierPlugin
