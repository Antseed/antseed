import { posix } from 'node:path'
import { getAddress } from 'ethers'
import { canonicalHashBytes32, kbfExtensionRuleById } from '@antseed/fingerprints'
import { VERIFIER_VERDICT, modelHash, serviceHash as hashService, type ModelAuditedEvent, type ServiceAuditedEvent } from '@antseed/node/payments'
import type { ConfirmationTarget } from './pending-confirmations.js'
import { pooledCloseCallVerdict } from './close-call.js'
import { AUDIT_CHECK_IDS, describeAuditCheck, flaggingChecks, type AuditCheckId } from './flagging-checks.js'
import { sanitizeOutcomeSummary } from './outcome-reason.js'
import { validateOutputCap } from './output-cap.js'
import { validateOutputEcho } from './output-echo.js'
import { proxyAuditEvidenceHash, type ProxyAuditEvidenceV1 } from './proxy-evidence.js'
import type { SubmissionCandidate } from './submission-delta.js'
import { opinionKey } from './third-opinion.js'
import { validateTokenizerPrecheck } from './tokenizer-precheck.js'
import { normalized } from './utils.js'

/**
 * A DIFF is a verdict only when two auditors flag the seller with the same check, each on its own fresh
 * material. The contract counts any two DIFF reports, so the CLI holds a confirming report to this.
 *
 * Before `verifier run` audits a seller whose DIFF waits for it, it reads which check flagged in the first
 * auditor's published evidence (the `ModelAudited` event of the report's transaction names its IPFS URI and
 * hash), and runs that check to its end whatever else flags (`model-run.ts`). Before `verifier submit` sends a
 * result that answers a waiting DIFF, and again right before each transaction, it decides here:
 * - the same check flagged in both audits: the result is sent as DIFF, and the contract records it;
 * - another check flagged here: nothing is sent. The older record stands, and the finding is a first flag the
 *   next time the seller is audited. An UNDETERMINED would not be neutral: one report records it, and it would
 *   replace a live SAME (or, in a hold epoch, a recorded DIFF) on a finding nobody confirmed;
 * - nothing flagged here: a SAME is sent only when a check that flagged there passed here; when it was
 *   inconclusive or did not run, nothing is sent;
 * - an UNDETERMINED answering a waiting DIFF is never sent: the run audits the seller again within its
 *   confirmation attempts, and an UNDETERMINED with no waiting DIFF follows the existing rules;
 * - the first auditor's evidence cannot be read, or does not hold: nothing is sent now, and the next submit
 *   reads it again.
 *
 * Stored with the result in the published evidence, so anyone can follow it.
 */
export interface SameCheckConfirmationV1 {
  /** The auditor whose waiting DIFF this result answers. */
  auditor: string
  /** That auditor's model audit evidence, as its `ModelAudited` event names it. */
  evidenceUri: string
  evidenceHash: string
  /** Unix seconds of the block of that auditor's report. */
  reportedAt: number
  /** The checks that flagged the seller in that auditor's audit. */
  firstChecks: AuditCheckId[]
  /** The checks that flagged the seller in this audit. */
  ownChecks: AuditCheckId[]
  /** A check both flagged; null for a SAME, which a check that flagged there passed here (`passedCheck`). */
  sameCheck: AuditCheckId | null
  /** For a SAME: a check that flagged there and passed here. */
  passedCheck?: AuditCheckId
}

/** A confirmation needs material made at least this long after the first report (design note, "an hour later"). */
export const CONFIRMATION_MIN_DELAY_SECONDS = 60 * 60

/**
 * What to do with one result before it is sent:
 * - `send`: it answers a waiting DIFF and may go out as it is, with this record;
 * - `exclude`: it is never sent (another check flagged, the confirmed check did not decide, it is not fresh,
 *   it names no check);
 * - `hold`: not sent now; the next submit decides again (the first auditor's evidence could not be read).
 */
export type SameCheckDecision =
  | { kind: 'send'; confirmation: SameCheckConfirmationV1 }
  | { kind: 'exclude'; reason: string; confirmation?: SameCheckConfirmationV1 }
  | { kind: 'hold'; reason: string }

