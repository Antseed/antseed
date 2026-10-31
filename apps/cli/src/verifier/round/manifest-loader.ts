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

export async function loadCommittedManifest(storage: RoundStorage, commit: CommitmentEvent): Promise<ManifestLoad> {
  let bytes: Buffer
  try {
    bytes = await storage.get(commit.uri, commit.hash, ROUND_FILE_MAX_BYTES.slices)
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
