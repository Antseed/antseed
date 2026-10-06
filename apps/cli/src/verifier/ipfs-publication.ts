import { File } from 'node:buffer'
import { readdir, readFile } from 'node:fs/promises'
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
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
  agentId: string
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

interface VerificationPublicationArchive {
  path: string
  files: Array<{ path: string; size: number; sha256: string }>
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
 * Packages one agent's audit report evidence for public pinning: the canonical evidence document,
 * the exported KBF references, and every referenced seller evidence pack (with signed exchanges).
 * Paths mirror the evidence directory so the document's relative links resolve inside the CID.
 */
export async function prepareReportPublication(input: {
  evidenceDir: string
  runId: string
  agentId: string
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
    for (const path of await listFinalizedFiles(dirname(evidencePath))) {
      addPublicationFile(files, publicationPath(path), await readFile(path))
    }
  }

  const sourceFileCount = files.size
  const archives = compactExchangeFiles(files)
  const evidenceFiles = [...files.values()].sort((left, right) => left.path.localeCompare(right.path))
  const publicationIndex = {
    version: 1,
    kind: 'antseed-verifier-ipfs-publication',
    runId: input.runId,
    agentId: input.agentId,
    evidenceHash: input.evidenceHash,
    evidencePath: publicationPath(input.evidencePath),
    scope: {
      public: true,
      sellerSignedResponses: true,
      exactSignedPreimages: true,
      onChainEvidenceUri: true,
    },
    sourceFileCount,
    fileCount: evidenceFiles.length,
    totalBytes: evidenceFiles.reduce((total, file) => total + file.size, 0),
    archives,
    files: evidenceFiles.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 })),
  }
  addPublicationFile(files, 'publication.json', Buffer.from(canonicalJsonStringify(publicationIndex), 'utf8'))
  const allFiles = [...files.values()].sort((left, right) => left.path.localeCompare(right.path))
  if (allFiles.length > PINATA_MAX_MULTIPART_FILES) {
    throw new Error(
      `verification publication contains ${allFiles.length} upload files after exchange compaction; `
      + `Pinata allows at most ${PINATA_MAX_MULTIPART_FILES}`,
    )
  }
  return {
    version: 1,
    kind: 'antseed-verifier-ipfs-publication-package',
    runId: input.runId,
    agentId: input.agentId,
    evidenceHash: input.evidenceHash,
    packageName: `antseed-verification-${safeServiceSlug(input.runId)}-agent-${safeServiceSlug(input.agentId)}`,
    files: allFiles,
    fileCount: allFiles.length,
    totalBytes: allFiles.reduce((total, file) => total + file.size, 0),
  }
}

function compactExchangeFiles(
  files: Map<string, VerificationPublicationFile>,
): VerificationPublicationArchive[] {
  if (files.size + 1 <= PINATA_MAX_MULTIPART_FILES) return []
  const groups = new Map<string, VerificationPublicationFile[]>()
  for (const file of files.values()) {
    const match = /^(.*\/sellers\/[^/]+)\/exchanges\/[^/]+\.json$/.exec(file.path)
    if (!match) continue
    const archivePath = `${match[1]}/exchanges.bundle.json`
    const group = groups.get(archivePath) ?? []
    group.push(file)
    groups.set(archivePath, group)
  }

  const archives = [...groups.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([archivePath, exchangeFiles]) => {
      const sortedFiles = exchangeFiles.sort((left, right) => left.path.localeCompare(right.path))
      for (const file of sortedFiles) files.delete(file.path)
      const archive = {
        version: 1,
        kind: 'antseed-verifier-ipfs-file-archive',
        encoding: 'base64',
        files: sortedFiles.map((file) => ({
          path: file.path,
          size: file.size,
          sha256: file.sha256,
          mediaType: mediaType(file.path),
          bytesBase64: Buffer.from(file.bytes).toString('base64'),
        })),
      }
      addPublicationFile(files, archivePath, Buffer.from(canonicalJsonStringify(archive), 'utf8'))
      return {
        path: archivePath,
        files: sortedFiles.map((file) => ({ path: file.path, size: file.size, sha256: file.sha256 })),
      }
    })
  return archives
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
    agentId: publication.agentId,
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

async function listFinalizedFiles(directory: string): Promise<string[]> {
  const files: string[] = []
  const walk = async (current: string): Promise<void> => {
    const entries = await readdir(current, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (isOperationalEvidenceEntry(entry.name)) continue
      const path = join(current, entry.name)
      if (entry.isSymbolicLink()) throw new Error(`refusing symlink in verifier evidence: ${path}`)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) files.push(path)
    }
  }
  await walk(directory)
  return files.sort()
}

function isOperationalEvidenceEntry(name: string): boolean {
  return name === '.checkpoints'
    || name === 'status.json'
    || name === 'events.jsonl'
    || name === 'submissions'
    || name.endsWith('.lock')
    || name.includes('.tmp-')
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
