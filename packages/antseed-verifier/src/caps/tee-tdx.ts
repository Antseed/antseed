import type { ClaimResult } from '../antseed-node-types.js'
import type { Capability, CapabilityCollectInput, CapabilityVerifyInput, VerifyRound } from '../capability.js'
import { claimId, computeReportData } from '../shared.js'
import { generateTdxQuote } from '../collect/configfs.js'
import { generateDstackAttestation } from '../collect/dstack.js'
import { composeHashFromEventLog, parseDstackEventLog, rtmr3Events, type DstackEvent } from '../dstack-event-log.js'
import { collectViaHttp, collectTdxAndPubkey } from '../collect/http.js'
import { antseedRdV1, verifyReportData, type BindingIngredients } from '../report-data.js'
import type { ApprovedDstackOs, ApprovedNodeBuilds } from '../approved-node-measurements.js'
import { verifyTdxLiteOs } from '../dstack-lite-os.js'
import { checkAppCompose, type CheckedAppCompose } from '../dstack-app-compose.js'
import type { JWTPayload } from 'jose'
import {
  checkConfidentialSpaceClaims,
  confidentialSpaceNonce,
  defaultVerifyConfidentialSpaceToken,
  type VerifyConfidentialSpaceTokenFn,
} from '../confidential-space.js'
import { isTcbAcceptable } from '../tcb-policy.js'
import { generateConfidentialSpaceToken } from '../collect/confidential-space.js'
import { REVOKED_SELLER_IMAGES, type ApprovedSellerImage } from '../approved-seller-images.js'
import type { SellerUpstream } from '../seller-config-rules.js'
import { composeImageDigest, imageBuildRecord, tokenImageDigest, verifyImageBuild } from '../image-provenance.js'

/** A provider quote's declared report_data binding: a frozen scheme id + its string ingredients. */
export interface ReportDataBinding {
  scheme: string
  ingredients: Pick<BindingIngredients, 'peerId' | 'e2ePubkey' | 'keysetDigest' | 'channelBinding'>
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
 * source, and evidence key: the Antseed seller node's own TEE (configfs), and the downstream
 * inference provider's TEE (http). Same verify logic; independent evidence.
 */

/** The Antseed seller node's own TEE (mints its quote locally via configfs). */
export const NODE_TEE_CAP_ID = 'seller-node-tee-genuine'
/** The downstream inference provider's TEE (quote fetched from the provider's evidence route). */
export const PROVIDER_TEE_CAP_ID = 'seller-provider-tee-genuine'
/**
 * Reported with a passing seller node claim: the https origins its measured config forwards
 * prompts to, comma-separated. It describes the node claim and has no evidence of its own.
 */
export const NODE_UPSTREAMS_CLAIM = 'seller-node-upstreams'

/**
 * Config-key convention: each TDX cap reads its own collector settings from `<capId>.<key>`
 * in the shared config map, so the node cap and the provider cap never collide. It lives in
 * one place, so the prover writes the same keys the factory reads.
 */
export function tdxConfigKey(id: string, key: string): string {
  return `${id}.${key}`
}

export { isTcbAcceptable } from '../tcb-policy.js'

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
  /** dstack RTMR3 event log, if the evidence carried one. */
  eventLog?: DstackEvent[]
  /** Full GetQuote event log string, if the evidence carried one. */
  rawEventLog?: string
  /** GetQuote vm_config string, if the evidence carried one. */
  vmConfig?: string
  /** dstack app-compose.json, if the evidence carried one. */
  appCompose?: string
  /** Claims of a verified Google Confidential Space token, when the evidence was one instead of a quote. */
  confidentialSpace?: JWTPayload
  /** The seller images the evidence's verified build record approves (image-provenance.ts). */
  builtImages?: ApprovedSellerImage[]
  /** Why the evidence's build record approves no image, when it carried one. */
  imageBuildError?: string
  /** Provider evidence: the https origin the seller fetched it from (TeeTdxEvidence.origin). */
  origin?: string
  /** Set when DCAP or token verification, or evidence decoding, threw. */
  error?: string
}

/**
 * Node evidence from Google Confidential Space: Google's signed attestation token in place of a
 * quote, and the image's build record when the seller has it.
 */
export function encodeConfidentialSpaceEvidence(token: string, imageBuild?: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify({ confidentialSpaceToken: token, ...(imageBuild !== undefined ? { imageBuild } : {}) }))
}

