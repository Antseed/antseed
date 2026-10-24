import { getAddress } from 'ethers'

export type AuditAssignmentStrategy = 'all'

export interface AuditAssignmentInput {
  auditor: string
  epoch: string
  availableModels: readonly string[]
}

export interface AuditAssignment {
  auditor: string
  epoch: string
  strategy: AuditAssignmentStrategy
  models: string[]
}

/**
 * Decides which models an auditor audits in an epoch. Assignment is off-chain only: the contract
 * credits any approved auditor's model audits, so the rotation can change without a redeploy.
 *
 * Today every auditor is assigned every audited model ('all').
 *
 * Planned rotation, kept deterministic so anyone can recompute and check an assignment:
 * - Candidates: the top-N popular text models of the previous on-chain epoch that are served by at
 *   least two sellers (popularity from on-chain or indexer volume).
 * - Rank candidates per auditor by keccak256(auditor, epoch, model) and take the k lowest, so each
 *   auditor gets a different, evenly rotating slice and covers every model over a rotation period.
 * - Pick k from a replication factor r (k = ceil(r * candidates / auditors)) so every model has at
 *   least r auditors per epoch. A single DIFF counts on-chain, so each auditor double-checks its own
 *   DIFF results before submitting (see `model-run.ts`).
 */
export function assignAuditModels(input: AuditAssignmentInput): AuditAssignment {
  const epoch = input.epoch.trim()
  if (!epoch) throw new Error('audit assignment requires an epoch')
  const seen = new Set<string>()
  const models: string[] = []
  for (const value of input.availableModels) {
    const model = value.trim()
    const key = model.toLowerCase()
    if (!model || seen.has(key)) continue
    seen.add(key)
    models.push(model)
  }
  models.sort((left, right) => left.localeCompare(right))
  return { auditor: getAddress(input.auditor.trim()), epoch, strategy: 'all', models }
}
