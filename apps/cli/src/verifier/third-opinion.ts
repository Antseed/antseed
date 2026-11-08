import { getAddress } from 'ethers'
import { VERIFIER_VERDICT, modelHash, serviceHash, type ServiceAuditedEvent, type VerifierVerdict } from '@antseed/node/payments'
import type { SubmissionCandidate } from './submission-delta.js'
import { normalized } from './utils.js'

/**
 * Never a third opinion: in one epoch a seller's service is judged by its model's assigned auditor
 * and, when that verdict is a DIFF, by one confirmer. Nobody else reports on it. The contract does not
 * enforce this (any approved auditor may report on any seller, and with `diffReplacementReports` at 1
 * a single later SAME clears a DIFF two auditors agreed on), so the CLI does: a returning auditor whose
 * model a stand-in already audited, a second stand-in, a manual `verifier run <model>` on someone
 * else's model, or a confirmation that another auditor settled while this run was going, are all left
 * out here. An UNDETERMINED is no opinion (it moves a confirmation on, see `pending-confirmations.ts`),
 * so it neither counts nor is blocked.
 *
 * Opinions are counted across report rounds: a recorded DIFF starts a new round on the contract, and
 * the next round having no reports does not make the seller free for a third auditor.
 */
export interface OtherOpinion {
  auditor: string
  verdict: VerifierVerdict
  /** Reports and reports needed at the auditor's latest event: `reports < required` is a waiting report. */
  reports: number
  required: number
  blockNumber: number
  logIndex: number
}

export function opinionKey(agentId: bigint | number | string, service: string, model: string): string {
  return `${agentId}:${normalized(service)}:${normalized(model)}`
}

/**
 * Other auditors' latest SAME or DIFF per (agent, service, model) this epoch, keyed by `opinionKey`
 * with service and model hashes. Reports by `auditor` itself and UNDETERMINED reports are left out.
 */
export function otherOpinions(events: readonly ServiceAuditedEvent[], auditor: string): Map<string, Map<string, OtherOpinion>> {
  const me = getAddress(auditor)
  const latest = new Map<string, Map<string, ServiceAuditedEvent>>()
  for (const event of events) {
    const who = getAddress(event.auditor)
    if (who === me) continue
    const key = opinionKey(event.agentId, event.serviceHash, event.modelHash)
    let byAuditor = latest.get(key)
    if (!byAuditor) {
      byAuditor = new Map()
      latest.set(key, byAuditor)
    }
    const current = byAuditor.get(who)
    if (current && (current.blockNumber > event.blockNumber
      || (current.blockNumber === event.blockNumber && current.logIndex > event.logIndex))) continue
    byAuditor.set(who, event)
  }
  const opinions = new Map<string, Map<string, OtherOpinion>>()
  for (const [key, byAuditor] of latest) {
    const entries = new Map<string, OtherOpinion>()
    for (const [who, event] of byAuditor) {
      if (event.verdict !== VERIFIER_VERDICT.SAME && event.verdict !== VERIFIER_VERDICT.DIFF) continue
      entries.set(who, {
        auditor: who, verdict: event.verdict, reports: event.reports, required: event.required,
        blockNumber: event.blockNumber, logIndex: event.logIndex,
      })
    }
    if (entries.size > 0) opinions.set(key, entries)
  }
  return opinions
}

/**
 * Why a result must not be sent, or null when it may: no other opinion yet (the first look), or
 * exactly one other opinion that is a DIFF still waiting for its confirmation and this result is that
 * confirmation (`confirmsDiff`, set by `verifier run` for the sellers the planner gave this auditor).
 */
export function thirdOpinionReason(
  opinions: ReadonlyMap<string, OtherOpinion> | undefined,
  candidate: Pick<SubmissionCandidate, 'confirmsDiff'>,
  /** True when this auditor is the rotation's current confirmer for the seller's waiting DIFF (`pendingConfirmations().mine`). */
  myConfirmation = false,
): string | null {
  if (!opinions || opinions.size === 0) return null
  const list = [...opinions.values()]
  const describe = (entry: OtherOpinion) => `${entry.verdict === VERIFIER_VERDICT.DIFF ? 'DIFF' : 'SAME'} by ${entry.auditor.slice(0, 10)}…`
  if (list.length === 1) {
    const [other] = list as [OtherOpinion]
    if (other.verdict === VERIFIER_VERDICT.DIFF && other.reports < other.required) {
      // The run flagged the result as this auditor's confirmation, or the rotation makes this auditor the
      // confirmer now (e.g. an owner whose stand-in reported first, its own window audited before that).
      if (candidate.confirmsDiff || myConfirmation) return null
      return `another auditor's DIFF waits for its confirmer (${describe(other)}); this result is not that confirmation, so it is not sent`
    }
    return `already judged this epoch (${describe(other)}); a seller gets one audit and, for a DIFF, one confirmation, never a second opinion on a SAME`
  }
  return `already has ${list.length} opinions this epoch (${list.map(describe).join(', ')}); never a third`
}

/**
 * The filter `prepareModelAudits` takes: one reason or null per candidate, from this epoch's
 * `ServiceAudited` events (`loadEpochAuditEvents`).
 */
export function thirdOpinionFilter(input: {
  events: readonly ServiceAuditedEvent[]
  auditor: string
  /** `opinionKey`s of the waiting DIFFs whose current confirmer is this auditor (`pendingConfirmations().mine`). */
  myConfirmations?: ReadonlySet<string>
}): (modelHashValue: string, candidates: readonly SubmissionCandidate[]) => Promise<Array<string | null>> {
  const opinions = otherOpinions(input.events, input.auditor)
  return async (modelHashValue, candidates) => candidates.map((candidate) => {
    const key = opinionKey(candidate.agentId, candidate.serviceHash, modelHashValue)
    return thirdOpinionReason(opinions.get(key), candidate, input.myConfirmations?.has(key) ?? false)
  })
}

/**
 * For `verifier run`'s planner: whether another auditor has already given a SAME or DIFF on the
 * seller's service under `model` this epoch (any of `services`), so the seller is not audited again
 * unless the planner made it a confirmation. Returns the reason, or null.
 */
export function alreadyJudgedByOther(
  opinions: ReadonlyMap<string, ReadonlyMap<string, OtherOpinion>>,
  agentId: bigint | number | string,
  services: readonly string[],
  model: string,
): string | null {
  for (const service of services) {
    const found = opinions.get(opinionKey(agentId, serviceHash(service), modelHash(model)))
    if (found && found.size > 0) return thirdOpinionReason(found, { confirmsDiff: false })
  }
  return null
}
