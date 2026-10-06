import { ANTSEED_ATTEST_PATH, type SellerRequest, type SellerResponse } from '@antseed/node'
import { loadVerifierPlugin } from './loader.js'
import { TRUSTED_VERIFIER_PLUGINS } from './registry.js'
import { parseVerifierCapabilities } from '@antseed/node/verifier-capabilities'
import { passedSellerNodeClaims, TEE_VERIFIER_ID, type TeeClaim } from '@antseed/node/tee-status'
export { parseVerifierCapabilities } from '@antseed/node/verifier-capabilities'

export const ANTSEED_VERIFIER_SDKS_ENV = 'ANTSEED_VERIFIER_SDKS'
const VSDK = 'verifier.'
const VSDK_DEFAULT = 'verifier-default.'
const VERIFIER_ID_RE = /^[a-z0-9][a-z0-9.-]*$/

function isVerifierId(id: string): boolean {
  return VERIFIER_ID_RE.test(id)
}

export function normalizeVerifierIds(raw: string): string[] {
  const ids = raw.split(',').map((id) => id.trim().toLowerCase()).filter(Boolean)
  for (const id of ids) {
    if (!isVerifierId(id)) {
      throw new Error(`invalid verifier id "${id}": use lowercase letters, digits, hyphen, or dot`)
    }
  }
  return Array.from(new Set(ids))
}

export function buildVerifierCapabilities(ids: string[]): string[] {
  const clean = normalizeVerifierIds(ids.join(','))
  return clean.flatMap((id, i) => (i === 0 ? [`${VSDK}${id}`, `${VSDK_DEFAULT}${id}`] : [`${VSDK}${id}`]))
}

export function curatedVerifierIds(): Set<string> {
  return new Set(TRUSTED_VERIFIER_PLUGINS.map((p) => p.name))
}

export interface VerifierPolicy {
  prefer?: string[]
  require: boolean
}

/**
 * Resolve buyer verifier CLI flags into a policy. `--no-verifier` (verifier === false)
 * disables verification; combining it with `--require-verifier` or `--verifiers` is a
 * contradiction and is rejected rather than silently disabling verification.
 */
export function resolveVerifierPolicy(opts: {
  verifier?: boolean
  verifiers?: string
  requireVerifier?: boolean
}): VerifierPolicy | undefined {
  if (opts.verifier === false) {
    if (opts.requireVerifier || opts.verifiers) {
      throw new Error('--no-verifier cannot be combined with --require-verifier or --verifiers')
    }
    return undefined
  }
  return { prefer: normalizeVerifierIds(opts.verifiers ?? ''), require: Boolean(opts.requireVerifier) }
}

export function selectVerifier(
  policy: VerifierPolicy,
  sup: { supported: string[]; default?: string },
): string | null {
  for (const id of policy.prefer ?? []) {
    if (sup.supported.includes(id)) return id
  }
  if ((policy.prefer ?? []).length > 0) return null
  const curated = curatedVerifierIds()
  if (sup.default && curated.has(sup.default)) return sup.default
  return sup.supported.find((id) => curated.has(id)) ?? null
}

export type SellerReach = (req: SellerRequest) => Promise<SellerResponse>

export interface VerifyOutcome {
  ok: boolean
  verified: boolean
  sdk?: string
  reason?: string
  /** True for install/network/timeout failures — a transient outcome must not be cached. */
  transient?: boolean
  code?: 'busy'
  sellerNodeVerified?: boolean
  claims?: TeeClaim[]
  version?: string
}

/** Stable fingerprint of a peer's verifier-relevant capabilities. */
export function verifierSupportFingerprint(caps: string[] | undefined): string {
  const sup = parseVerifierCapabilities(caps)
  return `${sup.default ?? ''}|${[...sup.supported].sort().join(',')}`
}

/** Upper bound on a single verification (attest round-trip + quote check). */
export const VERIFY_TIMEOUT_MS = 30_000