/**
 * tee-tdx evidence blob: the raw quote (b64), optional DCAP collateral and binding, and on dstack
 * the RTMR3 event log, app-compose.json and the image's build record.
 */
interface TeeTdxEvidence {
  quote: string
  collateral?: unknown
  binding?: ReportDataBinding
  eventLog?: DstackEvent[]
  rawEventLog?: string
  vmConfig?: string
  appCompose?: string
  imageBuild?: unknown
  /**
   * Provider evidence: the https origin the seller's prover fetched it from, without following
   * redirects. Only the prover writes it, so a buyer relies on it only when the seller node is
   * attested on the same connection. Provers before verifier 0.1.6 leave it out.
   */
  origin?: string
}

export function encodeTeeTdxEvidence(
  quote: Uint8Array,
  collateral?: unknown,
  binding?: ReportDataBinding,
  extra?: { eventLog?: DstackEvent[]; rawEventLog?: string; vmConfig?: string; appCompose?: string; imageBuild?: unknown; origin?: string },
): Uint8Array {
  const blob: TeeTdxEvidence = {
    quote: Buffer.from(quote).toString('base64'),
    ...(collateral !== undefined ? { collateral } : {}),
    ...(binding !== undefined ? { binding } : {}),
    ...(extra?.eventLog !== undefined ? { eventLog: extra.eventLog } : {}),
    ...(extra?.rawEventLog !== undefined ? { rawEventLog: extra.rawEventLog } : {}),
    ...(extra?.vmConfig !== undefined ? { vmConfig: extra.vmConfig } : {}),
    ...(extra?.appCompose !== undefined ? { appCompose: extra.appCompose } : {}),
    ...(extra?.imageBuild !== undefined ? { imageBuild: extra.imageBuild } : {}),
    ...(extra?.origin !== undefined ? { origin: extra.origin } : {}),
  }
  return new TextEncoder().encode(JSON.stringify(blob))
}

export function decodeTeeTdxEvidence(bytes: Uint8Array): Omit<TeeTdxEvidence, 'quote'> & { quote: Uint8Array } {
  return decodeTeeTdxEnvelope(JSON.parse(new TextDecoder().decode(bytes)))
}

/** Validate a parsed tee-tdx evidence envelope. */
function decodeTeeTdxEnvelope(envelope: unknown): Omit<TeeTdxEvidence, 'quote'> & { quote: Uint8Array } {
  if (!envelope || typeof envelope !== 'object') throw new Error('tee-tdx evidence is not an object')
  const parsed = envelope as Partial<TeeTdxEvidence>
  if (typeof parsed.quote !== 'string' || parsed.quote.length === 0) {
    throw new Error('tee-tdx evidence missing "quote"')
  }
  const quote = new Uint8Array(Buffer.from(parsed.quote, 'base64'))
  if (quote.length === 0) {
    throw new Error('tee-tdx evidence "quote" is not valid base64')
  }
  let eventLog: DstackEvent[] | undefined
  if (parsed.eventLog !== undefined) {
    try {
      if (!Array.isArray(parsed.eventLog)) throw new Error('not an array')
      eventLog = parseDstackEventLog(parsed.eventLog)
    } catch {
      throw new Error('tee-tdx evidence "eventLog" is not a dstack event log')
    }
  }
  if (parsed.rawEventLog !== undefined && typeof parsed.rawEventLog !== 'string') {
    throw new Error('tee-tdx evidence "rawEventLog" is not a string')
  }
  if (parsed.vmConfig !== undefined && typeof parsed.vmConfig !== 'string') {
    throw new Error('tee-tdx evidence "vmConfig" is not a string')
  }
  if (parsed.appCompose !== undefined && typeof parsed.appCompose !== 'string') {
    throw new Error('tee-tdx evidence "appCompose" is not a string')
  }
  if (parsed.origin !== undefined && typeof parsed.origin !== 'string') {
    throw new Error('tee-tdx evidence "origin" is not a string')
  }
  return {
    quote,
    ...(parsed.collateral !== undefined ? { collateral: parsed.collateral } : {}),
    ...(parsed.binding !== undefined ? { binding: parsed.binding } : {}),
    ...(eventLog !== undefined ? { eventLog } : {}),
    ...(parsed.rawEventLog !== undefined ? { rawEventLog: parsed.rawEventLog } : {}),
    ...(parsed.vmConfig !== undefined ? { vmConfig: parsed.vmConfig } : {}),
    ...(parsed.appCompose !== undefined ? { appCompose: parsed.appCompose } : {}),
    ...(parsed.imageBuild !== undefined ? { imageBuild: parsed.imageBuild } : {}),
    ...(parsed.origin !== undefined ? { origin: parsed.origin } : {}),
  }
}

