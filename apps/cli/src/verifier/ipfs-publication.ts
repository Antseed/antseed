import { File } from 'node:buffer'
import { readFile } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { canonicalJsonStringify, sha256Hex } from '@antseed/fingerprints'
import { safeServiceSlug } from './slug.js'

const PINATA_UPLOAD_URL = 'https://uploads.pinata.cloud/v3/files'
const PINATA_UPLOAD_ATTEMPTS = 3
const PINATA_UPLOAD_TIMEOUT_MS = 10 * 60_000
const PINATA_MAX_MULTIPART_FILES = 150

export interface VerificationPublicationFile {
  path: string
  bytes: Uint8Array
  size: number
  sha256: string
}

export interface PreparedVerificationPublication {
  version: 1
  kind: 'antseed-verifier-ipfs-publication-package'
  runId: string
  /** Model audit key the package belongs to. */
  model: string
  evidenceHash: string
  packageName: string
  files: VerificationPublicationFile[]
  fileCount: number
  totalBytes: number
}

export interface PublishedVerificationEvidence {
  provider: 'pinata'
  evidenceHash: string
  cid: string
  uri: string
  pinSize: number
  fileCount: number
  publishedAt: string
}

interface PinataResponse {
  data?: {
    cid?: unknown
    size?: unknown
    created_at?: unknown
  }
}

interface PinataUploadDependencies {
  endpoint?: string
  fetchImpl?: typeof fetch
  sleep?: (delayMs: number) => Promise<void>
}

class PinataUploadError extends Error {
  constructor(message: string, readonly retryable: boolean) {
    super(message)
  }
}

/**
 * Packages one model audit's evidence for public pinning: the canonical evidence document,
 * the exported KBF references, and each referenced seller's hash-committed `evidence.json`,
 * which already embeds every signed exchange. The per-batch `exchanges/` copies are not published.
 * Paths mirror the evidence directory so the document's relative links resolve inside the CID.
 */
export async function prepareAuditPublication(input: {
  evidenceDir: string
  runId: string
  /** Model audit key the package belongs to. */
  model: string
  evidenceHash: string
  evidencePath: string
  evidenceBytes: Uint8Array
  referencePaths: string[]
  auditEvidencePaths: string[]
}): Promise<PreparedVerificationPublication> {
  const evidenceRoot = resolve(input.evidenceDir)
  const publicationPath = (path: string): string => portablePath(evidenceRoot, path)
  const files = new Map<string, VerificationPublicationFile>()
  addPublicationFile(files, publicationPath(input.evidencePath), input.evidenceBytes)
  for (const path of [...input.referencePaths].sort()) addPublicationFile(files, publicationPath(path), await readFile(path))
  for (const evidencePath of [...new Set(input.auditEvidencePaths)].sort()) {
    addPublicationFile(files, publicationPath(evidencePath), await readFile(evidencePath))
  }

  const evidenceFiles = [...files.values()].sort((left, right) => left.path.localeCompare(right.path))
  const publicationIndex = {
    version: 1,
    kind: 'antseed-verifier-ipfs-publication',
    runId: input.runId,
    model: input.model,
    evidenceHash: input.evidenceHash,
    evidencePath: publicationPath(input.evidencePath),
    scope: {
      public: true,
      sellerSignedResponses: true,
      exactSignedPreimages: true,
      onChainEvidenceUri: true,
    },
    fileCount: evidenceFiles.length,
    totalBytes: evidenceFiles.reduce((total, file) => total + file.size, 0),
    files: evidenceFiles.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 })),
  }
  addPublicationFile(files, 'publication.json', Buffer.from(canonicalJsonStringify(publicationIndex), 'utf8'))
  const allFiles = [...files.values()].sort((left, right) => left.path.localeCompare(right.path))
  if (allFiles.length > PINATA_MAX_MULTIPART_FILES) {
    throw new Error(
      `verification publication contains ${allFiles.length} upload files; `
      + `Pinata allows at most ${PINATA_MAX_MULTIPART_FILES}`,
    )
  }
  return {
    version: 1,
    kind: 'antseed-verifier-ipfs-publication-package',
    runId: input.runId,
    model: input.model,
    evidenceHash: input.evidenceHash,
    packageName: `antseed-verification-${safeServiceSlug(input.runId)}-model-${safeServiceSlug(input.model)}`,
    files: allFiles,
    fileCount: allFiles.length,
    totalBytes: allFiles.reduce((total, file) => total + file.size, 0),
  }
}