/** A candidate as `prepareModelAudits` hands it over: the checks that flagged and passed in its own audit. */
export type SameCheckCandidate = SubmissionCandidate & {
  flaggedBy: readonly AuditCheckId[]
  passedBy: readonly AuditCheckId[]
}

export interface PublishedFlagReader {
  /** The `ModelAudited` events of `auditor` on `modelHash`. */
  modelAudits(filter: { model: string; auditor: string }): Promise<ModelAuditedEvent[]>
  /** The text at `<cid>/<path>` on IPFS. */
  fetchText(cidPath: string): Promise<string>
  /** The service's report round on the contract now: a report from an earlier round no longer counts. */
  reportRound(agentId: bigint, serviceHash: string): Promise<number>
  /** Unix seconds of a block. */
  blockTimestamp(blockNumber: number): Promise<number>
}

/** The first auditor's flag on one seller, read from its published evidence and checked. */
export interface FirstFlag {
  auditor: string
  evidenceUri: string
  evidenceHash: string
  reportedAt: number
  checks: AuditCheckId[]
}

/**
 * The filter `prepareModelAudits` takes (`sameCheck`): one decision or null per candidate. Null for a result
 * that answers no waiting DIFF (a first look), and for an UNDETERMINED; third opinions are left out before
 * this runs (`third-opinion.ts`).
 */
export function sameCheckFilter(input: {
  events: readonly ServiceAuditedEvent[]
  auditor: string
  reader: PublishedFlagReader
  /** Auditors revoked this epoch: their reports no longer count. */
  revoked?: ReadonlySet<string>
}): (modelHash: string, candidates: readonly SameCheckCandidate[]) => Promise<Array<SameCheckDecision | null>> {
  const waiting = waitingDiffs(input.events, input.auditor, input.revoked)
  const readFirst = firstFlagReader(input.reader)
  return async (modelHash, candidates) => Promise.all(candidates.map(async (candidate): Promise<SameCheckDecision | null> => {
    if (candidate.verdict === VERIFIER_VERDICT.DIFF && candidate.flaggedBy.length === 0) {
      return { kind: 'exclude', reason: 'a DIFF that names no check that flagged it is not valid evidence, so it is not sent' }
    }
    const reports = waiting.get(opinionKey(candidate.agentId, candidate.serviceHash, modelHash)) ?? []
    if (reports.length === 0) return null
    let firsts: FirstFlag[]
    try {
      // The contract's round now: a revocation moves it on without an event for the service.
      const round = await input.reader.reportRound(candidate.agentId, candidate.serviceHash)
      const live = reports.filter((report) => report.round === round)
      if (live.length === 0) return null
      firsts = await Promise.all(live.map((report) => readFirst(report, candidate.agentId, candidate.serviceHash)))
    } catch (error) {
      return { kind: 'hold', reason: holdReason(error) }
    }
    return decide(candidate, firsts)
  }))
}

