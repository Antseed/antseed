import type { JWTPayload, JWTVerifyGetKey } from 'jose'

/**
 * NRAS wire module — the single place the NVIDIA Remote Attestation Service request/response
 * mapping lives, so a shift in NVIDIA's schema changes only this file. Everything the rest of
 * the SDK needs (build a request, submit it, verify the returned EAR) is behind these exports.
 *
 * Sources for this mapping (July 2026):
 *   - NRAS API reference: https://docs.attestation.nvidia.com/api-docs/nras.html
 *   - Hopper single-GPU example: https://docs.nvidia.com/attestation/quick-start-guide/latest/attestation-examples/hopper_single_gpu.html
 *   - NRAS releases (v3 evidence_list rename + detached-EAR token): https://docs.nvidia.com/attestation/technical-docs-nras/latest/nras_releases.html
 *   - NVIDIA EAT claims (Intel Trust Authority mirror): https://docs.trustauthority.intel.com/main/articles/articles/ita/concept-gpu-attestation.html
 *
 * Why generic: NRAS is NVIDIA's own attestation service, not an AntSeed inference provider,
 * so the NVIDIA host is a sensible default here (overridable by env). Nothing about any
 * particular provider (hostnames, evidence field names) appears in this module.
 */

/** NRAS v3 GPU attest endpoint. Overridable via ANTSEED_VERIFIER_NRAS_URL. */
export const NRAS_GPU_ATTEST_URL_DEFAULT = 'https://nras.attestation.nvidia.com/v3/attest/gpu'
/** NRAS JWKS — the public keys a relying party verifies the EAR JWT against. Overridable via env. */
export const NRAS_JWKS_URL_DEFAULT = 'https://nras.attestation.nvidia.com/.well-known/jwks.json'

/** One GPU's confidential-compute evidence: base64 SPDM attestation report + its cert chain. */
export interface NrasEvidenceItem {
  evidence: string
  certificate: string
}

/**
 * The provider-produced GPU evidence blob (rides the provider's evidence route). Generic:
 * `arch` (e.g. "HOPPER" or "BLACKWELL") and the per-GPU evidence come from the provider, never
 * hardcoded here. This is the NRAS request body minus the buyer-supplied nonce.
 */
export interface NvidiaGpuEvidence {
  arch: string
  evidence_list: NrasEvidenceItem[]
}

/** The JSON body POSTed to NRAS (v3 uses the "evidence_list" field). */
export interface NrasRequest {
  nonce: string
  arch: string
  evidence_list: NrasEvidenceItem[]
}

/** Injectable HTTP submit so tests never touch the network. Returns the parsed NRAS response. */
export type NrasSubmitFn = (url: string, body: NrasRequest) => Promise<unknown>

/** Structured EAR verdict — the caller renders a human detail and maps it to a ClaimResult. */
export interface EarVerification {
  ok: boolean
  /** Reason string (why it failed, or a success summary). */
  reason: string
  /** Number of GPUs the EAR reported on (device token count). */
  gpuCount: number
  /** CC-mode determination — see ccModeOf() for how it is derived and why it is fuzzy. */
  ccMode: 'enabled' | 'disabled' | 'implied'
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

/**
 * Build the NRAS request from provider evidence and the buyer's nonce. Fail-closed: it throws on
 * anything malformed, so a missing or garbage evidence blob can never reach NRAS as a valid ask.
 * The nonce is the buyer's 32 raw bytes rendered as 64 lowercase hex chars (NRAS "32-byte Hex").
 */
export function buildNrasRequest(evidence: NvidiaGpuEvidence, nonce: Uint8Array): NrasRequest {
  if (!isNonEmptyString(evidence?.arch)) throw new Error('gpu evidence missing "arch"')
  if (!Array.isArray(evidence.evidence_list) || evidence.evidence_list.length === 0) {
    throw new Error('gpu evidence missing non-empty "evidence_list"')
  }
  for (const [i, item] of evidence.evidence_list.entries()) {
    if (!isNonEmptyString(item?.evidence)) throw new Error(`gpu evidence_list[${i}] missing "evidence"`)
    if (!isNonEmptyString(item?.certificate)) throw new Error(`gpu evidence_list[${i}] missing "certificate"`)
  }
  return {
    nonce: Buffer.from(nonce).toString('hex'),
    arch: evidence.arch,
    evidence_list: evidence.evidence_list.map((e) => ({ evidence: e.evidence, certificate: e.certificate })),
  }
}

/** Default submit: POST JSON to NRAS with a hard timeout. Network or non-2xx errors bubble up (the caller marks them transient). */
export const defaultNrasSubmit: NrasSubmitFn = async (url, body) => {
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20_000),
  })
  if (!resp.ok) throw new Error(`NRAS returned HTTP ${resp.status}`)
  const declared = Number(resp.headers?.get('content-length') ?? '0')
  if (declared > 4 * 1024 * 1024) throw new Error(`NRAS response too large (${declared} bytes)`)
  return resp.json()
}

/** Unwrap NRAS v3's ["JWT", token] content-type pair to the token; pass a bare string through. */
function jwtOf(v: unknown): string | undefined {
  if (isNonEmptyString(v)) return v
  if (Array.isArray(v) && v[0] === 'JWT' && isNonEmptyString(v[1])) return v[1]
  return undefined
}

/**
 * Extract the JWT strings from an NRAS response. Handles a bare JWT string, and the v3 detached
 * EAR array [ overall, { "GPU-0": jwt, ... } ] where each token may be wrapped as a
 * ["JWT", token] content-type pair. Returns the overall token (if any) plus per-device tokens.
 */
