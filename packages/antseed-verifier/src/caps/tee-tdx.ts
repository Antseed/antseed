import type { ClaimResult } from '../antseed-node-types.js'
import type { Capability, CapabilityCollectInput, CapabilityVerifyInput } from '../capability.js'
import { claimId, computeReportData } from '../shared.js'
import { generateTdxQuote } from '../collect/configfs.js'
import { generateDstackQuote } from '../collect/dstack.js'
import { collectViaHttp, collectTdxAndPubkey } from '../collect/http.js'
import { antseedRdV1, verifyReportData, type BindingIngredients } from '../report-data.js'

/** A provider quote's declared report_data binding: a frozen scheme id + its string ingredients. */
export interface ReportDataBinding {
  scheme: string
  ingredients: Pick<BindingIngredients, 'peerId' | 'e2ePubkey' | 'keysetDigest'>
}

/**
 * A genuine-Intel-TDX capability: proves a party runs in a genuine Intel TDX enclave.
 * It DCAP-verifies the quote (ECDSA sig + PCK chain to Intel's root + TCB), requires an
 * acceptable TCB, requires a TDX (TD10) quote, and requires TDX debug off. It also parses
 * the authenticated measurements (MRTD, RTMR0-3, report_data) into a shared ParsedTdxQuote,
 * so dependent caps (measured-image) reuse the same verified quote instead of re-parsing
 * untrusted bytes.
 *
 * The one factory below (makeTdxCap) mints two instances. They differ only by id, collector
 * source, and evidence key: the AntSeed seller node's own TEE (configfs), and the downstream
 * inference provider's TEE (http). Same verify logic; independent evidence.
 */

/** The AntSeed seller node's own TEE (mints its quote locally via configfs). */
export const NODE_TEE_CAP_ID = 'seller-node-tee-genuine'
/** The downstream inference provider's TEE (quote fetched from the provider's evidence route). */
export const PROVIDER_TEE_CAP_ID = 'seller-provider-tee-genuine'

/**
 * Config-key convention: each TDX cap reads its own collector settings from `<capId>.<key>`
 * in the shared config map, so the node cap and the provider cap never collide. It lives in
 * one place, so the prover writes the same keys the factory reads.
 */
export function tdxConfigKey(id: string, key: string): string {
  return `${id}.${key}`
}

/**
 * TCB acceptance. UpToDate is always genuine hardware. SWHardeningNeeded flags guest-side
 * software mitigations only — not a hardware compromise — and is accepted by default (real
 * GCP TDX quotes often report it). Set ANTSEED_VERIFIER_STRICT_TCB=true to require UpToDate
 * exactly. Anything else (OutOfDate, Revoked, Unknown, ...) is rejected.
 */
export function isTcbAcceptable(status: string): boolean {
  if (status === 'UpToDate') return true
  if (status === 'SWHardeningNeeded') return process.env['ANTSEED_VERIFIER_STRICT_TCB'] !== 'true'
  return false
}

/** Authenticated TD10 measurements, extracted from a verified quote. */
export interface TdMeasurements {
  mrTd: Uint8Array
  rtMr0: Uint8Array
  rtMr1: Uint8Array
  rtMr2: Uint8Array
  rtMr3: Uint8Array
  reportData: Uint8Array
  /** TUD.DEBUG (tdAttributes bit 0); null if not determinable. */
  debug: boolean | null
}

/** Raw output of a DCAP check — status + measurements (td null when not a TDX quote). */
export interface RawTdxVerification {
  status: string
  td: TdMeasurements | null
}

/** Injectable DCAP check — the default verifies for real; tests inject a stub. */
export type VerifyQuoteFn = (
  quote: Uint8Array,
  collateral: unknown | undefined,
  nowSecs: number,
) => Promise<RawTdxVerification>

/**
 * The shared, verified quote given to every capability for this attestation round.
 * `quoteEvidence` is always the exact tee-tdx evidence bytes the seller returned (so
 * seller-bound can hash the same bytes). `td` is present only when DCAP parsing yields
 * a TDX report.
 */
export interface ParsedTdxQuote {
  quoteEvidence: Uint8Array
  status: string
  td: TdMeasurements | null
  /** The provider-declared report_data binding, if the evidence carried one. */
  binding?: ReportDataBinding
  /** Set when DCAP verification or evidence decoding threw. */
  error?: string
}

/** tee-tdx evidence blob: the raw quote (b64), optional DCAP collateral, optional binding. */
interface TeeTdxEvidence {
  quote: string
  collateral?: unknown
  binding?: ReportDataBinding
}