export async function publishVerificationToPinata(
  publication: PreparedVerificationPublication,
  jwt: string,
  dependencies: PinataUploadDependencies = {},
): Promise<PublishedVerificationEvidence> {
  if (!jwt.trim()) throw new Error('PINATA_JWT is required with --publish-ipfs')
  const fetchImpl = dependencies.fetchImpl ?? fetch
  const sleep = dependencies.sleep ?? ((delayMs) => new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs)))
  let lastError: Error | null = null
  for (let attempt = 1; attempt <= PINATA_UPLOAD_ATTEMPTS; attempt++) {
    try {
      return await uploadPublication(publication, jwt, dependencies.endpoint ?? PINATA_UPLOAD_URL, fetchImpl)
    } catch (error) {
      const failure = error instanceof PinataUploadError
        ? error
        : new PinataUploadError('Pinata upload failed before receiving a response', true)
      lastError = failure
      if (!failure.retryable || attempt === PINATA_UPLOAD_ATTEMPTS) throw failure
      await sleep(500 * (2 ** (attempt - 1)))
    }
  }
  throw lastError ?? new Error('Pinata upload failed')
}

async function uploadPublication(
  publication: PreparedVerificationPublication,
  jwt: string,
  endpoint: string,
  fetchImpl: typeof fetch,
): Promise<PublishedVerificationEvidence> {
  const form = new FormData()
  for (const file of publication.files) {
    form.append(
      'file',
      new File([file.bytes], basename(file.path), { type: mediaType(file.path) }),
      file.path,
    )
  }
  form.append('network', 'public')
  form.append('name', publication.packageName)
  form.append('keyvalues', JSON.stringify({
    kind: 'antseed-verifier-evidence',
    runId: publication.runId,
    model: publication.model,
    evidenceHash: publication.evidenceHash,
  }))
  form.append('cid_version', 'v1')

  let response: Response
  try {
    response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}` },
      body: form,
      signal: AbortSignal.timeout(PINATA_UPLOAD_TIMEOUT_MS),
    })
  } catch {
    throw new PinataUploadError('Pinata upload failed before receiving a response', true)
  }
  if (!response.ok) {
    const detail = await pinataErrorDetail(response, jwt)
    throw new PinataUploadError(
      `Pinata upload failed with HTTP ${response.status}${detail ? `: ${detail}` : ''}`,
      response.status === 429 || response.status >= 500,
    )
  }
  let parsed: PinataResponse
  try {
    parsed = await response.json() as PinataResponse
  } catch {
    throw new PinataUploadError('Pinata returned an invalid JSON response', false)
  }
  const cid = typeof parsed.data?.cid === 'string' ? parsed.data.cid.trim() : ''
  if (!/^b[a-z2-7]{20,}$/.test(cid)) {
    throw new PinataUploadError('Pinata returned an invalid CIDv1', false)
  }
  const pinSize = typeof parsed.data?.size === 'number'
    && Number.isSafeInteger(parsed.data.size)
    && parsed.data.size >= 0
    ? parsed.data.size
    : publication.totalBytes
  const publishedAt = typeof parsed.data?.created_at === 'string'
    && Number.isFinite(Date.parse(parsed.data.created_at))
    ? new Date(parsed.data.created_at).toISOString()
    : new Date().toISOString()
  return {
    provider: 'pinata',
    evidenceHash: publication.evidenceHash,
    cid,
    uri: `ipfs://${cid}`,
    pinSize,
    fileCount: publication.fileCount,
    publishedAt,
  }
}

async function pinataErrorDetail(response: Response, jwt: string): Promise<string> {
  let body: string
  try {
    body = await response.text()
  } catch {
    return ''
  }
  return body
    .replaceAll(jwt, '[redacted]')
    .replace(/Bearer\s+[^\s"']+/gi, 'Bearer [redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500)
}

function portablePath(evidenceRoot: string, path: string): string {
  const absolutePath = resolve(path)
  const output = relative(evidenceRoot, absolutePath)
  if (!output || output === '..' || output.startsWith(`..${sep}`) || isAbsolute(output)) {
    throw new Error(`verifier evidence path is outside evidenceDir: ${path}`)
  }
  return output.split(sep).join('/')
}

function addPublicationFile(
  files: Map<string, VerificationPublicationFile>,
  path: string,
  bytes: Uint8Array,
): void {
  if (files.has(path)) return
  files.set(path, {
    path,
    bytes,
    size: bytes.byteLength,
    sha256: `sha256:${sha256Hex(bytes)}`,
  })
}

function mediaType(path: string): string {
  if (extname(path) === '.json') return 'application/json'
  if (extname(path) === '.html') return 'text/html; charset=utf-8'
  if (extname(path) === '.md') return 'text/markdown; charset=utf-8'
  return 'application/octet-stream'
}