/** Verify the evidence's image build record, if any, into the images it approves or why it approves none. */
async function verifiedImageBuild(record: unknown): Promise<Pick<ParsedTdxQuote, 'builtImages' | 'imageBuildError'>> {
  if (record === undefined) return {}
  const out = await verifyImageBuild(record)
  return 'error' in out ? { imageBuildError: out.error } : { builtImages: out.images }
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
  verifyConfidentialSpaceToken: VerifyConfidentialSpaceTokenFn = defaultVerifyConfidentialSpaceToken,
): Promise<ParsedTdxQuote> {
  let envelope: unknown
  try {
    envelope = JSON.parse(new TextDecoder().decode(evidence))
  } catch (err) {
    return { quoteEvidence: evidence, status: '', td: null, error: `malformed tee-tdx evidence: ${msg(err)}` }
  }
  const fields = envelope && typeof envelope === 'object' ? (envelope as { confidentialSpaceToken?: unknown; imageBuild?: unknown }) : {}
  const token = fields.confidentialSpaceToken
  if (typeof token === 'string') {
    try {
      const confidentialSpace = await verifyConfidentialSpaceToken(token)
      return { quoteEvidence: evidence, status: '', td: null, confidentialSpace, ...(await verifiedImageBuild(fields.imageBuild)) }
    } catch (err) {
      return { quoteEvidence: evidence, status: '', td: null, error: `Confidential Space token verification failed: ${msg(err)}` }
    }
  }
  let quote: Uint8Array
  let collateral: unknown
  let binding: ReportDataBinding | undefined
  let eventLog: DstackEvent[] | undefined
  let appCompose: string | undefined
  let rawEventLog: string | undefined
  let vmConfig: string | undefined
  let imageBuild: unknown
  let origin: string | undefined
  try {
    ;({ quote, collateral, binding, eventLog, appCompose, rawEventLog, vmConfig, imageBuild, origin } = decodeTeeTdxEnvelope(envelope))
  } catch (err) {
    return { quoteEvidence: evidence, status: '', td: null, error: `malformed tee-tdx evidence: ${msg(err)}` }
  }
  try {
    const raw = await verifyQuote(quote, collateral, nowSecs)
    return {
      quoteEvidence: evidence, status: raw.status, td: raw.td,
      ...(binding ? { binding } : {}), ...(eventLog !== undefined ? { eventLog } : {}), ...(appCompose !== undefined ? { appCompose } : {}),
      ...(rawEventLog !== undefined ? { rawEventLog } : {}), ...(vmConfig !== undefined ? { vmConfig } : {}),
      ...(origin !== undefined ? { origin } : {}), ...(await verifiedImageBuild(imageBuild)),
    }
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
 * The seller images this round accepts: the approved list (with any local additions) and the
 * images the seller's verified build record approves, less revoked ones.
 */
function acceptedImages(policy: ApprovedNodeBuilds | undefined, p: ParsedTdxQuote): ApprovedSellerImage[] {
  return [...(policy?.images ?? []), ...(p.builtImages ?? [])].filter((i) => !REVOKED_SELLER_IMAGES.includes(i.digest))
}

/** A failed image check, with why the seller's build record (if it sent one) approved nothing. */
function withBuildRecord(error: string, p: ParsedTdxQuote): string {
  return p.imageBuildError ? `${error} (${p.imageBuildError})` : error
}

/**
 * Approve the CVM OS: an exact (MRTD, RTMR0-2) match in the measurement table, or a local lite
 * check of the seller's GetQuote vm_config and full event log against this quote's measurements
 * that returns an approved OS image hash. The table path does not need the lite verifier.
 */
function approvedOs(
  approved: Pick<ApprovedNodeBuilds, 'os' | 'osImages'>,
  td: TdMeasurements,
  rawEventLog: string | undefined,
  vmConfig: string | undefined,
): { os: ApprovedDstackOs } | { error: string } {
  const base = [td.mrTd, td.rtMr0, td.rtMr1, td.rtMr2].map(hex)
  const os = (approved.os ?? []).find((m) => [m.mrtd, m.rtmr0, m.rtmr1, m.rtmr2].every((v, i) => v.toLowerCase() === base[i]))
  if (os) return { os }
  if (!rawEventLog || !vmConfig) {
    return { error: `the CVM OS (MRTD ${base[0]!.slice(0, 16)}…) is not an approved dstack release` }
  }
  const lite = verifyTdxLiteOs({ mrtd: base[0]!, rtmr0: base[1]!, rtmr1: base[2]!, rtmr2: base[3]!, eventLog: rawEventLog, vmConfig })
  if (!lite.ok) return { error: `dstack lite OS check failed${lite.reason ? `: ${lite.reason}` : ''}` }
  const hash = lite.osImageHash?.toLowerCase()
  const image = typeof hash === 'string' ? (approved.osImages ?? []).find((item) => item.hash === hash) : undefined
  if (!image) return { error: 'the CVM OS image hash is not an approved dstack release' }
  return { os: { name: image.name, mrtd: base[0]!, rtmr0: base[1]!, rtmr1: base[2]!, rtmr2: base[3]! } }
}

/**
 * The approved build this quote runs: MRTD and RTMR0-2 must be an approved dstack OS, and the app
 * compose measured into RTMR3 (replayed from the event log) must run an approved seller image under
 * the compose rules. Returns the OS, image and upstreams, or why the build is not approved.
 */
function approvedBuild(
  approved: Pick<ApprovedNodeBuilds, 'os' | 'osImages'>,
  images: readonly ApprovedSellerImage[],
  td: TdMeasurements,
  eventLog: DstackEvent[] | undefined,
  appCompose: string | undefined,
  rawEventLog: string | undefined,
  vmConfig: string | undefined,
): ({ os: ApprovedDstackOs } & CheckedAppCompose) | { error: string } {
  const os = approvedOs(approved, td, rawEventLog, vmConfig)
  if ('error' in os) return os
  if (eventLog === undefined) return { error: 'seller sent no dstack event log' }
  const replay = composeHashFromEventLog(eventLog, td.rtMr3)
  if ('error' in replay) return replay
  if (appCompose === undefined) return { error: 'seller sent no app compose' }
  const app = checkAppCompose(appCompose, replay.composeHash, images)
  return 'error' in app ? app : { os: os.os, ...app }
}

/** Record a verified seller node for the caps verified after it; returns its upstream origins. */
function recordSellerNode(input: CapabilityVerifyInput, checked: { upstreams: SellerUpstream[] }): string[] {
  const upstreams = [...new Set(checked.upstreams.map((u) => u.origin))].sort()
  if (input.round) input.round.sellerNode = { upstreams }
  return upstreams
}

/**
 * A provider quote counts for a verified seller node only when that provider is where the node
 * sends prompts: its config names one upstream origin, and the node's prover fetched the quote
 * from that origin (the evidence's origin, which only the attested image writes). Otherwise the
 * quote attests some other machine, and the buyer's prompts may reach an upstream no quote
 * covers. Returns why the quote doesn't count, if it doesn't.
 */
function unattestedUpstreams(node: VerifyRound['sellerNode'], origin: string | undefined): string | undefined {
  if (!node) return undefined
  const [upstream, ...more] = node.upstreams
  if (upstream && more.length === 0 && origin === upstream) return undefined
  const from = origin ? `fetched from ${origin}` : 'its origin not reported; the seller image predates verifier 0.1.6'
  return `this seller sends prompts to ${node.upstreams.join(', ')}, not only to the attested provider (evidence ${from})`
}

/** The node claim (and its upstreams) for Google Confidential Space evidence: a verified token, checked for this round. */
function verifyConfidentialSpaceNode(claim: string, input: CapabilityVerifyInput, p: ParsedTdxQuote, claims: JWTPayload): ClaimResult | ClaimResult[] {
  const channelBinding = input.channelBinding
  if (!channelBinding) {
    return { claim, ok: false, detail: 'no connection binding: TEE attestation needs an encrypted TCP connection to the seller' }
  }
  // The token's nonce commits to this round's antseed-rd-v1 report data, connection included.
  const nonce = confidentialSpaceNonce(computeReportData(input.nonce, input.peerId, channelBinding))
  const checked = checkConfidentialSpaceClaims(claims, nonce, acceptedImages(input.policy as ApprovedNodeBuilds | undefined, p))
  if ('error' in checked) {
    return { claim, ok: false, detail: `Google Confidential Space attestation, but not an approved TEE seller build: ${withBuildRecord(checked.error, p)}` }
  }
  const origins = recordSellerNode(input, checked)
  return [
    { claim, ok: true, detail: `Intel TDX on Google Confidential Space (attested by Google); Antseed TEE seller image ${checked.image.version}, bound to this connection; bound to this round (${antseedRdV1.id})` },
    { claim: claimId(NODE_UPSTREAMS_CLAIM), ok: true, detail: origins.join(', ') },
  ]
}

/**
 * Mint one TDX capability. `id` names the target (node or provider); `defaultSource`
 * is the collector used when config supplies no `<id>.source` override:
 *   'configfs': self-hosted TDX minted locally via configfs-tsm; report_data = antseed-rd-v1
 *               {peerId, channelBinding} for seller-node attestations
 *   'dstack'  : self-hosted TDX minted via the dstack guest-agent socket (Phala CVMs, where
 *               configfs-tsm is absent); the same binding, plus the event log and app compose
 *   'http'    : a pre-made quote fetched from a config-supplied evidence route ({nonce} hex)
 * verify reads this cap's own parsed quote (the orchestrator DCAP-verifies each cap's
 * own evidence entry independently). collect throws when its source is unavailable
 * (off-TEE for configfs, or no url for http), so the prover omits the cap.
 */
export function makeTdxCap(
  id: string,
  defaultSource: 'configfs' | 'http',
  opts?: { sellerNode?: boolean },
): Capability {
  return {
    id,

    verify(input: CapabilityVerifyInput): ClaimResult | ClaimResult[] {
      const claim = claimId(id)
      if (!input.evidence) return { claim, ok: false, detail: 'seller returned no TDX quote' }
      const p = input.parsedQuote as ParsedTdxQuote | undefined
      if (!p) return { claim, ok: false, detail: 'TDX quote was not verified' }
      if (p.error) return { claim, ok: false, detail: p.error }
      if (p.confidentialSpace) {
        if (!opts?.sellerNode) return { claim, ok: false, detail: 'a Confidential Space token is only accepted for the seller node' }
        return verifyConfidentialSpaceNode(claim, input, p, p.confidentialSpace)
      }
      if (!isTcbAcceptable(p.status)) return { claim, ok: false, detail: `TCB status not acceptable: ${p.status || 'unknown'}` }
      if (!p.td) return { claim, ok: false, detail: 'quote is not an Intel TDX quote' }
      if (p.td.debug === true) return { claim, ok: false, detail: 'TDX debug mode is enabled' }
      // The seller node must also run an approved build and answer on the buyer's own connection:
      // the quote commits to that connection's session hash, so it was minted by the approved
      // build terminating this connection, not relayed from another machine.
      let build: ({ os: ApprovedDstackOs } & CheckedAppCompose) | undefined
      const channelBinding = input.channelBinding
      if (opts?.sellerNode) {
        if (!channelBinding) {
          return { claim, ok: false, detail: 'no connection binding: TEE attestation needs an encrypted TCP connection to the seller' }
        }
        const policy = input.policy as ApprovedNodeBuilds | undefined
        const match = approvedBuild(policy ?? { os: [], osImages: [] }, acceptedImages(policy, p), p.td, p.eventLog, p.appCompose, p.rawEventLog, p.vmConfig)
        if ('error' in match) {
          return { claim, ok: false, detail: `genuine Intel TDX hardware, but not an approved TEE seller build: ${withBuildRecord(match.error, p)}` }
        }
        build = match
      }
      // Bind report_data to this round: the node cap to its {peerId, channelBinding}, a provider
      // cap to whatever frozen scheme its evidence declares. Fail-closed — a borrowed, relayed, or
      // stale quote cannot match a fresh-nonce commitment. A provider quote with no declared
      // scheme still passes on genuineness, but its detail must disclose that freshness was not proven.
      const binding: ReportDataBinding | undefined = opts?.sellerNode
        ? { scheme: antseedRdV1.id, ingredients: { peerId: input.peerId, ...(channelBinding ? { channelBinding } : {}) } }
        : p.binding
      if (binding) {
        const bad = verifyReportData(binding.scheme, p.td.reportData, input.nonce, binding.ingredients)
        if (bad) return { claim, ok: false, detail: bad }
      }
      const freshness = binding
        ? `bound to this round (${binding.scheme})`
        : 'freshness/instance binding NOT verified (no report_data scheme declared)'
      const scope = build
        ? `Antseed TEE seller image ${build.image.version} on ${build.os.name}, bound to this connection`
        : `MRTD ${hex(p.td.mrTd).slice(0, 16)}…`
      const result: ClaimResult = { claim, ok: true, detail: `genuine Intel TDX quote (TCB ${p.status}); ${scope}; ${freshness}` }
      if (!build) {
        const notUpstream = opts?.sellerNode ? undefined : unattestedUpstreams(input.round?.sellerNode, p.origin)
        return notUpstream ? { claim, ok: false, detail: `genuine Intel TDX quote (TCB ${p.status}), but ${notUpstream}` } : result
      }
      const origins = recordSellerNode(input, build)
      return [result, { claim: claimId(NODE_UPSTREAMS_CLAIM), ok: true, detail: origins.join(', ') }]
    },

    async collect(input: CapabilityCollectInput): Promise<Uint8Array> {
      const source = input.config[tdxConfigKey(id, 'source')] ?? defaultSource
      const channelBinding = input.config[tdxConfigKey(id, 'channelBinding')] || undefined
      if (source === 'configfs') {
        const quote = generateTdxQuote(computeReportData(input.nonce, input.peerId, channelBinding))
        return encodeTeeTdxEvidence(quote)
      }
      if (source === 'confidential-space') {
        const socket = input.config[tdxConfigKey(id, 'confidentialSpace.socket')] || undefined
        const nonce = confidentialSpaceNonce(computeReportData(input.nonce, input.peerId, channelBinding))
        const token = await generateConfidentialSpaceToken(nonce, socket)
        return encodeConfidentialSpaceEvidence(token, await imageBuildRecord(tokenImageDigest(token)))
      }
      if (source === 'dstack') {
        const socket = input.config[tdxConfigKey(id, 'dstack.socket')] || undefined
        const { quote, eventLog, vmConfig, appCompose } = await generateDstackAttestation(computeReportData(input.nonce, input.peerId, channelBinding), socket)
        // Only the RTMR3 events: the buyer replays them to the app's compose hash, then checks the compose.
        const imageBuild = appCompose ? await imageBuildRecord(composeImageDigest(appCompose)) : undefined
        return encodeTeeTdxEvidence(quote, undefined, undefined, {
          ...(eventLog ? { eventLog: rtmr3Events(eventLog), rawEventLog: eventLog } : {}),
          ...(vmConfig ? { vmConfig } : {}),
          ...(appCompose ? { appCompose } : {}),
          ...(imageBuild !== undefined ? { imageBuild } : {}),
        })
      }
      if (source === 'http') {
        const url = input.config[tdxConfigKey(id, 'url')]
        if (!url) throw new Error(`${id} http source requires an evidence url; not offered`)
        const field = input.config[tdxConfigKey(id, 'field')] ?? 'quote'
        const scheme = input.config[tdxConfigKey(id, 'binding.scheme')]
        // The fetch refuses redirects, so the evidence comes from the configured URL's origin.
        const origin = new URL(url).origin
        if (!scheme) {
          return encodeTeeTdxEvidence(await collectViaHttp(url, input.nonce, field), undefined, undefined, { origin })
        }
        // Declare the provider's frozen report_data scheme and its ingredients (e.g. the E2E
        // pubkey) so the buyer can verify the quote is bound to this round. Both come from one
        // fetch, so the quote and the pubkey are from the same response (no cross-fetch skew).
        const pubkeyField = input.config[tdxConfigKey(id, 'binding.pubkeyField')]
        const { quote, pubkey } = await collectTdxAndPubkey(url, input.nonce, field, pubkeyField)
        const ingredients = pubkey ? { e2ePubkey: pubkey } : {}
        return encodeTeeTdxEvidence(quote, undefined, { scheme, ingredients }, { origin })
      }
      throw new Error(`unknown ${id} source "${source}" (expected "configfs", "dstack", "confidential-space", or "http")`)
    },
  }
}

/**
 * The Antseed seller node's own TEE — mints its quote locally via configfs; report_data bound to
 * nonce + peerId + the buyer's connection, and the TD measurement must be an approved build.
 */
export const nodeTeeCapability = makeTdxCap(NODE_TEE_CAP_ID, 'configfs', { sellerNode: true })
/** The downstream inference provider's TEE — quote fetched from the provider's evidence route. */
export const providerTeeCapability = makeTdxCap(PROVIDER_TEE_CAP_ID, 'http')