/** The decision for one candidate against every first flag it answers (more than one fails closed: each must agree). */
export function decide(candidate: SameCheckCandidate, firsts: readonly FirstFlag[]): SameCheckDecision {
  const ownChecks = [...candidate.flaggedBy]
  const decisions = firsts.map((first): SameCheckDecision => {
    // An UNDETERMINED answering a waiting DIFF is never sent: one report records it, and it would replace the
    // seller's live SAME. The run audits the seller again within its confirmation attempts (`model-run.ts`).
    if (candidate.verdict === VERIFIER_VERDICT.UNDETERMINED) {
      return {
        kind: 'exclude',
        reason: ownChecks.length > 0
          ? `another check (${describeChecks(ownChecks)}) flagged and ${describeChecks(first.checks)}, which flagged the waiting DIFF, did not decide; nothing is sent`
          : `${describeChecks(first.checks)}, which flagged the waiting DIFF, did not decide in this audit; nothing is sent, so the seller keeps its record`,
      }
    }
    const record = (sameCheck: AuditCheckId | null, passedCheck?: AuditCheckId): SameCheckConfirmationV1 => ({
      auditor: first.auditor,
      evidenceUri: first.evidenceUri,
      evidenceHash: first.evidenceHash,
      reportedAt: first.reportedAt,
      firstChecks: [...first.checks],
      ownChecks,
      sameCheck,
      ...(passedCheck ? { passedCheck } : {}),
    })
    if (candidate.auditedAt < first.reportedAt + CONFIRMATION_MIN_DELAY_SECONDS) {
      return {
        kind: 'exclude',
        reason: `this audit was made ${candidate.auditedAt < first.reportedAt ? 'before' : 'less than an hour after'} the waiting DIFF it would answer; `
          + 'a confirmation needs fresh material, so it is not sent',
      }
    }
    const sameCheck = AUDIT_CHECK_IDS.find((check) => first.checks.includes(check) && ownChecks.includes(check)) ?? null
    if (sameCheck) {
      return candidate.verdict === VERIFIER_VERDICT.DIFF
        ? { kind: 'send', confirmation: record(sameCheck) }
        : { kind: 'exclude', reason: `${describeAuditCheck(sameCheck)} flagged in both audits but this result is not a DIFF`, confirmation: record(sameCheck) }
    }
    if (ownChecks.length > 0) {
      return {
        kind: 'exclude',
        confirmation: record(null),
        reason: `the waiting DIFF was flagged by ${describeChecks(first.checks)} and this audit by ${describeChecks(ownChecks)}; `
          + 'a DIFF is confirmed only by the same check, so nothing is sent and the seller keeps its record',
      }
    }
    const passedCheck = AUDIT_CHECK_IDS.find((check) => first.checks.includes(check) && candidate.passedBy.includes(check))
    if (candidate.verdict === VERIFIER_VERDICT.SAME && passedCheck) return { kind: 'send', confirmation: record(null, passedCheck) }
    return {
      kind: 'exclude',
      confirmation: record(null),
      reason: `the waiting DIFF was flagged by ${describeChecks(first.checks)}, which neither flagged nor passed in this audit; `
        + 'nothing is sent, so a check that did not decide clears nothing',
    }
  })
  return decisions.find((decision) => decision.kind !== 'send') ?? decisions[0]!
}

function describeChecks(checks: readonly AuditCheckId[]): string {
  return checks.length === 0 ? 'no check' : checks.map(describeAuditCheck).join(' and ')
}

/** A bounded, cleaned reason: the error text can come from a file another auditor published. */
function holdReason(error: unknown): string {
  const detail = sanitizeOutcomeSummary(error instanceof Error ? error.message : String(error)).slice(0, 200)
  return `which check flagged in the waiting DIFF could not be read from its published evidence (${detail}); `
    + 'a DIFF is confirmed only by the same check, so nothing is sent now and the next submit reads it again'
}

/**
 * Other auditors' latest reports per `opinionKey` that are DIFFs still waiting (fewer reports than they need).
 * Their round is compared with the contract's round by the caller.
 */
export function waitingDiffs(
  events: readonly ServiceAuditedEvent[],
  auditor: string,
  revoked?: ReadonlySet<string>,
): Map<string, ServiceAuditedEvent[]> {
  const me = getAddress(auditor)
  const latest = new Map<string, Map<string, ServiceAuditedEvent>>()
  for (const event of events) {
    const who = getAddress(event.auditor)
    if (who === me || revoked?.has(who)) continue
    const key = opinionKey(event.agentId, event.serviceHash, event.modelHash)
    const byAuditor = latest.get(key) ?? new Map<string, ServiceAuditedEvent>()
    const current = byAuditor.get(who)
    if (current && (current.blockNumber > event.blockNumber
      || (current.blockNumber === event.blockNumber && current.logIndex > event.logIndex))) continue
    byAuditor.set(who, event)
    latest.set(key, byAuditor)
  }
  const waiting = new Map<string, ServiceAuditedEvent[]>()
  for (const [key, byAuditor] of latest) {
    const diffs = [...byAuditor.values()].filter((event) => event.verdict === VERIFIER_VERDICT.DIFF && event.reports < event.required)
    if (diffs.length > 0) waiting.set(key, diffs)
  }
  return waiting
}

/**
 * Reads the first auditor's flag on one seller from a waiting report, once per transaction for the model
 * audit and once per seller for its evidence. Evidence published by another auditor is read as untrusted data:
 * every file is checked against its hash, the files must be about this seller, service, model and epoch, and
 * each flag is recomputed from what the evidence stores, never read from a label. Throws when anything does not
 * hold; the caller treats that as unreadable.
 */
