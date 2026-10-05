import { createHash } from 'node:crypto'
import type { ClaimResult } from '../antseed-node-types.js'
import type { Capability, CapabilityCollectInput, CapabilityVerifyInput } from '../capability.js'
import { claimId } from '../shared.js'
import { collectViaHttp } from '../collect/http.js'
import { isTcbAcceptable, type ParsedTdxQuote } from './tee-tdx.js'

/**
 * Capability 'seller-provider-claims': carries the inference provider's claims into the
 * protocol with per-claim granularity — one ClaimResult per claim, namespaced
 * '<verifier>:seller-provider-claims/<name>'. The claims menu is frozen in the SDK
 * (PROVIDER_CLAIMS_MENU below), never supplied by the seller or provider; the provider's
 * document supplies values only ({ "<name>": <value> }).
 *
 * Frozen proof levels:
 *   'asserted'  the claim may pass on bundle integrity alone: the document rides in the
 *               evidence bundle that seller-bound signs (freshness + seller identity).
 *   'tdx-quote' the claim passes only when the provider's TDX quote (verified this round
 *               with DCAP as seller-provider-tee-genuine) commits to this exact document
 *               and nonce in its report_data (see claimsReportData). The provider's TEE
 *               then attests the claim; it is not merely asserted.
 * When the quote binding holds, asserted-level claims are reported TEE-attested too.
 *
 * The document is provider-authored bytes carried verbatim (base64 field on the same
 * config-driven evidence route as the provider quote). The binding hashes the exact
 * bytes, so no re-encoding is allowed anywhere. No provider specifics live here.
 */

export const PROVIDER_CLAIMS_CAP_ID = 'seller-provider-claims'

/** Config-key convention for this cap's collector; mirrors tdxConfigKey. */
export function claimsConfigKey(key: string): string {
  return `${PROVIDER_CLAIMS_CAP_ID}.${key}`
}

/**
 * Provider quote report_data layout for TEE-attested claims:
 *
 *   report_data[ 0:32] = SHA-256( DOMAIN ‖ nonce(32) ‖ SHA-256(claimsDocBytes) )
 *   report_data[32:64] = reserved   // gpu-cc binds the GPU via the NRAS nonce, not this half
 *
 * `claimsReportData` returns the 32-byte [0:32] commitment; the verifier compares it against
 * the provider quote's first half.
 */
export const PROVIDER_REPORT_DATA_DOMAIN = 'antseed-provider-report-data-v1'

export function claimsReportData(nonce: Uint8Array, docBytes: Uint8Array): Uint8Array {
  const docHash = createHash('sha256').update(Buffer.from(docBytes)).digest()
  const h = createHash('sha256')
  h.update(Buffer.from(PROVIDER_REPORT_DATA_DOMAIN, 'utf8'))
  h.update(Buffer.from(nonce))
  h.update(docHash)
  return new Uint8Array(h.digest())
}

/** One frozen menu entry: what the claim means, how its value must look, what proves it. */
export interface ProviderClaimDefinition {
  /** Human meaning of the claim, frozen with its verification semantics. */
  description: string
  /** Minimum proof required to pass: 'asserted' (bundle-bound) or 'tdx-quote' (TEE-bound). */
  proof: 'asserted' | 'tdx-quote'
  /** Frozen value check; returns a failure reason, or null when the value is acceptable. */
  validate(value: unknown): string | null
}

/**
 * The frozen claims menu for this SDK version. Buyers verify only against these
 * definitions; a document name outside this menu can never pass. Add entries only with
 * an SDK version bump (the CLI trust registry pins the exact version network-wide).
 */
export const PROVIDER_CLAIMS_MENU: Record<string, ProviderClaimDefinition> = {
  'model-id': {
    description: 'the model identifier this provider serves for the routed requests',
    proof: 'asserted',
    validate: (v) =>
      typeof v === 'string' && v.length > 0 && v.length <= 200
        ? null
        : 'expected a non-empty string (max 200 chars)',
  },
  'serving-image-digest': {
    description: 'digest of the serving-stack image handling requests inside the provider TEE',
    proof: 'tdx-quote',
    validate: (v) =>
      typeof v === 'string' && /^sha256:[0-9a-f]{64}$/.test(v)
        ? null
        : 'expected "sha256:<64 lowercase hex>"',
  },
}

/** Claim names become protocol claim-id path segments; keep them id-safe and bounded. */
const CLAIM_NAME_RE = /^[a-z0-9][a-z0-9.-]{0,63}$/
/** Hard bound on claims per document, so a provider cannot flood the buyer's report. */
const MAX_CLAIMS = 64
/** Hard bound on the claims document size before JSON.parse (a hostile seller must not force an unbounded parse). */
const MAX_DOC_BYTES = 64 * 1024

