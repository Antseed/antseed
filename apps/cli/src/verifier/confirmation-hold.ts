import { modelHash, serviceHash } from '@antseed/node/payments'
import { MIN_SECONDS_FOR_ANOTHER_ROUND, notStartedForReference } from './audit-window.js'
import {
  AUDITOR_FAILURE_ATTEMPTS,
  CONFIRMATION_ATTEMPTS,
  CONFIRMATION_RECHECK_SPACING_SECONDS,
  epochCellKey,
  type EpochCell,
  type EpochState,
} from './epoch-plan.js'
import { opinionKey } from './third-opinion.js'

/**
 * Whether a cell is a confirmation that has started (an attempt of it finished) and waits to be audited again: the
 * plan audits it again (`retry`, after `CONFIRMATION_RECHECK_SPACING_SECONDS`, within `CONFIRMATION_ATTEMPTS`) or asks
 * its extra questions (`extend`). It waits for nothing once given up (its seller no longer offers the model), after
 * `AUDITOR_FAILURE_ATTEMPTS` failures of the auditor's own (which never count toward a report's attempts, so they would
 * hold it to the end of the epoch), or when it was not started for its FLIPS reference (nothing was asked, as the audit
 * window reads it, `notStartedForReference`).
 */
export function confirmationAwaitingReaudit(cell: EpochCell): boolean {
  if (cell.givenUp || cell.lastAttemptAt === null || notStartedForReference(cell)) return false
  if (cell.auditorAttempts >= AUDITOR_FAILURE_ATTEMPTS) return false
  if (cell.action === 'extend') return cell.pending?.confirmsDiff === true
  if (cell.action !== 'retry') return false
  const confirmation = cell.confirmationReport !== undefined || cell.result?.confirmsDiff === true
  return confirmation && cell.attempts < CONFIRMATION_ATTEMPTS
}

/**
 * The key of a cell's report as the contract names it (`opinionKey`: agent, service hash, model hash), matched against
 * the waiting reports whose confirmer this auditor still is; null for a cell that names no agent or service.
 */
export function confirmationTurnKey(cell: Pick<EpochCell, 'model' | 'agentId' | 'service'>): string | null {
  if (cell.agentId === undefined || cell.service === undefined) return null
  return opinionKey(cell.agentId, serviceHash(cell.service), modelHash(cell.model))
}

/**
 * Whether a completed run of the model passed the confirmation over: one started once its re-audit was due (after
 * `CONFIRMATION_RECHECK_SPACING_SECONDS`) that ran the model to its summary and did not audit the seller (an attempt
 * would have moved its last attempt past the run's start). `verifier run` drops a report whose turn has passed or that
 * is settled, and `--no-confirm` audits none, so no later run will audit it either. A run limited to some sellers or a
 * `--resume-run` repair considered no confirmation.
 */
function passedOver(cell: EpochCell, manifests: EpochState['manifests']): boolean {
  const lastAttemptAt = cell.lastAttemptAt
  if (lastAttemptAt === null) return false
  return manifests.some((manifest) => manifest.state !== 'running' && manifest.selection === undefined && manifest.repairOf === undefined
    && Date.parse(manifest.startedAt) / 1_000 >= lastAttemptAt + CONFIRMATION_RECHECK_SPACING_SECONDS
    && manifest.models.some((entry) => entry.model.toLowerCase() === cell.model.toLowerCase()))
}

/**
 * The confirmations each model's submit is held for, by model in lower case: a model's results are not sent while a
 * confirmation of it that has started waits to be audited again (`confirmationAwaitingReaudit`), since their evidence
 * would publish the model's questions, which would be an answer key to the confirmation's next attempt. Held only for a
 * report that is still this auditor's confirmation turn and not settled (`stillMine`; null when that could not be read,
 * and every waiting confirmation holds), and that no later run passed over (`passedOver`). As the audit window holds
 * first looks: nothing is held once the epoch is too near its end for another round (`MIN_SECONDS_FOR_ANOTHER_ROUND`).
 */
export function confirmationsHoldingSubmit(input: {
  state: Pick<EpochState, 'cells' | 'reportCells' | 'manifests'>
  secondsLeftInEpoch: number
  stillMine: ((cell: EpochCell) => boolean) | null
}): Map<string, EpochCell[]> {
  const held = new Map<string, EpochCell[]>()
  if (input.secondsLeftInEpoch < MIN_SECONDS_FOR_ANOTHER_ROUND) return held
  const sellers = new Set<string>()
  for (const cell of [...input.state.reportCells?.values() ?? [], ...input.state.cells.values()]) {
    if (!confirmationAwaitingReaudit(cell) || passedOver(cell, input.state.manifests)) continue
    if (input.stillMine && !input.stillMine(cell)) continue
    // One seller once: its report's cell and its latest cell are the same attempt.
    const seller = epochCellKey(cell.model, cell.peerId)
    if (sellers.has(seller)) continue
    sellers.add(seller)
    const model = cell.model.trim().toLowerCase()
    held.set(model, [...held.get(model) ?? [], cell])
  }
  return held
}

/** Why a model's submit is held for its waiting confirmations, or null when it is not (`confirmationsHoldingSubmit`). */
export function confirmationHoldReason(cells: readonly EpochCell[] | undefined): string | null {
  if (!cells || cells.length === 0) return null
  const attempts = cells.map((cell) => `${cell.peerId.slice(0, 12)} ${cell.action === 'extend' ? 'waiting for its extra questions' : `after attempt ${cell.attempts} of ${CONFIRMATION_ATTEMPTS}`}`)
  return `${cells.length} confirmation(s) of this model wait to be audited again (${attempts.join('; ')}): the model's results `
    + 'would publish the questions they are asked again, so they are sent together once those confirmations are decided, '
    + 'out of attempts, or the epoch is nearly over'
}
