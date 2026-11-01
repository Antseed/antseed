import type { CommitmentEvent } from '@antseed/node/payments'
import { mapConcurrently } from '../audit-concurrency.js'
import { parseSliceManifest } from './manifest-check.js'
import { sliceCollectors } from './plan.js'
import type { CommittedManifest } from './scoring.js'
import { ROUND_FILE_MAX_BYTES, RoundFileMismatchError, type RoundStorage } from './storage.js'
import type { RoundTargetV1 } from './types.js'

/**
 * What fetching one committed slice manifest gave: the validated manifest, bytes that can never
 * be the committed ones (`mismatch`), a fetch that may succeed later (`unavailable`), or
 * committed bytes that are not an acceptable slice manifest (`invalid`). Callers decide what
 * each means for their phase.
 */
export type ManifestLoad =
  | { kind: 'loaded'; manifest: CommittedManifest }
  | { kind: 'mismatch' | 'unavailable'; error: unknown }
  | { kind: 'invalid'; reason: string }

/** Parallel downloads per pass, so unavailable files do not add up their gateway timeouts. */
export const MANIFEST_FETCH_CONCURRENCY = 8

/**
 * Most bytes one collected exchange can take in a manifest: the base64 request (at most ten
 * bounded question lines plus the prompt), the base64 non-streamed response (at most the
 * reference's output-token ceiling) and the seller's signed record.
 */
export const MANIFEST_EXCHANGE_MAX_BYTES = 1024 * 1024
/** JSON tokens (`{`, `[`, `,`, `:`) one exchange needs, with room to spare. */
const EXCHANGE_MAX_TOKENS = 64
/** Bytes and tokens of the manifest's own fields and each slice's wrapper. */
const MANIFEST_BASE_BYTES = 64 * 1024
const MANIFEST_BASE_TOKENS = 64
const SLICE_MAX_TOKENS = 16

/** How large a collector's manifest may be, from the work the seed gives it. */
export interface ManifestBudget {
  maxBytes: number
  maxTokens: number
}

/** Public round data every manifest budget is derived from. */
export interface ManifestBudgetInput {
  verifiers: readonly string[]
  seed: string
  targets: readonly RoundTargetV1[]
  probesPerService: number
  slicesPerService: number
}

/**
 * Every collector's primary and backup manifest budgets, derived only from public round data (the
 * verifier snapshot, the seed, the plan file's targets and the schedule), so every verifier
 * computes the same ones: a collector's assigned slices, each with at most `ceil(probes / slices)`
 * batches. The seeded assignments are derived once for all collectors.
 */
export function manifestBudgets(input: ManifestBudgetInput): (collector: string, backup: boolean) => ManifestBudget {
  const counts = new Map<string, number>()
  const keyFor = (collector: string, backup: boolean) => `${collector.toLowerCase()}|${backup}`
  const increment = (collector: string, backup: boolean) => counts.set(keyFor(collector, backup), (counts.get(keyFor(collector, backup)) ?? 0) + 1)
  for (const target of input.targets) {
    for (let sliceIndex = 0; sliceIndex < input.slicesPerService; sliceIndex += 1) {
      const { owner, backup } = sliceCollectors(input.verifiers, input.seed, target, sliceIndex)
      increment(owner, false)
      if (backup !== owner) increment(backup, true)
    }
  }
  return (collector, backup) => manifestBudgetForSlices(counts.get(keyFor(collector, backup)) ?? 0, input.probesPerService, input.slicesPerService)
}

/** The budget for one collector's primary or backup manifest (see `manifestBudgets`). */
export function manifestBudget(input: ManifestBudgetInput & { collector: string; backup: boolean }): ManifestBudget {
  return manifestBudgets(input)(input.collector, input.backup)
}

function manifestBudgetForSlices(slices: number, probesPerService: number, slicesPerService: number): ManifestBudget {
  const exchanges = slices * Math.ceil(probesPerService / Math.max(1, slicesPerService))
  return {
    maxBytes: Math.min(ROUND_FILE_MAX_BYTES.slices, MANIFEST_BASE_BYTES + exchanges * MANIFEST_EXCHANGE_MAX_BYTES),
    maxTokens: MANIFEST_BASE_TOKENS + slices * SLICE_MAX_TOKENS + exchanges * EXCHANGE_MAX_TOKENS,
  }
}

/**
 * Counts JSON structure tokens outside strings, stopping once past `limit`. A manifest with
 * more than its budget allows is refused before `JSON.parse`, so a file of millions of tiny
 * objects never becomes millions of objects in memory.
 */
export function exceedsJsonTokens(bytes: Uint8Array, limit: number): boolean {
  let tokens = 0
  let inString = false
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index]!
    if (inString) {
      if (byte === 0x5c) index += 1 // backslash: skip the escaped byte
      else if (byte === 0x22) inString = false
      continue
    }
    if (byte === 0x22) inString = true
    else if (byte === 0x7b || byte === 0x5b || byte === 0x2c || byte === 0x3a) {
      tokens += 1
      if (tokens > limit) return true
    }
  }
  return false
}

export async function loadCommittedManifest(
  storage: RoundStorage,
  commit: CommitmentEvent,
  budget: ManifestBudget,
  signal?: AbortSignal,
): Promise<ManifestLoad> {
  let bytes: Buffer
  try {
    bytes = await storage.get(commit.uri, commit.hash, budget.maxBytes, signal)
  } catch (error) {
    return { kind: error instanceof RoundFileMismatchError ? 'mismatch' : 'unavailable', error }
  }
  // The bytes match the commitment, so every verifier judges them the same way from here on.
  if (exceedsJsonTokens(bytes, budget.maxTokens)) return { kind: 'invalid', reason: 'more JSON structure than its assigned slices allow' }
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    return { kind: 'invalid', reason: 'not JSON' }
  }
  const manifest = parseSliceManifest(value)
  if (!manifest) return { kind: 'invalid', reason: 'not a slice manifest' }
  return { kind: 'loaded', manifest: { collector: commit.sender.toLowerCase(), backup: commit.backup, uri: commit.uri, manifest } }
}

/**
 * Loads `commits` a few at a time, in order, keeping only validated manifests. Once `signal`
 * aborts, the rest count as unavailable, so a phase's remaining time bounds the whole pass
 * however many files cannot be fetched.
 */
export async function loadCommittedManifests(
  storage: RoundStorage,
  commits: readonly CommitmentEvent[],
  budgetFor: (commit: CommitmentEvent) => ManifestBudget,
  signal?: AbortSignal,
): Promise<Array<{ commit: CommitmentEvent; load: ManifestLoad }>> {
  return mapConcurrently(commits, MANIFEST_FETCH_CONCURRENCY, async (commit) => ({
    commit,
    load: await loadCommittedManifest(storage, commit, budgetFor(commit), signal),
  }))
}
