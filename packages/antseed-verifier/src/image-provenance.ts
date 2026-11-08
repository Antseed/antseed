import { X509Certificate } from 'node:crypto'
import type { ApprovedSellerImage } from './approved-seller-images.js'
import { isObj } from './seller-config-rules.js'
import trustedRoot from './sigstore-trusted-root.json' with { type: 'json' }

/**
 * Approval of a TEE seller image by its build record instead of a release: an image counts as
 * approved when its signed SLSA provenance shows the "Publish TEE seller image" workflow built it
 * from this repository's main branch. The seller sends the record (a Sigstore bundle, as GitHub's
 * attestations API serves it) with its attestation; the buyer checks it offline against
 * Sigstore's public-good trust root (sigstore-trusted-root.json): the signing certificate's chain
 * to Fulcio, its certificate transparency proof, the Rekor log entry, the workflow identity in the
 * certificate, and that the record names the image digest.
 */
export const IMAGE_BUILD = {
  image: 'ghcr.io/antseed/tee-seller',
  repository: 'Antseed/antseed',
  /** The signing certificate's subject: the workflow file, on main. */
  workflow: 'https://github.com/Antseed/antseed/.github/workflows/tee-seller-image.yml@refs/heads/main',
  issuer: 'https://token.actions.githubusercontent.com',
}

const SLSA_PROVENANCE_V1 = 'https://slsa.dev/provenance/v1'

/**
 * Images built before this time are not approved by their build record (only by the approved
 * list). Raise it in a release to retire every older image at once.
 */
export const IMAGES_BUILT_AFTER = '2026-11-07T00:00:00Z'

export interface ImageBuildPolicy {
  image: string
  workflow: string
  issuer: string
  builtAfter: string
}

const DEFAULT_POLICY: ImageBuildPolicy = { ...IMAGE_BUILD, builtAfter: IMAGES_BUILT_AFTER }

/** The bundled trust root, converted once (the type import does not load Sigstore). */
let trustMaterial: ReturnType<typeof import('@sigstore/verify').toTrustMaterial> | undefined

/**
 * Verify a TEE seller image's build record. Returns the images it approves (each digest it names
 * for the image, labelled with its build date and commit), or why it approves none.
 */