/** Parse + validate a claims document envelope. Throws with a doc-level reason. */
function parseClaimsDoc(bytes: Uint8Array): Map<string, unknown> {
  if (bytes.length > MAX_DOC_BYTES) {
    throw new Error(`claims document exceeds ${MAX_DOC_BYTES} bytes (${bytes.length})`)
  }
  let root: unknown
  try {
    root = JSON.parse(new TextDecoder().decode(bytes))
  } catch (err) {
    throw new Error(`malformed claims document: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (root === null || typeof root !== 'object' || Array.isArray(root)) {
    throw new Error('malformed claims document: not a JSON object')
  }
  const { version, claims } = root as { version?: unknown; claims?: unknown }
  if (version !== undefined && version !== 1) {
    throw new Error(`unsupported claims document version ${JSON.stringify(version)} (expected 1)`)
  }
  if (claims === null || typeof claims !== 'object' || Array.isArray(claims)) {
    throw new Error('malformed claims document: "claims" is not an object')
  }
  const entries = Object.entries(claims as Record<string, unknown>)
  if (entries.length === 0) throw new Error('claims document declares no claims')
  if (entries.length > MAX_CLAIMS) {
    throw new Error(`claims document has too many claims (${entries.length} > ${MAX_CLAIMS})`)
  }
  for (const [name] of entries) {
    if (!CLAIM_NAME_RE.test(name)) {
      throw new Error(`invalid claim name "${name}": use lowercase letters, digits, hyphen or dot (max 64 chars)`)
    }
  }
  return new Map(entries)
}

/** Compact human summary of a claim's value for ClaimResult.detail. */
function summarize(value: unknown): string {
  const s = JSON.stringify(value) ?? 'undefined'
  return s.length > 80 ? `${s.slice(0, 77)}…` : s
}

/**
 * One binding verdict per document: is the provider quote genuine and committed to these
 * exact document bytes? Every claim in the document shares it.
 */
function quoteBinding(
  p: ParsedTdxQuote | undefined,
  nonce: Uint8Array,
  docBytes: Uint8Array,
): string | null {
  if (!p) return 'no verified provider TDX quote in this round (this claim requires seller-provider-tee-genuine evidence)'
  if (p.error) return p.error
  if (!isTcbAcceptable(p.status)) return `provider TCB status not acceptable: ${p.status || 'unknown'}`
  if (!p.td) return 'provider quote is not an Intel TDX quote'
  if (p.td.debug === true) return 'provider TDX debug mode is enabled'
  // Compare the canonical [0:32] commitment; [32:64] is reserved (gpu-cc binds via NRAS).
  const expected = claimsReportData(nonce, docBytes)
  const rd = p.td.reportData
  if (rd.length < 32 || !Buffer.from(rd.subarray(0, 32)).equals(Buffer.from(expected))) {
    return 'provider quote report_data does not commit to this claims document'
  }
  return null
}

export const providerClaimsCapability: Capability = {
  id: PROVIDER_CLAIMS_CAP_ID,

  verify(input: CapabilityVerifyInput): ClaimResult[] {
    const parent = claimId(PROVIDER_CLAIMS_CAP_ID)
    if (!input.evidence) {
      return [{ claim: parent, ok: false, detail: 'seller returned no claims document' }]
    }
    let values: Map<string, unknown>
    try {
      values = parseClaimsDoc(input.evidence)
    } catch (err) {
      return [{ claim: parent, ok: false, detail: err instanceof Error ? err.message : String(err) }]
    }
    // Bind once per document; every claim shares the verdict.
    const p = input.parsedQuote as ParsedTdxQuote | undefined
    const bindingFailure = quoteBinding(p, input.nonce, input.evidence)

    const results: ClaimResult[] = []
    for (const [name, value] of values) {
      const claim = `${parent}/${name}`
      const def = PROVIDER_CLAIMS_MENU[name]
      if (!def) {
        results.push({ claim, ok: false, detail: `unknown claim "${name}": not in this SDK version's frozen claims menu` })
        continue
      }
      const invalid = def.validate(value)
      if (invalid) {
        results.push({ claim, ok: false, detail: `invalid value: ${invalid}` })
        continue
      }
      if (def.proof === 'tdx-quote' && bindingFailure) {
        results.push({ claim, ok: false, detail: bindingFailure })
        continue
      }
      // An asserted-level pass is a signed self-assertion, not an independent measurement.
      // Label it so buyer UIs and policy cannot render it as "verified".
      results.push({
        claim,
        ok: true,
        detail: bindingFailure
          ? `provider-asserted only, NOT independently verified: ${summarize(value)}`
          : `attested by provider TEE (report_data-bound TDX quote): ${summarize(value)}`,
      })
    }
    return results
  },

  async collect(input: CapabilityCollectInput): Promise<Uint8Array> {
    const url = input.config[claimsConfigKey('url')]
    const field = input.config[claimsConfigKey('field')]
    if (!url || !field) {
      throw new Error(`${PROVIDER_CLAIMS_CAP_ID} requires an evidence url and a claims field; not offered`)
    }
    // collectViaHttp base64-decodes the field — the document bytes arrive verbatim, which
    // the tdx-quote binding depends on (report_data hashes the exact bytes).
    return collectViaHttp(url, input.nonce, field)
  },
}