export function firstFlagReader(reader: PublishedFlagReader): (report: ServiceAuditedEvent, agentId: bigint, serviceHash: string) => Promise<FirstFlag> {
  const audits = new Map<string, Promise<PublishedModelAudit>>()
  const flags = new Map<string, Promise<FirstFlag>>()
  return (report, agentId, serviceHash) => {
    const flagKey = `${getAddress(report.auditor)}:${report.transactionHash.toLowerCase()}:${agentId}:${normalized(serviceHash)}`
    let flag = flags.get(flagKey)
    if (!flag) {
      const auditKey = `${getAddress(report.auditor)}:${report.transactionHash.toLowerCase()}`
      let audit = audits.get(auditKey)
      if (!audit) {
        audit = readPublishedModelAudit(reader, report)
        audits.set(auditKey, audit)
      }
      flag = (async () => {
        const published = await audit
        const checks = await published.checksOf(agentId, serviceHash)
        return {
          auditor: getAddress(report.auditor),
          evidenceUri: published.evidenceUri,
          evidenceHash: published.evidenceHash,
          reportedAt: await reader.blockTimestamp(report.blockNumber),
          checks,
        }
      })()
      flags.set(flagKey, flag)
    }
    return flag
  }
}

/**
 * For each confirmation target with a waiting DIFF (`confirmationTargetsByModel`): reads which checks flagged it in
 * the first auditor's published evidence, before the seller is audited, and stores them with the report's time on
 * the target. A target whose first evidence cannot be read, or whose report is younger than
 * `CONFIRMATION_MIN_DELAY_SECONDS`, is removed with a line saying why: its result could not be sent now, and the next
 * run tries again.
 */
export async function attachFirstFlags(
  targets: Map<string, Map<string, ConfirmationTarget>>,
  input: {
    events: readonly ServiceAuditedEvent[]
    auditor: string
    revoked?: ReadonlySet<string>
    reader: PublishedFlagReader
    /** Unix seconds. */
    now: number
    log: (line: string) => void
  },
): Promise<void> {
  const readFirst = firstFlagReader(input.reader)
  const waiting = waitingDiffs(input.events, input.auditor, input.revoked)
  for (const [model, agents] of targets) {
    for (const [key, target] of agents) {
      if (!target.waiting.some((tally) => tally.verdict === 'DIFF')) continue
      const service = hashService(target.service)
      const reports = waiting.get(opinionKey(target.agentId, service, modelHash(model))) ?? []
      try {
        if (reports.length === 0) throw new Error('no waiting DIFF was found for it')
        const firsts = await Promise.all(reports.map((report) => readFirst(report, target.agentId, service)))
        target.firstChecks = AUDIT_CHECK_IDS.filter((check) => firsts.some((first) => first.checks.includes(check)))
        target.firstReportedAt = Math.max(...firsts.map((first) => first.reportedAt))
      } catch (error) {
        agents.delete(key)
        input.log(`  ${model}: agent ${target.agentId} is not audited now: which check flagged its waiting DIFF could not be read `
          + `(${sanitizeOutcomeSummary(error instanceof Error ? error.message : String(error)).slice(0, 200)}); the next run tries again`)
        continue
      }
      if (input.now < target.firstReportedAt + CONFIRMATION_MIN_DELAY_SECONDS) {
        agents.delete(key)
        input.log(`  ${model}: agent ${target.agentId} is confirmed from an hour after the first report, on fresh material; a later run audits it`)
      }
    }
  }
}

/** The oldest a first auditor's seller evidence may be at its report: one epoch (7 days), and a day for submitting. */
const EVIDENCE_MAX_AGE_SECONDS = 8 * 24 * 60 * 60
const CLOCK_SLACK_SECONDS = 60 * 60

interface PublishedModelAudit {
  evidenceUri: string
  evidenceHash: string
  checksOf(agentId: bigint, serviceHash: string): Promise<AuditCheckId[]>
}

