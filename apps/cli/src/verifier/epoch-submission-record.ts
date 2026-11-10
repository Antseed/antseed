import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readJsonIfExists, writeJsonAtomic } from './atomic-files.js'
import { epochDirectory } from './audit-artifacts.js'
import { epochRunManifests } from './epoch-overview.js'
import { epochSubmissionRunId } from './epoch-plan.js'
import { modelAuditsDirectory } from './model-audit.js'

/**
 * Which of an epoch's runs `verifier submit` has fully submitted, so the next epoch can say when the
 * last results of this one never reached the chain. The contract only takes results in the epoch
 * they were audited in, so a run that finished after the epoch's last successful submit is lost at
 * the boundary. Before this record, the next submit only said "Nothing to submit".
 */
interface SubmittedRunsV1 {
  version: 1
  epoch: string
  /** Runs whose results a submit sent (or found on-chain) with no failure. */
  runIds: string[]
  /** Set once the next epoch has warned about the runs missing here, so the warning is printed once. */
  unsentReportedAt?: string
}

function recordPath(evidenceDir: string, epoch: string): string {
  return join(epochDirectory(evidenceDir, epoch), 'submission', 'submitted-runs.json')
}

/** Adds `runIds` to the epoch's fully submitted runs. */
export async function recordSubmittedRuns(evidenceDir: string, epoch: string, runIds: readonly string[]): Promise<void> {
  const path = recordPath(evidenceDir, epoch)
  const current = await readJsonIfExists<SubmittedRunsV1>(path)
  const known = new Set(current?.runIds ?? [])
  if (runIds.every((runId) => known.has(runId))) return
  for (const runId of runIds) known.add(runId)
  await writeJsonAtomic(path, { ...current, version: 1, epoch, runIds: [...known].sort() } satisfies SubmittedRunsV1)
}

export interface UnsentEpochRuns {
  epoch: string
  /** Completed runs of the epoch that no successful submit covered. */
  runIds: string[]
  lastCompletedAt: string
}

/**
 * The completed runs of `epoch` that no successful submit covered, or null when there are none or
 * they were already reported. A data dir from a CLI that did not keep the record yet counts as
 * covered when the epoch's merged submission has a ledger with every model submitted.
 */
export async function unsentEpochRuns(evidenceDir: string, epoch: string): Promise<UnsentEpochRuns | null> {
  const manifests = await epochRunManifests(evidenceDir, epoch)
  if (manifests.length === 0) return null
  const record = await readJsonIfExists<SubmittedRunsV1>(recordPath(evidenceDir, epoch))
  if (record?.unsentReportedAt) return null
  const covered = new Set(record?.runIds ?? [])
  const missing = manifests.filter((manifest) => !covered.has(manifest.runId))
  if (missing.length === 0) return null
  if (!record && await mergedSubmissionComplete(evidenceDir, epoch, manifests.map((manifest) => manifest.runId))) return null
  return {
    epoch,
    runIds: missing.map((manifest) => manifest.runId),
    lastCompletedAt: missing.at(-1)!.completedAt,
  }
}

/** Marks the epoch's unsent runs as reported, so the warning is not repeated every watch tick. */
export async function markUnsentReported(evidenceDir: string, epoch: string, now = new Date()): Promise<void> {
  const path = recordPath(evidenceDir, epoch)
  const current = await readJsonIfExists<SubmittedRunsV1>(path)
  await writeJsonAtomic(path, {
    version: 1, epoch, runIds: current?.runIds ?? [], unsentReportedAt: now.toISOString(),
  } satisfies SubmittedRunsV1)
}

/** What `verifier submit` prints in the next epoch about runs that were never submitted. */
export function unsentEpochRunsMessage(unsent: UnsentEpochRuns): string {
  const runs = unsent.runIds.map((runId) => runId.slice(0, 10)).join(', ')
  return `Epoch ${unsent.epoch} ended before ${unsent.runIds.length} of its run(s) were submitted (${runs}; the last finished ${unsent.lastCompletedAt}). `
    + 'The contract only takes results in the epoch they were audited in, so whatever those runs found that was not already on-chain is lost. '
    + 'Keep `verifier watch` running through the end of an epoch, or run `verifier submit` before it ends. This is reported once.'
}

async function mergedSubmissionComplete(evidenceDir: string, epoch: string, runIds: readonly string[]): Promise<boolean> {
  const directory = modelAuditsDirectory(evidenceDir, epochSubmissionRunId(epoch, runIds))
  let names: string[]
  try {
    names = await readdir(directory)
  } catch {
    return false
  }
  for (const name of names) {
    if (!name.startsWith('ledger-') || !name.endsWith('.json')) continue
    const ledger = await readJsonIfExists<{ models?: Record<string, { status?: string }> }>(join(directory, name)).catch(() => null)
    const entries = Object.values(ledger?.models ?? {})
    if (entries.length > 0 && entries.every((entry) => entry.status === 'submitted')) return true
  }
  return false
}
