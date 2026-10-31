import { readFile } from 'node:fs/promises'
import { epochRunManifests, type ModelAuditSummaryV1 } from './audit-artifacts.js'
import { epochCellKey as pendingRecheckKey } from './epoch-plan.js'
import type { ModelVerificationTargetResult } from './model-run.js'
import { verifyProxyAuditEvidenceFile } from './proxy-evidence.js'

export interface PendingDiffRecheck {
  model: string
  runId: string
  result: ModelVerificationTargetResult
}

/** Same (model, seller) identity as the epoch plan's cells. */
export { pendingRecheckKey }

/**
 * First DIFFs from this epoch's earlier runs whose recheck could not run and that no later run has
 * settled. Runs are replayed oldest first and the latest result per (model, seller) wins, so a DIFF
 * that a later run rechecked, or re-audited as SAME, is no longer pending. The first check's
 * evidence must still verify against its recorded hash.
 */
export async function loadPendingDiffRechecks(
  evidenceDir: string,
  epoch: string,
  models: readonly string[],
): Promise<Map<string, PendingDiffRecheck>> {
  const wanted = new Set(models.map((model) => model.toLowerCase()))
  const latest = new Map<string, PendingDiffRecheck>()
  for (const manifest of await epochRunManifests(evidenceDir, epoch)) {
    for (const entry of manifest.models) {
      if (!wanted.has(entry.model.toLowerCase())) continue
      let summary: ModelAuditSummaryV1
      try {
        summary = JSON.parse(await readFile(entry.summaryPath, 'utf8')) as ModelAuditSummaryV1
      } catch {
        continue
      }
      if (summary.runId !== manifest.runId || summary.epoch !== epoch) continue
      for (const result of summary.results ?? []) {
        latest.set(pendingRecheckKey(entry.model, result.peerId), { model: entry.model, runId: manifest.runId, result })
      }
    }
  }
  const pending = new Map<string, PendingDiffRecheck>()
  for (const [key, entry] of latest) {
    if (entry.result.status !== 'DIFF' || entry.result.recheck || !entry.result.recheckPending) continue
    try {
      await verifyProxyAuditEvidenceFile(entry.result.evidencePath, entry.result.evidenceHash)
    } catch {
      continue
    }
    pending.set(key, entry)
  }
  return pending
}