async function readPublishedModelAudit(reader: PublishedFlagReader, report: ServiceAuditedEvent): Promise<PublishedModelAudit> {
  const events = await reader.modelAudits({ model: report.modelHash, auditor: report.auditor })
  const event = events.find((entry) => (
    entry.transactionHash.toLowerCase() === report.transactionHash.toLowerCase()
    && normalized(entry.modelHash) === normalized(report.modelHash)
    && getAddress(entry.auditor) === getAddress(report.auditor)
  ))
  if (!event) throw new Error('no model audit was found in the transaction of its report')
  if (!event.evidenceUri.startsWith('ipfs://')) throw new Error('its evidence was not published to IPFS')
  const cid = event.evidenceUri.slice('ipfs://'.length).replace(/\/+$/, '')
  if (!/^[A-Za-z0-9]+$/.test(cid)) throw new Error('its evidence URI is not an ipfs://<cid>')
  const fetchJson = async (path: string): Promise<unknown> => {
    const text = await reader.fetchText(`${cid}/${path}`)
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new Error(`a published file is not JSON (${path})`)
    }
  }

  const publication = await fetchJson('publication.json')
  if (!isRecord(publication) || publication['kind'] !== 'antseed-verifier-ipfs-publication' || typeof publication['evidencePath'] !== 'string') {
    throw new Error('its publication index is not an Antseed verifier publication')
  }
  const indexPath = publication['evidencePath']
  const evidence = await fetchJson(safeRelativePath(indexPath))
  if (!isRecord(evidence) || evidence['kind'] !== 'antseed-verifier-model-audit-evidence' || !Array.isArray(evidence['results'])) {
    throw new Error('its evidence is not a model audit')
  }
  const evidenceHash = canonicalHashBytes32(evidence)
  if (evidenceHash.toLowerCase() !== event.evidenceHash.toLowerCase()) {
    throw new Error('its evidence does not hash to what it submitted')
  }
  if (evidence['epoch'] !== event.epoch.toString()) throw new Error('its evidence is for another epoch than its report')
  if (typeof evidence['modelHash'] !== 'string' || normalized(evidence['modelHash']) !== normalized(report.modelHash)) {
    throw new Error('its evidence is for another model than its report')
  }
  const reportedAt = await reader.blockTimestamp(report.blockNumber)
  const directory = posix.dirname(indexPath)
  const resolve = (path: unknown): string => {
    if (typeof path !== 'string') throw new Error('a published path is missing')
    return safeRelativePath(directory === '.' ? path : `${directory}/${path}`)
  }
  const sellerEvidence = async (audit: unknown, agentId: bigint, serviceHash: string): Promise<ProxyAuditEvidenceV1> => {
    if (!isRecord(audit) || typeof audit['evidenceHash'] !== 'string') throw new Error(`its result for agent ${agentId} names no audit evidence`)
    const seller = await fetchJson(resolve(audit['evidencePath']))
    if (!isRecord(seller) || seller['kind'] !== 'antseed-buyer-proxy-kbf-audit' || !Array.isArray(seller['exchanges'])
      || !isRecord(seller['target']) || !isRecord(seller['result'])) {
      throw new Error(`its audit evidence for agent ${agentId} is not a seller audit`)
    }
    const parsed = seller as unknown as ProxyAuditEvidenceV1
    if (proxyAuditEvidenceHash(parsed).toLowerCase() !== audit['evidenceHash'].toLowerCase()) {
      throw new Error(`its audit evidence for agent ${agentId} does not match the hash its model audit names`)
    }
    // The file must be about this seller, service and model, and made in the epoch of the report: a hash only
    // proves which file was published.
    if (parsed.target.agentId !== agentId.toString() || normalized(hashService(parsed.target.service)) !== normalized(serviceHash)) {
      throw new Error(`its audit evidence linked for agent ${agentId} is about another seller or service`)
    }
    if (normalized(modelHash(parsed.reference.referenceModel)) !== normalized(report.modelHash)) {
      throw new Error(`its audit evidence linked for agent ${agentId} is about another model`)
    }
    const madeAt = Date.parse(parsed.createdAt) / 1_000
    // The evidence's time is the first auditor's clock, the report's the chain's: an hour of slack between them.
    if (!Number.isFinite(madeAt) || madeAt > reportedAt + CLOCK_SLACK_SECONDS || madeAt < reportedAt - EVIDENCE_MAX_AGE_SECONDS) {
      throw new Error(`its audit evidence linked for agent ${agentId} was not made in the epoch of its report`)
    }
    return parsed
  }
  const results = evidence['results'] as unknown[]
  return {
    evidenceUri: event.evidenceUri,
    evidenceHash: event.evidenceHash,
    async checksOf(agentId, serviceHash) {
      const result = results.find((entry): entry is Record<string, unknown> => (
        isRecord(entry) && entry['agentId'] === agentId.toString()
        && typeof entry['serviceHash'] === 'string' && normalized(entry['serviceHash']) === normalized(serviceHash)
      ))
      if (!result) throw new Error(`its evidence has no result for agent ${agentId} on this service`)
      if (result['verdict'] !== 'DIFF') throw new Error(`its evidence gives agent ${agentId} ${String(result['verdict'])}, not DIFF`)
      const first = await sellerEvidence(result['audit'], agentId, serviceHash)
      // Every flag is recomputed from the stored records, as `verifier submit` checks its own.
      if (first.tokenizerPrecheck) validateTokenizerPrecheck(first.tokenizerPrecheck, first.target.peerId)
      if (first.outputCap) validateOutputCap(first.outputCap)
      if (first.outputEcho) {
        validateOutputEcho(first.outputEcho, first.target.peerId)
        if (first.outputEcho.precheckMatch !== (first.tokenizerPrecheck?.outcome === 'match')) throw new Error('its echo check\'s pre-check match is not its pre-check')
      }
      const checks = flaggingChecks(first, await questionsVerdict(result, first, (audit) => sellerEvidence(audit, agentId, serviceHash)))
      if (checks.length === 0) throw new Error(`its evidence for agent ${agentId} shows no check that flagged`)
      return checks
    },
  }
}