export function encodeTeeTdxEvidence(quote: Uint8Array, collateral?: unknown, binding?: ReportDataBinding): Uint8Array {
  const blob: TeeTdxEvidence = {
    quote: Buffer.from(quote).toString('base64'),
    ...(collateral !== undefined ? { collateral } : {}),
    ...(binding !== undefined ? { binding } : {}),
  }
  return new TextEncoder().encode(JSON.stringify(blob))
}

export function decodeTeeTdxEvidence(bytes: Uint8Array): { quote: Uint8Array; collateral?: unknown; binding?: ReportDataBinding } {
  const parsed = JSON.parse(new TextDecoder().decode(bytes)) as Partial<TeeTdxEvidence>
  if (typeof parsed.quote !== 'string' || parsed.quote.length === 0) {
    throw new Error('tee-tdx evidence missing "quote"')
  }
  const quote = new Uint8Array(Buffer.from(parsed.quote, 'base64'))
  if (quote.length === 0) {
    throw new Error('tee-tdx evidence "quote" is not valid base64')
  }
  return {
    quote,
    ...(parsed.collateral !== undefined ? { collateral: parsed.collateral } : {}),
    ...(parsed.binding !== undefined ? { binding: parsed.binding } : {}),
  }
}

/**
 * Default DCAP verifier: it validates the quote's ECDSA signature + PCK cert chain to
 * Intel's production root CA + TCB, and reads the TD10 measurements. It uses the seller's
 * collateral when supplied; otherwise it fetches collateral from a public PCCS. @phala/dcap-qvl
 * is imported lazily so the seller/prover half never loads it.
 */
export const defaultVerifyQuote: VerifyQuoteFn = async (quote, collateral, nowSecs) => {
  type Dcap = typeof import('@phala/dcap-qvl')
  const mod = (await import('@phala/dcap-qvl')) as Dcap & { default?: Dcap }
  const dcap = mod.default ?? mod
  const verified = collateral !== undefined
    ? dcap.verify(Buffer.from(quote), collateral as never, nowSecs)
    : await dcap.getCollateralAndVerify(Buffer.from(quote))
  const td = verified.report.asTd10()
  if (!td) return { status: verified.status, td: null }
  return {
    status: verified.status,
    td: {
      mrTd: td.mrTd,
      rtMr0: td.rtMr0,
      rtMr1: td.rtMr1,
      rtMr2: td.rtMr2,
      rtMr3: td.rtMr3,
      reportData: td.reportData,
      debug: td.tdAttributes.length > 0 ? (td.tdAttributes[0]! & 0x01) === 1 : null,
    },
  }
}

/**
 * DCAP-verify the tee-tdx evidence and build the shared ParsedTdxQuote. It never throws:
 * decode or verify errors are captured in `error`, so dependent caps still see the raw
 * `quoteEvidence` bytes (seller-bound only needs those to bind identity to the quote).
 */
export async function verifyTdxEvidence(
  evidence: Uint8Array,
  verifyQuote: VerifyQuoteFn,
  nowSecs: number,
): Promise<ParsedTdxQuote> {
  let quote: Uint8Array
  let collateral: unknown
  let binding: ReportDataBinding | undefined
  try {
    ;({ quote, collateral, binding } = decodeTeeTdxEvidence(evidence))
  } catch (err) {
    return { quoteEvidence: evidence, status: '', td: null, error: `malformed tee-tdx evidence: ${msg(err)}` }
  }
  try {
    const raw = await verifyQuote(quote, collateral, nowSecs)
    return { quoteEvidence: evidence, status: raw.status, td: raw.td, ...(binding ? { binding } : {}) }
  } catch (err) {
    return { quoteEvidence: evidence, status: '', td: null, ...(binding ? { binding } : {}), error: `quote verification failed: ${msg(err)}` }
  }
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function hex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex')
}

/**
 * Mint one TDX capability. `id` names the target (node or provider); `defaultSource`
 * is the collector used when config supplies no `<id>.source` override:
 *   'configfs': self-hosted TDX minted locally via configfs-tsm; report_data = antseed-rd-v1 {peerId}
 *   'dstack'  : self-hosted TDX minted via the dstack guest-agent socket (Phala CVMs, where
 *               configfs-tsm is absent); same antseed-rd-v1 {peerId} report_data as configfs
 *   'http'    : a pre-made quote fetched from a config-supplied evidence route ({nonce} hex)
 * verify reads this cap's own parsed quote (the orchestrator DCAP-verifies each cap's
 * own evidence entry independently). collect throws when its source is unavailable
 * (off-TEE for configfs, or no url for http), so the prover omits the cap.
 */
