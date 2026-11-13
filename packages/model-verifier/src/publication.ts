import { canonicalHashBytes32, type KbfReferenceV1 } from '@antseed/fingerprints'
import { fetchIpfsText } from './ipfs.js'
import { loadReference, type LoadReferenceOptions } from './reference.js'

export interface ResolveAuditReferenceOptions extends LoadReferenceOptions {
  /** Expected bytes32 evidence hash, e.g. from the on-chain `ModelAudited` event. */
  evidenceHash?: string
}

export interface ResolvedAuditReference {
  cid: string
  evidenceHash: string
  model: string
  reference: KbfReferenceV1
}

interface PublicationIndex {
  kind?: unknown
  evidenceHash?: unknown
  evidencePath?: unknown
}

interface AuditEvidence {
  kind?: unknown
  model?: unknown
  references?: Array<{ referenceId?: unknown; probeCount?: unknown; path?: unknown }>
}

/**
 * Resolves a published model audit (`ipfs://<cid>` or a bare CID) to the largest KBF
 * reference it exported, checking the evidence document against its content hash.
 */
export async function resolveAuditReference(
  source: string,
  options: ResolveAuditReferenceOptions = {},
): Promise<ResolvedAuditReference> {
  const cid = parseCid(source)
  const fetchJson = async <T>(path: string): Promise<T> => JSON.parse(await fetchIpfsText(`${cid}/${path}`, options)) as T
  const publication = await fetchJson<PublicationIndex>('publication.json')
  if (publication.kind !== 'antseed-verifier-ipfs-publication' || typeof publication.evidencePath !== 'string') {
    throw new Error(`${source} is not an Antseed verifier publication`)
  }
  const evidencePath = safeRelativePath(publication.evidencePath)
  const evidence = await fetchJson<AuditEvidence>(evidencePath)
  if (evidence.kind !== 'antseed-verifier-model-audit-evidence' || typeof evidence.model !== 'string') {
    throw new Error(`${source} does not contain model audit evidence`)
  }
  const evidenceHash = canonicalHashBytes32(evidence)
  for (const expected of [options.evidenceHash, publication.evidenceHash]) {
    if (typeof expected === 'string' && expected.toLowerCase() !== evidenceHash.toLowerCase()) {
      throw new Error(`audit evidence hash ${evidenceHash} does not match expected ${expected}`)
    }
  }

  const candidates = (evidence.references ?? [])
    .filter((entry): entry is { referenceId: string; probeCount: number; path: string } =>
      typeof entry.path === 'string' && typeof entry.probeCount === 'number' && typeof entry.referenceId === 'string')
    .sort((left, right) => right.probeCount - left.probeCount || left.referenceId.localeCompare(right.referenceId))
  const selected = candidates[0]
  if (!selected) throw new Error(`${source} does not publish any KBF reference`)

  const evidenceDirectory = evidencePath.includes('/') ? evidencePath.slice(0, evidencePath.lastIndexOf('/')) : ''
  const referencePath = safeRelativePath(evidenceDirectory ? `${evidenceDirectory}/${selected.path}` : selected.path)
  const reference = await loadReference(`ipfs://${cid}/${referencePath}`, options)
  if (reference.referenceId !== selected.referenceId) {
    throw new Error(`published reference ${reference.referenceId} does not match evidence entry ${selected.referenceId}`)
  }
  return { cid, evidenceHash, model: evidence.model, reference }
}

function parseCid(source: string): string {
  const cid = source.trim().replace(/^ipfs:\/\//, '').replace(/\/+$/, '')
  if (!/^[A-Za-z0-9]+$/.test(cid)) throw new Error(`invalid audit source "${source}" (expected ipfs://<cid>)`)
  return cid
}

/** Resolves `.`/`..` segments and rejects paths that escape the publication root. */
function safeRelativePath(path: string): string {
  const segments: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) throw new Error(`publication path escapes its root: ${path}`)
      segments.pop()
      continue
    }
    segments.push(encodeURIComponent(segment))
  }
  if (segments.length === 0) throw new Error(`empty publication path: ${path}`)
  return segments.join('/')
}
