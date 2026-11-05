import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { readJsonIfExists, writeJsonAtomic } from './atomic-files.js'
import { epochDirectory } from './audit-artifacts.js'
import type { EpochState } from './epoch-plan.js'
import { epochCellKey } from './epoch-plan.js'
import { safeServiceSlug } from './slug.js'
import { normalized } from './utils.js'

/**
 * Audit windows: each auditor audits each of its models once per epoch. The first run of a model
 * in the epoch opens its window and fixes its sellers (the eligible ones it found); later runs only
 * finish those sellers: their retries (`SELLER_FAILURE_ATTEMPTS`, `AUDITOR_FAILURE_ATTEMPTS`, spaced
 * like before) and their close calls' extra questions. A seller that turns up later gets no result
 * this epoch. Once none of the window's sellers has anything left, the window closes and
 * `verifier submit` sends the model's results together; nothing is submitted while it is open, so
 * the epoch's questions are not published before every seller has been asked them.
 *
 * Confirmations of other auditors' DIFFs are not windowed: they are audited and submitted as before.
 */
export interface AuditWindowV1 {
  version: 1
  kind: 'antseed-verifier-audit-window'
  epoch: string
  model: string
  state: 'open' | 'closed'
  openedAt: string
  openedByRunId: string
  /** The sellers the window audits, fixed when it opens. */
  sellers: string[]
  closedAt?: string
  closeReason?: string
}

/** No window opens, and every open one closes, with less than this left in the epoch, so there is time to submit. */
export const MIN_SECONDS_FOR_ANOTHER_ROUND = 45 * 60

export function auditWindowPath(evidenceDir: string, epoch: string, model: string): string {
  return join(epochDirectory(evidenceDir, epoch), 'windows', `${safeServiceSlug(model)}.json`)
}

export async function readAuditWindow(evidenceDir: string, epoch: string, model: string): Promise<AuditWindowV1 | null> {
  const value = await readJsonIfExists<AuditWindowV1>(auditWindowPath(evidenceDir, epoch, model))
  if (!value) return null
  if (value.version !== 1 || value.kind !== 'antseed-verifier-audit-window' || value.epoch !== epoch
    || normalized(value.model) !== normalized(model) || !Array.isArray(value.sellers)) {
    throw new Error(`invalid audit window for ${model} epoch ${epoch}`)
  }
  return value
}

export async function listAuditWindows(evidenceDir: string, epoch: string): Promise<AuditWindowV1[]> {
  let names: string[]
  try {
    names = await readdir(join(epochDirectory(evidenceDir, epoch), 'windows'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const windows: AuditWindowV1[] = []
  for (const name of names.filter((entry) => entry.endsWith('.json')).sort()) {
    const value = await readJsonIfExists<AuditWindowV1>(join(epochDirectory(evidenceDir, epoch), 'windows', name))
    if (value?.kind === 'antseed-verifier-audit-window' && value.epoch === epoch) windows.push(value)
  }
  return windows
}

/** Opens the model's window with `sellers`; an existing window (open or closed) is kept as it is. */
export async function openAuditWindow(input: {
  evidenceDir: string
  epoch: string
  model: string
  runId: string
  sellers: readonly string[]
  now?: () => number
}): Promise<AuditWindowV1> {
  const existing = await readAuditWindow(input.evidenceDir, input.epoch, input.model)
  if (existing) return existing
  const window: AuditWindowV1 = {
    version: 1,
    kind: 'antseed-verifier-audit-window',
    epoch: input.epoch,
    model: input.model,
    state: 'open',
    openedAt: new Date(input.now?.() ?? Date.now()).toISOString(),
    openedByRunId: input.runId,
    sellers: [...new Set(input.sellers.map(normalizePeer))].sort(),
  }
  await writeJsonAtomic(auditWindowPath(input.evidenceDir, input.epoch, input.model), window)
  return window
}

/** Whether the window audits this seller. */
export function windowIncludesSeller(window: Pick<AuditWindowV1, 'sellers'>, peerId: string): boolean {
  return window.sellers.includes(normalizePeer(peerId))
}

/**
 * The window's sellers that still have something left: a retry or a close call's extra questions,
 * or no result yet while no run of the window has completed (its first run was interrupted). A
 * seller still without a result after a completed run was not reachable again, and is done.
 */
export function auditWindowSellersLeft(window: AuditWindowV1, state: Pick<EpochState, 'cells' | 'manifests'>): string[] {
  const completedRun = state.manifests.some((manifest) => (
    Date.parse(manifest.startedAt) >= Date.parse(window.openedAt) - 1_000
    && manifest.modelOrder.some((model) => normalized(model) === normalized(window.model))
  )) || state.manifests.some((manifest) => manifest.runId === window.openedByRunId)
  return window.sellers.filter((peerId) => {
    const cell = state.cells.get(epochCellKey(window.model, peerId))
    if (!cell) return !completedRun
    return cell.action === 'retry' || cell.action === 'extend'
  })
}

/**
 * Closes every open window of the epoch whose sellers have nothing left, and, with less than
 * `MIN_SECONDS_FOR_ANOTHER_ROUND` left in the epoch, every open window. Returns the windows it closed.
 */
export async function closeFinishedAuditWindows(input: {
  evidenceDir: string
  epoch: string
  state: Pick<EpochState, 'cells' | 'manifests'>
  secondsLeftInEpoch: number
  now?: () => number
}): Promise<AuditWindowV1[]> {
  const closed: AuditWindowV1[] = []
  for (const window of await listAuditWindows(input.evidenceDir, input.epoch)) {
    if (window.state !== 'open') continue
    const left = auditWindowSellersLeft(window, input.state)
    const reason = left.length === 0
      ? 'every seller of the window is finished'
      : input.secondsLeftInEpoch < MIN_SECONDS_FOR_ANOTHER_ROUND
        ? `the epoch is nearly over; ${left.length} seller(s) left undecided`
        : null
    if (!reason) continue
    const next: AuditWindowV1 = { ...window, state: 'closed', closedAt: new Date(input.now?.() ?? Date.now()).toISOString(), closeReason: reason }
    await writeJsonAtomic(auditWindowPath(input.evidenceDir, input.epoch, window.model), next)
    closed.push(next)
  }
  return closed
}

function normalizePeer(peerId: string): string {
  return peerId.trim().replace(/^0x/i, '').toLowerCase()
}