export function makeTdxCap(
  id: string,
  defaultSource: 'configfs' | 'http',
  opts?: { bindNoncePeerId?: boolean },
): Capability {
  return {
    id,

    verify(input: CapabilityVerifyInput): ClaimResult {
      const claim = claimId(id)
      if (!input.evidence) return { claim, ok: false, detail: 'seller returned no TDX quote' }
      const p = input.parsedQuote as ParsedTdxQuote | undefined
      if (!p) return { claim, ok: false, detail: 'TDX quote was not verified' }
      if (p.error) return { claim, ok: false, detail: p.error }
      if (!isTcbAcceptable(p.status)) return { claim, ok: false, detail: `TCB status not acceptable: ${p.status || 'unknown'}` }
      if (!p.td) return { claim, ok: false, detail: 'quote is not an Intel TDX quote' }
      if (p.td.debug === true) return { claim, ok: false, detail: 'TDX debug mode is enabled' }
      // Bind report_data to this round: the node cap to its {peerId} identity, a provider cap
      // to whatever frozen scheme its evidence declares. Fail-closed — a borrowed, relayed, or
      // stale quote cannot match a fresh-nonce commitment. A provider quote with no declared
      // scheme still passes on genuineness, but its detail must disclose that freshness was not proven.
      const binding: ReportDataBinding | undefined = opts?.bindNoncePeerId
        ? { scheme: antseedRdV1.id, ingredients: { peerId: input.peerId } }
        : p.binding
      if (binding) {
        const bad = verifyReportData(binding.scheme, p.td.reportData, input.nonce, binding.ingredients)
        if (bad) return { claim, ok: false, detail: bad }
      }
      const freshness = binding
        ? `bound to this round (${binding.scheme})`
        : 'freshness/instance binding NOT verified (no report_data scheme declared)'
      return {
        claim,
        ok: true,
        detail: `genuine Intel TDX quote (TCB ${p.status}); MRTD ${hex(p.td.mrTd).slice(0, 16)}…; ${freshness}`,
      }
    },

    async collect(input: CapabilityCollectInput): Promise<Uint8Array> {
      const source = input.config[tdxConfigKey(id, 'source')] ?? defaultSource
      if (source === 'configfs') {
        const quote = generateTdxQuote(computeReportData(input.nonce, input.peerId))
        return encodeTeeTdxEvidence(quote)
      }
      if (source === 'dstack') {
        const socket = input.config[tdxConfigKey(id, 'dstack.socket')] || undefined
        const quote = await generateDstackQuote(computeReportData(input.nonce, input.peerId), socket)
        return encodeTeeTdxEvidence(quote)
      }
      if (source === 'http') {
        const url = input.config[tdxConfigKey(id, 'url')]
        if (!url) throw new Error(`${id} http source requires an evidence url; not offered`)
        const field = input.config[tdxConfigKey(id, 'field')] ?? 'quote'
        const scheme = input.config[tdxConfigKey(id, 'binding.scheme')]
        if (!scheme) {
          return encodeTeeTdxEvidence(await collectViaHttp(url, input.nonce, field))
        }
        // Declare the provider's frozen report_data scheme and its ingredients (e.g. the E2E
        // pubkey) so the buyer can verify the quote is bound to this round. Both come from one
        // fetch, so the quote and the pubkey are from the same response (no cross-fetch skew).
        const pubkeyField = input.config[tdxConfigKey(id, 'binding.pubkeyField')]
        const { quote, pubkey } = await collectTdxAndPubkey(url, input.nonce, field, pubkeyField)
        const ingredients = pubkey ? { e2ePubkey: pubkey } : {}
        return encodeTeeTdxEvidence(quote, undefined, { scheme, ingredients })
      }
      throw new Error(`unknown ${id} source "${source}" (expected "configfs", "dstack", or "http")`)
    },
  }
}

/** The AntSeed seller node's own TEE — mints its quote locally via configfs; report_data bound to nonce+peerId. */
export const nodeTeeCapability = makeTdxCap(NODE_TEE_CAP_ID, 'configfs', { bindNoncePeerId: true })
/** The downstream inference provider's TEE — quote fetched from the provider's evidence route. */
export const providerTeeCapability = makeTdxCap(PROVIDER_TEE_CAP_ID, 'http')