export async function verifyImageBuild(
  bundle: unknown,
  policy: ImageBuildPolicy = DEFAULT_POLICY,
): Promise<{ images: ApprovedSellerImage[] } | { error: string }> {
  try {
    const [{ bundleFromJSON }, { Verifier, toSignedEntity, toTrustMaterial }, { TrustedRoot }] = await Promise.all([
      import('@sigstore/bundle'),
      import('@sigstore/verify'),
      import('@sigstore/protobuf-specs'),
    ])
    const parsed = bundleFromJSON(bundle)
    if (parsed.content.$case !== 'dsseEnvelope') return { error: 'build record is not a signed attestation' }
    trustMaterial ??= toTrustMaterial(TrustedRoot.fromJSON(trustedRoot))
    const verifier = new Verifier(trustMaterial, { tlogThreshold: 1, ctlogThreshold: 1 })
    verifier.verify(toSignedEntity(parsed), { subjectAlternativeName: policy.workflow, extensions: { issuer: policy.issuer } })

    const envelope = parsed.content.dsseEnvelope
    if (envelope.payloadType !== 'application/vnd.in-toto+json') return { error: 'build record is not an in-toto statement' }
    const statement: unknown = JSON.parse(Buffer.from(envelope.payload).toString('utf8'))
    if (!isObj(statement) || statement['predicateType'] !== SLSA_PROVENANCE_V1) return { error: 'build record is not SLSA provenance' }

    // The signing certificate's start, which Fulcio signed and sets to when it issued the certificate
    // for the build (the verifier just checked its chain); log entry times are not all signed.
    const material = parsed.verificationMaterial.content
    const leaf = material.$case === 'certificate' ? material.certificate : material.$case === 'x509CertificateChain' ? material.x509CertificateChain.certificates[0] : undefined
    if (!leaf) return { error: 'build record has no signing certificate' }
    const builtAt = Date.parse(new X509Certificate(leaf.rawBytes).validFrom)
    if (!(builtAt >= Date.parse(policy.builtAfter))) return { error: `image was built before ${policy.builtAfter}` }
    const predicate = isObj(statement['predicate']) ? statement['predicate'] : {}
    const definition = isObj(predicate['buildDefinition']) ? predicate['buildDefinition'] : {}
    const dependencies = Array.isArray(definition['resolvedDependencies']) ? definition['resolvedDependencies'] : []
    const source = dependencies.find((d): d is { digest: { gitCommit: string } } => isObj(d) && isObj(d['digest']) && typeof d['digest']['gitCommit'] === 'string')
    const commit = source ? source.digest.gitCommit.slice(0, 7) : 'unknown commit'

    const subjects = Array.isArray(statement['subject']) ? statement['subject'] : []
    const images = subjects
      .filter((s): s is { digest: { sha256: string } } => isObj(s) && s['name'] === policy.image && isObj(s['digest']) && typeof s['digest']['sha256'] === 'string')
      .map((s) => ({
        version: `built ${new Date(builtAt).toISOString().slice(0, 10)} from ${commit}`,
        digest: `sha256:${s.digest.sha256}`,
      }))
    if (images.length === 0) return { error: `build record names no ${policy.image} image` }
    return { images }
  } catch (err) {
    return { error: `build record does not verify: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** The image digest a dstack app compose runs ("sha256:<hex>"), if it names one. */
export function composeImageDigest(appCompose: string): string | undefined {
  try {
    const app: unknown = JSON.parse(appCompose)
    const compose: unknown = isObj(app) && typeof app['docker_compose_file'] === 'string' ? JSON.parse(app['docker_compose_file']) : undefined
    const services = isObj(compose) && isObj(compose['services']) ? Object.values(compose['services']) : []
    const image = services.length === 1 && isObj(services[0]) ? services[0]['image'] : undefined
    return typeof image === 'string' ? /@(sha256:[0-9a-f]{64})$/.exec(image)?.[1] : undefined
  } catch {
    return undefined
  }
}

/** The image digest a Confidential Space token names, read without verifying the token (the buyer verifies it). */
export function tokenImageDigest(token: string): string | undefined {
  try {
    const claims: unknown = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8'))
    const submods = isObj(claims) && isObj(claims['submods']) ? claims['submods'] : {}
    const digest = isObj(submods['container']) ? submods['container']['image_digest'] : undefined
    return typeof digest === 'string' && /^sha256:[0-9a-f]{64}$/.test(digest) ? digest : undefined
  } catch {
    return undefined
  }
}

const FETCH_TIMEOUT_MS = 10_000
const MAX_RECORD_BYTES = 256 * 1024
/** How long a failed lookup is remembered before the next round tries again (GitHub limits unauthenticated calls per IP). */
const RETRY_AFTER_MS = 10 * 60_000

/** The image's build record from GitHub's attestations API, or undefined when there is none. */
async function fetchImageBuild(digest: string, fetchImpl: typeof fetch): Promise<unknown> {
  const url = `https://api.github.com/repos/${IMAGE_BUILD.repository}/attestations/${digest}?predicate_type=${encodeURIComponent(SLSA_PROVENANCE_V1)}`
  const res = await fetchImpl(url, {
    headers: { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' },
    redirect: 'error',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (res.status === 404) return undefined
  if (!res.ok) throw new Error(`GitHub attestations API answered HTTP ${res.status}`)
  const text = await res.text()
  if (text.length > MAX_RECORD_BYTES) throw new Error(`build record too large (${text.length} bytes)`)
  const body: unknown = JSON.parse(text)
  const attestations = isObj(body) && Array.isArray(body['attestations']) ? body['attestations'] : []
  return attestations.map((a) => (isObj(a) ? a['bundle'] : undefined)).find(isObj)
}

const cache = new Map<string, { at: number; record: Promise<unknown> }>()

/**
 * The seller's own image build record, fetched once per digest and kept; a failed or empty lookup
 * is retried after a while. Never throws: without a record the buyer falls back to the approved list.
 */
export async function imageBuildRecord(digest: string | undefined, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<unknown> {
  if (!digest) return undefined
  const hit = cache.get(digest)
  if (hit && (now - hit.at < RETRY_AFTER_MS || (await hit.record) !== undefined)) return hit.record
  const record = fetchImageBuild(digest, fetchImpl).catch(() => undefined)
  cache.set(digest, { at: now, record })
  return record
}