export async function withVerifyTimeout<T>(
  run: (signal: AbortSignal) => Promise<T>,
  outer?: AbortSignal,
  timeoutMs: number = VERIFY_TIMEOUT_MS,
): Promise<T> {
  const ac = new AbortController()
  const abort = (reason: unknown): void => { if (!ac.signal.aborted) ac.abort(reason) }
  const onOuter = (): void => abort(outer?.reason ?? new Error('verification aborted'))
  if (outer?.aborted) abort(outer.reason ?? new Error('verification aborted'))
  else outer?.addEventListener('abort', onOuter, { once: true })
  const timer = setTimeout(() => abort(new Error(`verification timed out after ${timeoutMs}ms`)), timeoutMs)
  try {
    return await Promise.race([
      run(ac.signal),
      new Promise<never>((_, reject) => {
        const fail = (): void => {
          const r = ac.signal.reason
          reject(r instanceof Error ? r : new Error('verification aborted'))
        }
        // The signal may already be aborted (e.g. the client had disconnected before
        // we started); a listener added after that never fires, so reject eagerly.
        if (ac.signal.aborted) fail()
        else ac.signal.addEventListener('abort', fail, { once: true })
      }),
    ])
  } finally {
    clearTimeout(timer)
    outer?.removeEventListener('abort', onOuter)
  }
}

export async function runVerifier(
  policy: VerifierPolicy,
  peerId: string,
  caps: string[] | undefined,
  makeReach: (chosenId: string) => SellerReach,
  signal?: AbortSignal,
  load: typeof loadVerifierPlugin = loadVerifierPlugin,
): Promise<VerifyOutcome> {
  const sup = parseVerifierCapabilities(caps)
  const chosen = selectVerifier(policy, sup)
  if (!chosen) return { ok: !policy.require, verified: false, reason: 'no supported + trusted verifier' }
  const reach = makeReach(chosen)
  let sdk
  try {
    sdk = await load(chosen, { install: false })
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { ok: !policy.require, verified: false, sdk: chosen, reason: `verifier not prepared: ${reason}`.slice(0, 2048), transient: true }
  }
  if (sdk.name !== chosen) {
    return { ok: !policy.require, verified: false, sdk: chosen, reason: `verifier package exported name "${sdk.name}", expected "${chosen}"` }
  }
  try {
    const result = await withVerifyTimeout(
      async (verifySignal) => sdk.verify({
        peerId,
        verifierId: chosen,
        attestPath: `${ANTSEED_ATTEST_PATH}/${encodeURIComponent(chosen)}`,
        fetchFromSeller: reach,
        signal: verifySignal,
      }),
      signal,
    )
    const valid = Array.isArray(result.claims) && result.claims.length <= 128
      && result.claims.every((claim) => claim && typeof claim.claim === 'string'
        && claim.claim.length <= 256 && typeof claim.ok === 'boolean'
        && (claim.detail === undefined || typeof claim.detail === 'string'))
    const claims: TeeClaim[] = valid ? result.claims.map((claim) => ({
      claim: claim.claim, ok: claim.ok,
      ...(claim.detail ? { detail: claim.detail.slice(0, 1024) } : {}),
    })) : []
    const verified = result.ok === true
    const sellerNodeVerified = verified && valid && chosen === TEE_VERIFIER_ID && passedSellerNodeClaims(claims)
    const failed = claims.filter((claim) => !claim.ok).map((claim) => `${claim.claim}: ${claim.detail ?? 'failed'}`).join('; ')
    return {
      ok: !policy.require || verified, verified, sellerNodeVerified, sdk: chosen,
      version: sdk.version, claims,
      ...(!sellerNodeVerified ? { reason: (failed || 'Required seller-node claims did not pass').slice(0, 2048) } : {}),
    }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    return { ok: !policy.require, verified: false, sdk: chosen, reason: `verify error: ${reason}`.slice(0, 2048), transient: true }
  }
}