/**
 * The questions' verdict of a published result: the first set's own, or after a close call the pooled verdict
 * of the first set and its extra sets, recomputed from their evidence files (each hash-checked).
 */
async function questionsVerdict(
  result: Record<string, unknown>,
  first: ProxyAuditEvidenceV1,
  load: (audit: unknown) => Promise<ProxyAuditEvidenceV1>,
): Promise<'SAME' | 'DIFF' | 'UNDETERMINED' | null> {
  const sets: Array<{ rule: unknown; evidence: ProxyAuditEvidenceV1 }> = []
  for (const name of ['extension', 'extension2']) {
    const extension = result[name]
    if (!isRecord(extension)) break
    sets.push({ rule: extension['rule'], evidence: await load(extension['audit']) })
  }
  if (sets.length === 0) return verdictOf(first.result.verdict)
  const rule = typeof sets[0]!.rule === 'string' ? kbfExtensionRuleById(sets[0]!.rule) : undefined
  if (!rule || sets.some((set) => set.rule !== rule.id)) throw new Error('its close call names no known extension rule')
  const pooled = pooledCloseCallVerdict(
    { stats: first.result.stats, probeCount: first.reference.probes.length },
    sets.map((set) => ({ stats: set.evidence.result.stats, probeCount: set.evidence.reference.probes.length })),
    rule,
  )
  return pooled.verdict === 'UNKNOWN' ? null : verdictOf(pooled.verdict)
}

function verdictOf(value: unknown): 'SAME' | 'DIFF' | 'UNDETERMINED' | null {
  return value === 'SAME' || value === 'DIFF' || value === 'UNDETERMINED' ? value : null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * A path inside the publication, as `publication.ts` in the model verifier resolves it: `..` steps back
 * inside the package (a seller's evidence sits beside the model audit's directory, not in it), never above
 * its root; each segment is URL-encoded for the gateway.
 */
function safeRelativePath(path: string): string {
  if (path.startsWith('/') || path.includes('\\')) throw new Error('an unsafe path in the publication')
  const segments: string[] = []
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue
    if (segment === '..') {
      if (segments.length === 0) throw new Error('a path in the publication escapes its root')
      segments.pop()
      continue
    }
    segments.push(encodeURIComponent(segment))
  }
  if (segments.length === 0) throw new Error('an empty path in the publication')
  return segments.join('/')
}