export function extractEarTokens(resp: unknown): { overall?: string; devices: Record<string, string> } {
  const bare = jwtOf(resp)
  if (bare) return { overall: bare, devices: {} }
  if (Array.isArray(resp)) {
    let overall: string | undefined
    const devices: Record<string, string> = {}
    for (const el of resp) {
      const tok = jwtOf(el)
      if (tok) { overall = tok; continue }
      if (el && typeof el === 'object') {
        for (const [k, v] of Object.entries(el as Record<string, unknown>)) {
          const dt = jwtOf(v)
          if (dt) devices[k] = dt
        }
      }
    }
    return { overall, devices }
  }
  throw new Error('unrecognized NRAS response shape (expected a JWT string or a detached-EAR array)')
}

/**
 * Candidate per-device claim names that carry a confidential-compute signal. NVIDIA's EAT does
 * not document a single stable "cc-mode" boolean, so this checks a documented candidate set
 * instead of inventing one. The authoritative CC signal is that `x-nvidia-overall-att-result`
 * is true for evidence submitted to the /attest/gpu (CC) endpoint. Extend this list here if
 * NVIDIA names the claim explicitly. It lives here so the policy in gpu-nvidia.ts stays clean.
 */
const CC_MODE_CLAIM_CANDIDATES = [
  'x-nvidia-gpu-attestation-report-cc-mode',
  'x-nvidia-cc-mode',
  'x-nvidia-ccmode',
]

/** Truthy for the common on/off encodings NVIDIA uses (booleans and "enabled"/"on" strings). */
function claimTruthy(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'string') return ['true', 'enabled', 'on', 'active'].includes(v.toLowerCase())
  return false
}

/** Tri-state CC-mode read: explicit true → 'enabled', explicit false → 'disabled', absent → undefined. */
function ccModeOf(payload: JWTPayload): 'enabled' | 'disabled' | undefined {
  for (const key of CC_MODE_CLAIM_CANDIDATES) {
    if (key in payload) return claimTruthy(payload[key]) ? 'enabled' : 'disabled'
  }
  return undefined
}

/** Per-device "this GPU passed its own measurement compare" — NVIDIA uses measres === "success". */
function deviceMeasuredOk(payload: JWTPayload): boolean {
  return payload['measres'] === 'success'
}

/** Read the eat_nonce claim (NVIDIA emits it as lowercase hex), if present. */
function eatNonce(payload: JWTPayload): string | undefined {
  const n = payload['eat_nonce']
  return typeof n === 'string' ? n.toLowerCase() : undefined
}

/**
 * Verify the NRAS EAR against the buyer's nonce. It verifies every JWT's signature against the
 * injected key resolver (NVIDIA JWKS in production, a test key in tests), then enforces:
 *   - the overall attestation result is success (x-nvidia-overall-att-result === true; when only
 *     per-device tokens are present, every device's measres === "success")
 *   - eat_nonce binds this exact buyer nonce (checked on the overall token, else on every device)
 *   - CC mode is not explicitly disabled on any device
 * A bad signature or failed check is an attestation failure (not transient). It never verifies
 * with a symmetric or "none" alg — jose derives the allowed alg from the resolved key.
 */
export async function verifyEar(
  resp: unknown,
  nonce: Uint8Array,
  getKey: JWTVerifyGetKey,
): Promise<EarVerification> {
  const fail = (reason: string): EarVerification => ({ ok: false, reason, gpuCount: 0, ccMode: 'implied' })

  const { overall, devices } = extractEarTokens(resp)
  const deviceIds = Object.keys(devices)
  if (!overall && deviceIds.length === 0) return fail('NRAS response contained no EAR token')

  const jose = await import('jose')
  const expectedNonce = Buffer.from(nonce).toString('hex')

  // Verify signatures and collect payloads. jose throws on a bad signature or an unexpected alg.
  let overallPayload: JWTPayload | undefined
  const devicePayloads: JWTPayload[] = []
  try {
    if (overall) overallPayload = (await jose.jwtVerify(overall, getKey)).payload
    for (const id of deviceIds) devicePayloads.push((await jose.jwtVerify(devices[id]!, getKey)).payload)
  } catch (err) {
    return fail(`EAR signature verification failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  // Overall attestation result: prefer the overall claim; else require every device measured-ok.
  const overallResult = overallPayload
    ? overallPayload['x-nvidia-overall-att-result'] === true
    : devicePayloads.length > 0 && devicePayloads.every(deviceMeasuredOk)
  if (!overallResult) return fail('NRAS overall attestation result was not success')

  // Nonce binding: the overall token carries eat_nonce in v3; fall back to every device token.
  const nonceMatches = overallPayload && eatNonce(overallPayload) !== undefined
    ? eatNonce(overallPayload) === expectedNonce
    : devicePayloads.length > 0 && devicePayloads.every((p) => eatNonce(p) === expectedNonce)
  if (!nonceMatches) return fail('NRAS EAR nonce does not match this attestation round')

  // CC mode: reject only an explicit disable; otherwise trust the overall CC-endpoint result.
  let ccMode: EarVerification['ccMode'] = 'implied'
  for (const p of devicePayloads) {
    const m = ccModeOf(p)
    if (m === 'disabled') return fail('a GPU reported confidential-compute mode disabled')
    if (m === 'enabled') ccMode = 'enabled'
  }

  const gpuCount = deviceIds.length || 1
  return { ok: true, reason: `${gpuCount} NVIDIA GPU${gpuCount === 1 ? '' : 's'}, CC mode ${ccMode}, NRAS-verified`, gpuCount, ccMode }
}
