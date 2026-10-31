import type { CommitmentEvent } from '@antseed/node/payments'
import type { CommittedManifest } from './scoring.js'
import { ROUND_FILE_MAX_BYTES, RoundFileMismatchError, type RoundStorage } from './storage.js'
import type { SliceManifestV1 } from './types.js'

/**
 * What fetching one committed slice manifest gave: the parsed manifest, bytes that can never be
 * the committed ones (`mismatch`), a fetch that may succeed later (`unavailable`), or bytes that
 * are not JSON. Callers decide what each means for their phase.
 */
export type ManifestLoad =
  | { kind: 'loaded'; manifest: CommittedManifest }
  | { kind: 'mismatch' | 'unavailable'; error: unknown }
  | { kind: 'not-json' }

/** Parallel downloads per pass, so unavailable files do not add up their gateway timeouts. */
export const MANIFEST_FETCH_CONCURRENCY = 8

export async function loadCommittedManifest(storage: RoundStorage, commit: CommitmentEvent, signal?: AbortSignal): Promise<ManifestLoad> {
  let bytes: Buffer
  try {
    bytes = await storage.get(commit.uri, commit.hash, ROUND_FILE_MAX_BYTES.slices, signal)
  } catch (error) {
    return { kind: error instanceof RoundFileMismatchError ? 'mismatch' : 'unavailable', error }
  }
  try {
    const manifest = JSON.parse(bytes.toString('utf8')) as SliceManifestV1
    return { kind: 'loaded', manifest: { collector: commit.sender.toLowerCase(), backup: commit.backup, uri: commit.uri, manifest } }
  } catch {
    return { kind: 'not-json' }
  }
}

/**
 * Loads `commits` a few at a time, in order. Once `signal` aborts, the rest count as unavailable,
 * so a phase's remaining time bounds the whole pass however many files cannot be fetched.
 */
export async function loadCommittedManifests(
  storage: RoundStorage,
  commits: readonly CommitmentEvent[],
  signal?: AbortSignal,
): Promise<Array<{ commit: CommitmentEvent; load: ManifestLoad }>> {
  const loads = new Array<ManifestLoad>(commits.length)
  let next = 0
  const worker = async () => {
    while (next < commits.length) {
      const index = next++
      loads[index] = await loadCommittedManifest(storage, commits[index]!, signal)
    }
  }
  await Promise.all(Array.from({ length: Math.min(MANIFEST_FETCH_CONCURRENCY, commits.length) }, worker))
  return commits.map((commit, index) => ({ commit, load: loads[index]! }))
}
