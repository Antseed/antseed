import { closeFinishedAuditWindows, type AuditWindowV1 } from './audit-window.js'
import { AUDITOR_FAILURE_ATTEMPTS, SELLER_FAILURE_ATTEMPTS, SELLER_RETRY_SPACING_SECONDS, epochCellKey, type EpochCell, type EpochState } from './epoch-plan.js'
import { auditFinishedAt } from './model-audit.js'

/**
 * First looks whose result submit would refuse (its evidence cannot be read or has no valid date) and that still have
 * attempts left, the seller's and the auditor's: by `epochCellKey`. They are audited again, and their window stays
 * open, so a SAME or DIFF is not left unsent all epoch. A seller that a completed run of the model, started after its
 * last attempt, did not plan (it no longer offers the model, or another auditor judged it) is no longer waited for:
 * its window would otherwise stay open until the end of the epoch, holding the model's other results.
 */
export async function recoveringFirstLooks(state: Pick<EpochState, 'ordinaryCells' | 'manifests'> | null): Promise<Map<string, EpochCell>> {
  const recovering = new Map<string, EpochCell>()
  for (const cell of state?.ordinaryCells?.values() ?? []) {
    // Given up (its seller no longer offers the model, `decideRetryGiveUps`): no longer waited for.
    if (!cell.result || cell.action !== 'done' || cell.confirmationReport !== undefined || cell.givenUp) continue
    if (cell.attempts >= SELLER_FAILURE_ATTEMPTS || cell.auditorAttempts >= AUDITOR_FAILURE_ATTEMPTS) continue
    // Passed over: a completed run of the model, not limited to some sellers and no `--resume-run` repair (which audits
    // only another run's undetermined sellers), that started once the seller was due again (after its retry spacing)
    // and still did not audit it.
    const lastAttemptAt = cell.lastAttemptAt
    const passedOver = lastAttemptAt !== null && (state?.manifests ?? []).some((manifest) => manifest.runId !== cell.runId
      && manifest.state !== 'running' && manifest.selection === undefined && manifest.repairOf === undefined
      && Date.parse(manifest.startedAt) / 1_000 >= lastAttemptAt + SELLER_RETRY_SPACING_SECONDS
      // The model ran to its summary in that run: one only planned (a failed build, a run stopped first) passed nobody.
      && manifest.models.some((entry) => entry.model.toLowerCase() === cell.model.toLowerCase())
      // A run that audited the model only for its confirmations never considered its other sellers.
      && !(manifest.confirmationOnly ?? []).some((model) => model.toLowerCase() === cell.model.toLowerCase()))
    if (passedOver) continue
    if (await auditFinishedAt(cell.result) === null) recovering.set(epochCellKey(cell.model, cell.peerId), cell)
  }
  return recovering
}

/**
 * Closes the epoch's finished windows as `closeFinishedAuditWindows` does, with the first looks still to be recovered
 * counted as left: the one close `verifier run` and `verifier submit` (and its publication) both make.
 */
export async function closeFinishedWindowsRecovering(input: {
  evidenceDir: string
  epoch: string
  state: Pick<EpochState, 'cells' | 'manifests' | 'ordinaryCells'>
  secondsLeftInEpoch: number
}): Promise<AuditWindowV1[]> {
  return closeFinishedAuditWindows({ ...input, recovering: new Set((await recoveringFirstLooks(input.state)).keys()) })
}
