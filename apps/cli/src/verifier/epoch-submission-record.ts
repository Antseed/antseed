import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readJsonIfExists, writeJsonAtomic } from './atomic-files.js'
import { epochDirectory } from './audit-artifacts.js'
import { epochRunManifests } from './epoch-overview.js'
import { epochSubmissionRunId } from './epoch-plan.js'
import { modelAuditsDirectory } from './model-audit.js'

/**
 * What `verifier submit` last left unsent in an epoch, so the next epoch can say when results of this
 * one never reached the chain. The contract only takes results in the epoch they were audited in, so
 * whatever is not sent by the epoch's end is lost. Before this record, the next submit only said
 * "Nothing to submit".
 *
 * Two things are kept: the runs a submit covered completely (everything sent or already on-chain,
 * nothing failed, nothing held back for later in the epoch), and what the latest submit left unsent.
 */
interface SubmittedRunsV1 {
  version: 1
  epoch: string
  /** Runs whose results a complete submit covered. */
  runIds: string[]
  /** What the latest submit did not send (failed, held for a re-check, or held back for later in the epoch); absent once a submit sends everything. */
  outstanding?: { at: string; items: string[] }
  /** Set once the next epoch has warned, so the warning is printed once. */
  unsentReportedAt?: string
}

function recordPath(evidenceDir: string, epoch: string): string {
  return join(epochDirectory(evidenceDir, epoch), 'submission', 'submitted-runs.json')
}

/**
 * Records a submit of `runIds`. With nothing `outstanding` the runs are covered; otherwise the
 * submit's unsent items replace the previous ones and the runs are not covered.
 */
export async function recordSubmitOutcome(
  evidenceDir: string, epoch: string, runIds: readonly string[], outstanding: readonly string[], now = new Date(),
): Promise<void> {
  const path = recordPath(evidenceDir, epoch)
  const current = await readJsonIfExists<SubmittedRunsV1>(path).catch(() => null)
  const covered = new Set(current?.runIds ?? [])
  if (outstanding.length === 0) for (const runId of runIds) covered.add(runId)
  const next: SubmittedRunsV1 = {
    version: 1,
    epoch,
    runIds: [...covered].sort(),
    ...(outstanding.length > 0 ? { outstanding: { at: now.toISOString(), items: [...outstanding] } } : {}),
    ...(current?.unsentReportedAt ? { unsentReportedAt: current.unsentReportedAt } : {}),
  }
  if (JSON.stringify(next) === JSON.stringify(current)) return
  await writeJsonAtomic(path, next)
}

/** `recordSubmitOutcome` with nothing outstanding. */
export async function recordSubmittedRuns(evidenceDir: string, epoch: string, runIds: readonly string[]): Promise<void> {
  await recordSubmitOutcome(evidenceDir, epoch, runIds, [])
}

export interface UnsentEpochRuns {
  epoch: string
  /** Completed runs of the epoch that no complete submit covered. */
  runIds: string[]
  lastCompletedAt: string | null
  /** What the epoch's latest submit left unsent, when it left something. */
  outstanding: { at: string; items: string[] } | null
}

/**
 * What of `epoch` may never have reached the chain, or null when everything was covered or it was
 * already reported. A data dir from a CLI that did not keep the record yet counts as covered when the
 * epoch's merged submission has a ledger with every model submitted.
 */
export async function unsentEpochRuns(evidenceDir: string, epoch: string): Promise<UnsentEpochRuns | null> {
  const manifests = await epochRunManifests(evidenceDir, epoch)
  if (manifests.length === 0) return null
  const record = await readJsonIfExists<SubmittedRunsV1>(recordPath(evidenceDir, epoch)).catch(() => null)
  if (record?.unsentReportedAt) return null
  const covered = new Set(record?.runIds ?? [])
  const missing = manifests.filter((manifest) => !covered.has(manifest.runId))
  const outstanding = record?.outstanding && record.outstanding.items.length > 0 ? record.outstanding : null
  if (missing.length === 0 && !outstanding) return null
  if (!record && await mergedSubmissionComplete(evidenceDir, epoch, manifests.map((manifest) => manifest.runId))) return null
  return {
    epoch,
    runIds: missing.map((manifest) => manifest.runId),
    lastCompletedAt: missing.at(-1)?.completedAt ?? null,
    outstanding,
  }
}

/** Marks the epoch as reported, so the warning is not repeated every watch tick. */
export async function markUnsentReported(evidenceDir: string, epoch: string, now = new Date()): Promise<void> {
  const path = recordPath(evidenceDir, epoch)
  const current = await readJsonIfExists<SubmittedRunsV1>(path).catch(() => null)
  await writeJsonAtomic(path, {
    ...current, version: 1, epoch, runIds: current?.runIds ?? [], unsentReportedAt: now.toISOString(),
  } satisfies SubmittedRunsV1)
}

/** What `verifier submit` prints in the next epoch about results of this one that never reached the chain. */
export function unsentEpochRunsMessage(unsent: UnsentEpochRuns): string {
  const parts = [`Epoch ${unsent.epoch} ended with results that may never have reached the chain, and those are lost: the contract only takes results in the epoch they were audited in.`]
  if (unsent.outstanding) {
    const shown = unsent.outstanding.items.slice(0, 5).join('; ')
    const more = unsent.outstanding.items.length > 5 ? `; and ${unsent.outstanding.items.length - 5} more` : ''
    parts.push(`Its last submit (${unsent.outstanding.at}) did not send: ${shown}${more}.`)
  }
  if (unsent.runIds.length > 0) {
    const runs = unsent.runIds.map((runId) => runId.slice(0, 10)).join(', ')
    parts.push(`${unsent.runIds.length} run(s) were not covered by a submit that sent everything (${runs}${unsent.lastCompletedAt ? `; the last finished ${unsent.lastCompletedAt}` : ''}).`)
  }
  parts.push('Keep `verifier watch` running through the end of an epoch, or run `verifier submit` before it ends. This is reported once.')
  return parts.join(' ')
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
