import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { AuditCheckId } from './audit-checks.js'
import { Wallet, keccak256 } from 'ethers'
import { canonicalHashBytes32, canonicalJsonStringify } from '@antseed/fingerprints'
import { bytesToHex, decodeHttpRequest, encodeHttpRequest, encodeResponseAuthSigningPayload, signData } from '@antseed/node'
import { VERIFIER_VERDICT, serviceHash, type ModelAuditedEvent, type ServiceAuditedEvent, type VerifierVerdict } from '@antseed/node/payments'
import { flaggingChecks, passedChecks } from './audit-checks.js'
import { prepareAuditPublication } from './ipfs-publication.js'
import { modelAuditUpstreams, prepareModelAudits, writeModelAuditEvidence, type PreparedModelAudit } from './model-audit.js'
import { FIXTURE_CONFIG, peerIdOf, referenceFixture, writeSignedAuditRun, type FixtureAudit } from './model-audit-fixtures.test-support.js'
import {
  CONFIRMATION_MIN_DELAY_SECONDS,
  attachFirstFlags,
  decide,
  sameCheckFilter,
  type FirstFlag,
  type PublishedFlagReader,
  type SameCheckCandidate,
} from './same-check.js'
import { sellerSignatureProblem, type StoredSignedAnswer } from './seller-signature.js'
import { sameCheckChanged } from '../cli/commands/verifier/submit.js'
import { FLIPS_RULE } from './methods/flips/flips-score.js'

const randomWallet = (): Wallet => new Wallet(Wallet.createRandom().privateKey)
const first = randomWallet()
const second = randomWallet()
const sellers = [randomWallet(), randomWallet(), randomWallet(), randomWallet()]
const MODEL = 'model-a'
const CID = 'bafytestfirstauditor'
const TX = `0x${'ab'.repeat(32)}`
/** The first report's block time; every fixture audit is made well over an hour after it. */
const REPORTED_AT = Date.parse('2026-10-07T00:10:00.000Z') / 1_000
/** When the second auditor's fixture audits were made: more than an hour after the first report. */
const CONFIRMED_AT = '2026-10-07T01:30:00.000Z'

const fixture = (agentId: string, verdict: FixtureAudit['verdict'], tokenizerMismatch = false): FixtureAudit => ({
  agentId, seller: sellers[Number(agentId) - 1]!, model: MODEL, service: MODEL, verdict, ...(tokenizerMismatch ? { tokenizerMismatch } : {}),
})

async function prepare(directory: string, auditor: Wallet, runId: string, audits: FixtureAudit[], options: {
  sameCheck?: Parameters<typeof prepareModelAudits>[0]['sameCheck']
  unpublishedDiffs?: string
} = {}) {
  const evidenceDir = join(directory, runId, 'evidence')
  const banksDir = join(directory, runId, 'banks')
  const manifest = await writeSignedAuditRun({ evidenceDir, banksDir, runId, epoch: '7', auditor, audits, ...(auditor === second ? { completedAt: CONFIRMED_AT } : {}) })
  const prepared = await prepareModelAudits({
    evidenceDir, banksDir, manifest, auditor: auditor.address,
    resolveAgentOwner: async () => randomWallet().address,
    config: FIXTURE_CONFIG,
    ...options,
  })
  return { evidenceDir, prepared }
}

/** The first auditor's audit as IPFS serves it: the files `verifier submit` would pin, keyed by path. */
async function publish(evidenceDir: string, audit: PreparedModelAudit): Promise<Map<string, string>> {
  await writeModelAuditEvidence(audit)
  const packaged = await prepareAuditPublication({
    evidenceDir,
    runId: 'first',
    model: audit.key,
    evidenceHash: audit.evidenceHash,
    evidencePath: audit.evidencePath,
    evidenceBytes: new TextEncoder().encode(canonicalJsonStringify(audit.evidence)),
    referencePaths: audit.references.map((reference) => reference.path),
    auditEvidencePaths: audit.auditEvidencePaths,
    referenceEvidencePaths: audit.referenceEvidence.map((entry) => entry.path),
    upstreams: modelAuditUpstreams(audit),
  })
  return new Map(packaged.files.map((file) => [file.path, Buffer.from(file.bytes).toString('utf8')]))
}

let currentModelHash = ''

function reader(files: Map<string, string>, evidenceHash: string, overrides: Partial<ModelAuditedEvent> = {}): PublishedFlagReader & { fetched: string[]; readFrom: number[] } {
  const fetched: string[] = []
  const readFrom: number[] = []
  return {
    fetched,
    readFrom,
    async modelAudits(_filter, fromBlock) {
      readFrom.push(fromBlock)
      return [{
        modelHash: currentModelHash, auditor: first.address, epoch: 7n, evidenceHash,
        evidenceUri: `ipfs://${CID}`, resultCount: 3, blockNumber: 10, logIndex: 0, transactionHash: TX,
        ...overrides,
      }]
    },
    async fetchText(cidPath) {
      fetched.push(cidPath)
      const [cid, ...rest] = cidPath.split('/')
      const text = cid === CID ? files.get(rest.map(decodeURIComponent).join('/')) : undefined
      if (text === undefined) throw new Error(`not found: ${cidPath}`)
      return text
    },
    reportRound: async () => 0,
    blockTimestamp: async () => REPORTED_AT,
  }
}

function report(agentId: bigint, verdict: VerifierVerdict, extra: Partial<ServiceAuditedEvent> = {}): ServiceAuditedEvent {
  return {
    agentId, serviceHash: serviceHash(MODEL), auditor: first.address, modelHash: currentModelHash, verdict,
    round: 0, reports: 1, required: verdict === VERIFIER_VERDICT.DIFF ? 2 : 1,
    blockNumber: 10, logIndex: Number(agentId), transactionHash: TX, ...extra,
  }
}

const candidate = (
  agentId: bigint,
  verdict: VerifierVerdict,
  flaggedBy: SameCheckCandidate['flaggedBy'],
  passedBy: SameCheckCandidate['passedBy'] = [],
  auditedAt = REPORTED_AT + CONFIRMATION_MIN_DELAY_SECONDS,
): SameCheckCandidate => ({ agentId, peerId: peerIdOf(sellers[Number(agentId) - 1]!), serviceHash: serviceHash(MODEL), verdict, auditedAt, flaggedBy, passedBy })

/** A first auditor that flagged agent 2 by its pre-check, agent 3 by the questions and agent 4 by a close call's extra sets; agent 1 SAME. */
async function firstAuditor(directory: string) {
  const reference = referenceFixture(MODEL, 20)
  const { evidenceDir, prepared } = await prepare(directory, first, 'first', [
    { ...fixture('1', 'SAME'), reference },
    { ...fixture('2', 'DIFF', true), reference },
    { ...fixture('3', 'DIFF'), reference },
    { ...fixture('4', 'SAME'), reference, closeCall: { rule: 'kbf-extension-v2', firstWrong: 7, extensionWrong: 4 } },
  ])
  const audit = prepared.audits[0]!
  currentModelHash = audit.modelHash
  return { audit, files: await publish(evidenceDir, audit) }
}

test('the checks that flagged and passed are read from the evidence alone', () => {
  const mismatch = { tokenizerPrecheck: { outcome: 'mismatch' } as never, exchanges: [] }
  assert.deepEqual(flaggingChecks(mismatch, 'DIFF'), ['tokens'])
  assert.deepEqual(flaggingChecks({ outputCap: { outcome: 'flag' } as never, exchanges: [] }, 'DIFF'), ['output-cap'])
  assert.deepEqual(flaggingChecks({ exchanges: [{} as never] }, 'DIFF'), ['kbf'])
  assert.deepEqual(flaggingChecks({ exchanges: [{} as never] }, 'SAME'), [])
  assert.deepEqual(flaggingChecks({ exchanges: [] }, 'DIFF'), [], 'a DIFF with no question asked and no flag names no check')
  assert.deepEqual(passedChecks({ tokenizerPrecheck: { outcome: 'match' } as never, outputCap: { outcome: 'pass' } as never, exchanges: [{} as never] }, 'SAME'), ['tokens', 'output-cap', 'kbf'])
  assert.deepEqual(passedChecks({ tokenizerPrecheck: { outcome: 'inconclusive' } as never, exchanges: [{} as never] }, 'UNDETERMINED'), [])
})

test('a SAME clears a waiting DIFF of two checks only when both passed here', () => {
  const two: FirstFlag = { auditor: first.address, peerId: peerIdOf(sellers[1]!), evidenceUri: `ipfs://${CID}`, evidenceHash: '0x1', reportedAt: REPORTED_AT, checks: ['output-cap', 'kbf'] }
  // The cap check has no result here and the questions pass: one check left open clears nothing.
  const open = decide(candidate(2n, VERIFIER_VERDICT.SAME, [], ['kbf']), [two])
  assert.equal(open.kind, 'exclude')
  assert.match(open.kind === 'exclude' ? open.reason : '', /the cap check neither flagged nor passed/)
  assert.equal(decide(candidate(2n, VERIFIER_VERDICT.SAME, [], ['output-cap', 'kbf']), [two]).kind, 'send')
  // One of them flagging again is the same-check DIFF, whatever the other did.
  assert.equal(decide(candidate(2n, VERIFIER_VERDICT.DIFF, ['output-cap'], []), [two]).kind, 'send')
})

test('a DIFF that only FLIPS flagged, through the confirmer\'s audit: each FLIPS outcome and what is sent', async () => {
  const { settleAuditVerdict } = await import('./close-call.js')
  const { checksWith, readingsOfSummary } = await import('./audit-checks.js')
  const waiting: FirstFlag = { auditor: first.address, peerId: peerIdOf(sellers[1]!), evidenceUri: `ipfs://${CID}`, evidenceHash: '0x1', reportedAt: REPORTED_AT, checks: ['flips'] }
  const flips = (outcome: 'flag' | 'pass' | 'inconclusive', p: number | null) => ({
    rule: 'flips-v1', model: 'claude-opus-5.5', stage: 'confirm', outcome, counted: true, p, score: p === null ? null : 4, reason: 'x',
  })
  // The confirmer's audit: the questions pass unless said otherwise, FLIPS as given; its verdict over every test, then
  // what the same-check decision does with it.
  const confirm = (summary: ReturnType<typeof flips>, extra: Record<string, unknown> = {}) => {
    const settled = settleAuditVerdict({
      status: 'SAME', questionsStatus: 'SAME', parsedProbeCount: 40, confirming: ['flips'], flips: summary, ...extra,
    } as never) as unknown as Parameters<typeof readingsOfSummary>[0] & { status: string }
    const readings = readingsOfSummary(settled)
    const decision = decide({
      ...candidate(2n, VERIFIER_VERDICT[settled.status as 'SAME' | 'DIFF' | 'UNDETERMINED'], checksWith(readings, 'flag'), checksWith(readings, 'pass')),
      betweenBy: readings.filter((reading) => reading.between === true).map((reading) => reading.check),
      confirming: { checks: ['flips'], reportedAt: REPORTED_AT },
    }, [waiting])
    return [settled.status, decision.kind, decision.kind === 'exclude' ? decision.code : decision.kind === 'send' ? decision.confirmation.sameCheck ?? decision.confirmation.passedCheck : null,
      ...(decision.kind === 'send' && decision.confirmation.clearedBetween ? [decision.confirmation.clearedBetween] : [])]
  }
  // While FLIPS is recorded only (until a dry run has shown how honest sellers score with each side on its own
  // thinking switch), a confirmation of a DIFF only FLIPS flagged cannot decide, whatever FLIPS gives: undecided, never
  // sent, asked again. The decisions below are the ones FLIPS takes once its rule counts again.
  if (!FLIPS_RULE.counts.default) {
    for (const summary of [flips('flag', 0.0005), flips('pass', 0.4), flips('inconclusive', 0.02), flips('inconclusive', null)]) {
      assert.deepEqual(confirm(summary), ['UNDETERMINED', 'exclude', 'confirmation-undecided'], JSON.stringify(summary))
      // Also where the questions flag: the test it confirms is still open, so it is asked again.
      assert.deepEqual(confirm(summary, { questionsStatus: 'DIFF', status: 'DIFF' }), ['UNDETERMINED', 'exclude', 'confirmation-undecided'], JSON.stringify(summary))
    }
  } else {
    // Flags at the confirmation bar: a same-check DIFF, sent; with the first report it is recorded (2 of 2).
    assert.deepEqual(confirm(flips('flag', 0.0005)), ['DIFF', 'send', 'flips'])
    // Passes above 10% and every other test passes: a SAME, sent; it clears the waiting DIFF.
    assert.deepEqual(confirm(flips('pass', 0.4)), ['SAME', 'send', 'flips'])
    // Passes, but the questions flag: another test's DIFF, never sent; the seller keeps its earlier verdict.
    assert.deepEqual(confirm(flips('pass', 0.4), { questionsStatus: 'DIFF', status: 'DIFF' }), ['DIFF', 'exclude', 'other-test-only'])
    // Between the bars, with every other repeated test passing: it clears like a pass and sends SAME,
    // which records that it cleared between the bars (`confirmBetweenClears`).
    assert.deepEqual(confirm(flips('inconclusive', 0.02)), ['SAME', 'send', 'flips', ['flips']])
    // Between the bars, but the questions flag: another test's DIFF, never sent; the report stays waiting.
    assert.deepEqual(confirm(flips('inconclusive', 0.02), { questionsStatus: 'DIFF', status: 'DIFF' }), ['DIFF', 'exclude', 'other-test-only'])
  }
  // Under a rule this CLI does not know (recorded only) a score between the bars clears nothing.
  assert.deepEqual(confirm({ ...flips('inconclusive', 0.02), rule: 'flips-v0' }), ['UNDETERMINED', 'exclude', 'confirmation-undecided'])
  // No result (an unusable reference, a profile mismatch, replies without a sequence): undecided, never sent, asked again.
  assert.deepEqual(confirm(flips('inconclusive', null)), ['UNDETERMINED', 'exclude', 'confirmation-undecided'])
  // A first look (not a confirmation of FLIPS) whose first-stage FLIPS flags or passes answers nothing: only the
  // confirmation stage (fresh pairs, 40 replies, the confirmation bar) confirms or clears a FLIPS flag.
  const firstLook = (flaggedBy: AuditCheckId[], passedBy: AuditCheckId[], verdict: VerifierVerdict, checks: AuditCheckId[] = ['flips']) => {
    const decision = decide(candidate(2n, verdict, flaggedBy, passedBy), [{ ...waiting, checks }])
    return [decision.kind, decision.kind === 'exclude' ? decision.code : decision.kind === 'send' ? decision.confirmation.sameCheck : null]
  }
  assert.deepEqual(firstLook(['flips'], ['kbf'], VERIFIER_VERDICT.DIFF), ['exclude', 'flips-not-confirmation'])
  assert.deepEqual(firstLook([], ['flips', 'kbf'], VERIFIER_VERDICT.SAME), ['exclude', 'flips-not-confirmation'])
  // Another test the waiting DIFF also names still confirms from a first look, as before.
  assert.deepEqual(firstLook(['kbf', 'flips'], [], VERIFIER_VERDICT.DIFF, ['kbf', 'flips']), ['send', 'kbf'])
})

test('the final reread before sending keeps a FLIPS confirmation\'s identity: a confirmation is sent as prepared, an untagged first look and a changed report are held', async () => {
  const waiting: FirstFlag = { auditor: first.address, peerId: peerIdOf(sellers[1]!), evidenceUri: `ipfs://${CID}`, evidenceHash: '0x1', reportedAt: REPORTED_AT, checks: ['flips'] }
  const auditedAt = REPORTED_AT + CONFIRMATION_MIN_DELAY_SECONDS
  const filter = (firsts: FirstFlag[]) => async (_model: string, candidates: readonly SameCheckCandidate[]) => candidates.map((candidate) => decide(candidate, firsts))
  // As prepared: a confirmation of FLIPS whose confirm-stage FLIPS flagged, with the decision it stores.
  const confirming = { checks: ['flips'] as AuditCheckId[], reportedAt: REPORTED_AT }
  const prepared = decide({ ...candidate(2n, VERIFIER_VERDICT.DIFF, ['flips'], ['kbf'], auditedAt), confirming }, [waiting])
  assert.equal(prepared.kind, 'send')
  const result = {
    agentId: '2', serviceHash: serviceHash(MODEL), verdict: 'DIFF', auditedAt, flaggedBy: ['flips'], passedBy: ['kbf'],
    confirmation: prepared.kind === 'send' ? prepared.confirmation : undefined, confirming,
  } as unknown as Parameters<typeof sameCheckChanged>[1][number]
  assert.equal(await sameCheckChanged('0xmodel', [result], filter([waiting])), null, 'sent as prepared')
  // The same row without its identity reads as a first look: held.
  const { confirming: _dropped, ...untagged } = result as unknown as Record<string, unknown>
  assert.match(await sameCheckChanged('0xmodel', [untagged as never], filter([waiting])) ?? '', /only a confirmation of it/)
  // The waiting report changed since: held, and built again.
  assert.match(await sameCheckChanged('0xmodel', [result], filter([{ ...waiting, reportedAt: REPORTED_AT + 60 }])) ?? '', /confirms another report/)
})

test('a confirmation is credited only to the report it was made for: the same tests and the same report time', () => {
  const two: FirstFlag = { auditor: first.address, peerId: peerIdOf(sellers[1]!), evidenceUri: `ipfs://${CID}`, evidenceHash: '0x1', reportedAt: REPORTED_AT, checks: ['output-cap', 'kbf'] }
  const confirming = (identity: { checks: AuditCheckId[]; reportedAt?: number }) => ({ ...candidate(2n, VERIFIER_VERDICT.DIFF, ['output-cap'], []), confirming: identity })
  assert.equal(decide(confirming({ checks: ['kbf', 'output-cap'], reportedAt: REPORTED_AT }), [two]).kind, 'send')
  for (const other of [{ checks: ['output-cap', 'kbf'] as AuditCheckId[], reportedAt: REPORTED_AT - 1 }, { checks: ['output-cap'] as AuditCheckId[], reportedAt: REPORTED_AT }, { checks: ['output-cap', 'kbf'] as AuditCheckId[] }]) {
    const decision = decide(confirming(other), [two])
    assert.equal(decision.kind, 'exclude')
    assert.match(decision.kind === 'exclude' ? decision.reason : '', /confirms another report/)
  }
  // A first look answering a waiting DIFF names no report: it is judged as before.
  assert.equal(decide(candidate(2n, VERIFIER_VERDICT.DIFF, ['output-cap'], []), [two]).kind, 'send')
})

test('a result answering a waiting DIFF is sent only when the same check flagged, or a check that flagged passed', () => {
  const tokens: FirstFlag = { auditor: first.address, peerId: peerIdOf(sellers[1]!), evidenceUri: `ipfs://${CID}`, evidenceHash: '0x1', reportedAt: REPORTED_AT, checks: ['tokens'] }
  const confirm = decide(candidate(2n, VERIFIER_VERDICT.DIFF, ['tokens']), [tokens])
  assert.deepEqual(confirm, {
    kind: 'send',
    confirmation: { auditor: first.address, evidenceUri: `ipfs://${CID}`, evidenceHash: '0x1', reportedAt: REPORTED_AT, firstChecks: ['tokens'], ownChecks: ['tokens'], sameCheck: 'tokens' },
  })
  // Another check flagged: nothing is sent, so neither a live SAME nor a held DIFF is replaced.
  const other = decide(candidate(2n, VERIFIER_VERDICT.DIFF, ['kbf']), [tokens])
  assert.equal(other.kind, 'exclude')
  assert.match(other.kind === 'exclude' ? other.reason : '', /flagged by the token-count pre-check and this audit by the questions; a DIFF is confirmed only by the same check, so nothing is sent/)
  // A SAME disputes the DIFF only when the check that flagged passed here.
  const passed = decide(candidate(2n, VERIFIER_VERDICT.SAME, [], ['tokens', 'kbf']), [tokens])
  assert.deepEqual(passed.kind === 'send' ? [passed.confirmation.sameCheck, passed.confirmation.passedCheck] : null, [null, 'tokens'])
  const undecided = decide(candidate(2n, VERIFIER_VERDICT.SAME, [], ['kbf']), [tokens])
  assert.equal(undecided.kind, 'exclude')
  assert.match(undecided.kind === 'exclude' ? undecided.reason : '', /neither flagged nor passed in this audit/)
  // Fresh material only: made at least an hour after the report it answers.
  const early = decide(candidate(2n, VERIFIER_VERDICT.DIFF, ['tokens'], [], REPORTED_AT + 60), [tokens])
  assert.match(early.kind === 'exclude' ? early.reason : '', /less than an hour after the waiting DIFF/)
  const before = decide(candidate(2n, VERIFIER_VERDICT.DIFF, ['tokens'], [], REPORTED_AT - 1), [tokens])
  assert.match(before.kind === 'exclude' ? before.reason : '', /made before the waiting DIFF/)
  // Two waiting DIFFs fail closed: the same check must have flagged in each.
  const kbf: FirstFlag = { ...tokens, auditor: second.address, checks: ['kbf'] }
  assert.equal(decide(candidate(2n, VERIFIER_VERDICT.DIFF, ['tokens']), [tokens, kbf]).kind, 'exclude')
  assert.equal(decide(candidate(2n, VERIFIER_VERDICT.DIFF, ['tokens', 'kbf']), [tokens, kbf]).kind, 'send')
})

test('the first auditor\'s checks are read from its published evidence, close calls included', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-same-check-'))
  try {
    const { audit, files } = await firstAuditor(directory)
    const events = [report(1n, VERIFIER_VERDICT.SAME), report(2n, VERIFIER_VERDICT.DIFF), report(3n, VERIFIER_VERDICT.DIFF), report(4n, VERIFIER_VERDICT.DIFF)]
    const published = reader(files, audit.evidenceHash)
    const filter = sameCheckFilter({ events, auditor: second.address, reader: published })
    const decisions = await filter(audit.modelHash, [
      candidate(2n, VERIFIER_VERDICT.DIFF, ['tokens']),
      candidate(3n, VERIFIER_VERDICT.DIFF, ['tokens']),
      candidate(4n, VERIFIER_VERDICT.DIFF, ['kbf']),
      candidate(3n, VERIFIER_VERDICT.UNDETERMINED, []),
      candidate(1n, VERIFIER_VERDICT.DIFF, ['kbf']),
    ])
    assert.equal(decisions[0]?.kind, 'send')
    assert.deepEqual(decisions[0]?.kind === 'send' && decisions[0].confirmation.firstChecks, ['tokens'])
    assert.equal(decisions[1]?.kind, 'exclude')
    assert.deepEqual(decisions[1]?.kind === 'exclude' && decisions[1].confirmation?.firstChecks, ['kbf'])
    assert.equal(decisions[2]?.kind, 'send', 'a DIFF decided by a close call\'s extra sets reads as the questions')
    assert.deepEqual(decisions[2]?.kind === 'send' && decisions[2].confirmation.firstChecks, ['kbf'])
    assert.equal(decisions[3]?.kind, 'exclude', 'an UNDETERMINED answering a waiting DIFF is never sent')
    assert.equal(decisions[4], null, 'a DIFF with no waiting DIFF to answer is a first look')
    assert.equal(published.fetched.filter((path) => path.endsWith('publication.json')).length, 1, 'the publication is read once per transaction')
    assert.deepEqual(published.readFrom, [10], 'the model audit is read from its report\'s block, not from the contract\'s deployment')
    // A DIFF that names no check is never sent, first look or not.
    const [invalid] = await filter(audit.modelHash, [candidate(1n, VERIFIER_VERDICT.DIFF, [])])
    assert.match(invalid?.kind === 'exclude' ? invalid.reason : '', /names no check/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('first evidence that is not published, altered, about another seller or not readable holds the result back', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-same-check-'))
  try {
    const { audit, files } = await firstAuditor(directory)
    const decideWith = async (published: PublishedFlagReader, agentId = 2n) => {
      const events = [report(agentId, VERIFIER_VERDICT.DIFF)]
      const [decision] = await sameCheckFilter({ events, auditor: second.address, reader: published })(
        audit.modelHash, [candidate(agentId, VERIFIER_VERDICT.DIFF, ['tokens'])],
      )
      assert.equal(decision?.kind, 'hold')
      return decision?.kind === 'hold' ? decision.reason : ''
    }
    assert.match(await decideWith(reader(files, audit.evidenceHash, { evidenceUri: '' })), /its evidence was not published to IPFS/)
    assert.match(await decideWith(reader(files, audit.evidenceHash, { transactionHash: `0x${'cd'.repeat(32)}` })), /no model audit was found in the transaction of its report/)
    assert.match(await decideWith(reader(files, `0x${'00'.repeat(32)}`)), /its evidence does not hash to what it submitted/)
    assert.match(await decideWith(reader(files, audit.evidenceHash, { epoch: 8n })), /for another epoch than its report/)
    const index = JSON.parse(files.get('publication.json')!) as { evidencePath: string }
    const evidence = JSON.parse(files.get(index.evidencePath)!) as { results: Array<{ agentId: string; audit: { evidencePath: string; evidenceHash: string } }> }
    const directoryOf = index.evidencePath.split('/').slice(0, -1)
    const resolve = (path: string): string => {
      const parts = [...directoryOf]
      for (const part of path.split('/')) {
        if (part === '..') parts.pop()
        else if (part !== '.' && part !== '') parts.push(part)
      }
      return parts.join('/')
    }
    // A seller file changed after the model audit named its hash.
    const sellerPath = resolve(evidence.results.find((result) => result.agentId === '2')!.audit.evidencePath)
    const altered = new Map(files)
    altered.set(sellerPath, files.get(sellerPath)!.replace('"mismatch"', '"match"'))
    assert.match(await decideWith(reader(altered, audit.evidenceHash)), /does not match the hash its model audit names/)
    // A hash-valid model audit that links agent 2's row to agent 3's file: a hash proves which file, not about whom.
    const relinked = structuredClone(evidence)
    relinked.results.find((result) => result.agentId === '2')!.audit = evidence.results.find((result) => result.agentId === '3')!.audit
    const relinkedFiles = new Map(files)
    relinkedFiles.set(index.evidencePath, canonicalJsonStringify(relinked))
    assert.match(await decideWith(reader(relinkedFiles, canonicalHashBytes32(relinked))), /linked for agent 2 is about another seller or service/)
    // A first look relabelled in a hash-valid publication: agent 3's questions DIFF stored as SAME, every hash rewritten
    // to match. The confirmer recomputes the look from the stored answers and refuses it.
    const relabelPath = resolve(evidence.results.find((result) => result.agentId === '3')!.audit.evidencePath)
    const sellerFile = JSON.parse(files.get(relabelPath)!) as { result: { verdict: string } }
    sellerFile.result.verdict = 'SAME'
    const relabelled = structuredClone(evidence)
    relabelled.results.find((result) => result.agentId === '3')!.audit.evidenceHash = canonicalHashBytes32(sellerFile)
    const relabelledFiles = new Map(files)
    relabelledFiles.set(relabelPath, canonicalJsonStringify(sellerFile))
    relabelledFiles.set(index.evidencePath, canonicalJsonStringify(relabelled))
    const relabelReason = await (async () => {
      const [decision] = await sameCheckFilter({ events: [report(3n, VERIFIER_VERDICT.DIFF)], auditor: second.address, reader: reader(relabelledFiles, canonicalHashBytes32(relabelled)) })(
        audit.modelHash, [candidate(3n, VERIFIER_VERDICT.DIFF, ['kbf'])],
      )
      return decision?.kind === 'hold' ? decision.reason : `not held: ${decision?.kind}`
    })()
    assert.match(relabelReason, /the questions' first look says SAME, but its stored answers give DIFF/)
    // An answer no seller signed, in a publication whose every hash was rewritten to match: the hashes prove which
    // files were published, and the confirmer checks the sellers' signatures itself.
    type SignedAuth = StoredSignedAnswer & { record: NonNullable<StoredSignedAnswer['record']> }
    type ForgedExchange = { responseAuth: SignedAuth; matches: Array<0 | 1 | null>; answers: Array<number | null> }
    const resigned = (auth: SignedAuth, signer: Wallet): string => {
      const { signature: _signature, receivedAt: _receivedAt, verified: _verified, verificationError: _verificationError, ...unsigned } = auth.record
      return bytesToHex(signData(signer, encodeResponseAuthSigningPayload(unsigned)))
    }
    const forgedReason = async (forge: (auth: SignedAuth, exchange: ForgedExchange) => void): Promise<string> => {
      const forgedFile = JSON.parse(files.get(sellerPath)!) as { exchanges: ForgedExchange[] }
      assert.equal(sellerSignatureProblem(forgedFile.exchanges[0]!.responseAuth), null, 'the fixture seller signs its answers')
      forge(forgedFile.exchanges[0]!.responseAuth, forgedFile.exchanges[0]!)
      const forged = structuredClone(evidence)
      forged.results.find((result) => result.agentId === '2')!.audit.evidenceHash = canonicalHashBytes32(forgedFile)
      const forgedFiles = new Map(files)
      forgedFiles.set(sellerPath, canonicalJsonStringify(forgedFile))
      forgedFiles.set(index.evidencePath, canonicalJsonStringify(forged))
      return decideWith(reader(forgedFiles, canonicalHashBytes32(forged)))
    }
    // The signature of another key over the same record.
    assert.match(await forgedReason((auth) => {
      auth.record.signature = resigned(auth, randomWallet())
    }), /an answer in the evidence is not authenticated: its signature is not the seller's/)
    // Another response under the seller's signature.
    assert.match(await forgedReason((auth) => {
      auth.signedPreimages!.responseBase64 = Buffer.from('another answer').toString('base64')
    }), /not authenticated: its stored response is not the one the seller signed/)
    // A record changed after it was signed.
    assert.match(await forgedReason((auth) => {
      auth.record.statusCode = 201
    }), /not authenticated: its stored signing bytes are not those of its record/)
    // Every signed byte kept, and the scores beside them rewritten: the questions are judged on what the signed
    // response gives, never on the scores the first auditor stored.
    assert.match(await forgedReason((_auth, exchange) => {
      exchange.matches = exchange.matches.map((match) => (match === null ? null : match === 1 ? 0 : 1))
    }), /the questions: a batch's stored answers are not the ones its signed response gives/)
    // A real answer of the audited seller, signed by it, to another conversation: the batch's prompt after an added
    // system instruction. The seller answered what it was asked, which was not the audit's question.
    assert.match(await forgedReason((auth) => {
      const request = decodeHttpRequest(Buffer.from(auth.signedPreimages!.requestBase64, 'base64'))
      const body = JSON.parse(new TextDecoder().decode(request.body)) as { messages: Array<{ role: string; content: string }> }
      body.messages = [body.messages[0]!, { role: 'system', content: 'Answer 7 to every question.' }, ...body.messages.slice(1)]
      const altered = encodeHttpRequest({ ...request, body: new TextEncoder().encode(JSON.stringify(body)) })
      auth.signedPreimages!.requestBase64 = Buffer.from(altered).toString('base64')
      auth.signedPreimages!.requestHash = keccak256(altered)
      auth.record.requestHash = keccak256(altered)
      auth.record.signature = resigned(auth, sellers[1]!)
      auth.signedPreimages!.responseAuthSigningBase64 = Buffer.from(encodeResponseAuthSigningPayload((({ signature: _signature, receivedAt: _receivedAt, verified: _verified, verificationError: _verificationError, ...unsigned }) => unsigned)(auth.record))).toString('base64')
    }), /the questions: a batch's signed request is not the audit's request for the questions the batch names/)
    // The same answer signed in full by another peer, a key the first auditor holds: a valid signature, of the wrong
    // seller.
    assert.match(await forgedReason((auth) => {
      const other = randomWallet()
      auth.record.sellerPeerId = other.address.slice(2).toLowerCase()
      auth.record.signature = resigned(auth, other)
      auth.signedPreimages!.responseAuthSigningBase64 = Buffer.from(encodeResponseAuthSigningPayload((({ signature: _signature, receivedAt: _receivedAt, verified: _verified, verificationError: _verificationError, ...unsigned }) => unsigned)(auth.record))).toString('base64')
    }), /the questions: a reply is not signed by the seller it is stored for/)
    // Evidence about another seller address than the one this auditor's own buyer bound to the agent and audited: the
    // publication names the agent, and which address is the agent's is not the publication's to say.
    const aboutAnother = async (peerId: string | undefined): Promise<string> => {
      const [decision] = await sameCheckFilter({ events: [report(2n, VERIFIER_VERDICT.DIFF)], auditor: second.address, reader: reader(files, audit.evidenceHash) })(
        audit.modelHash, [{ ...candidate(2n, VERIFIER_VERDICT.DIFF, ['tokens']), peerId }],
      )
      return decision?.kind === 'hold' ? decision.reason : `not held: ${decision?.kind}`
    }
    assert.match(await aboutAnother(peerIdOf(randomWallet())), /its evidence for agent 2 is about another seller address than the one this auditor audited as that agent/)
    assert.match(await aboutAnother(undefined), /about another seller address/, 'a result that names no seller address binds to no published evidence')
    // A path that leaves the publication.
    const escaping = new Map(files)
    escaping.set('publication.json', JSON.stringify({ ...index, evidencePath: `../../${index.evidencePath}` }))
    assert.match(await decideWith(reader(escaping, audit.evidenceHash)), /escapes its root/)
    // A gateway that fails, with text that is cleaned and bounded in the reason.
    const failing = { ...reader(files, audit.evidenceHash), fetchText: async () => { throw new Error(`gateway timeout ${'x'.repeat(500)} Bearer secret-token`) } }
    const reason = await decideWith(failing)
    assert.match(reason, /gateway timeout/)
    assert.doesNotMatch(reason, /secret-token/)
    assert.ok(reason.length < 450)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a waiting DIFF from an earlier round, a revoked auditor or one already recorded is not answered', async () => {
  currentModelHash = `0x${'11'.repeat(32)}`
  const never: PublishedFlagReader = {
    modelAudits: async () => { throw new Error('not read') },
    fetchText: async () => { throw new Error('not read') },
    reportRound: async () => 0,
    blockTimestamp: async () => REPORTED_AT,
  }
  const check = (events: ServiceAuditedEvent[], options: { revoked?: Set<string>; round?: number } = {}) => sameCheckFilter({
    events, auditor: second.address, reader: { ...never, reportRound: async () => options.round ?? 0 }, ...(options.revoked ? { revoked: options.revoked } : {}),
  })(currentModelHash, [candidate(2n, VERIFIER_VERDICT.DIFF, ['tokens'])])
  // A revocation moved the contract's round on with no event for the service: the old report no longer counts.
  assert.deepEqual(await check([report(2n, VERIFIER_VERDICT.DIFF)], { round: 1 }), [null])
  assert.deepEqual(await check([report(2n, VERIFIER_VERDICT.DIFF)], { revoked: new Set([first.address]) }), [null])
  assert.deepEqual(await check([report(2n, VERIFIER_VERDICT.DIFF, { reports: 2 })]), [null], 'a DIFF already recorded is not waiting')
})

test('submit leaves out a DIFF another check flagged, holds one it cannot read, and sends the same check', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-same-check-'))
  try {
    const { audit: firstAudit, files } = await firstAuditor(directory)
    const events = [2n, 3n, 4n].map((agentId) => report(agentId, VERIFIER_VERDICT.DIFF))
    // Agent 4's first report is from another transaction, whose model audit cannot be found.
    events[2] = { ...events[2]!, transactionHash: `0x${'ef'.repeat(32)}` }
    const filter = sameCheckFilter({ events, auditor: second.address, reader: reader(files, firstAudit.evidenceHash) })
    const confirming = await prepare(directory, second, 'second', [
      { ...fixture('2', 'DIFF', true), confirmsDiff: true },
      { ...fixture('3', 'DIFF', true), confirmsDiff: true },
      { ...fixture('4', 'DIFF', true), confirmsDiff: true },
    ], { sameCheck: filter })
    const [audit] = confirming.prepared.audits as [PreparedModelAudit]
    assert.deepEqual(audit.results.map((result) => [result.agentId, result.verdict]), [[2n, VERIFIER_VERDICT.DIFF]], 'only the same check is sent')
    const [sent] = audit.evidence.results
    assert.equal(sent?.confirmation?.sameCheck, 'tokens')
    assert.deepEqual(sent?.flaggedBy, ['tokens'])
    assert.match(sent?.verdictReason ?? '', /^tokenizer pre-check/, 'a confirmed DIFF keeps its own reason')
    const excluded = new Map(confirming.prepared.excluded.map((entry) => [entry.agentId, entry.reason]))
    assert.match(excluded.get('3') ?? '', /a DIFF is confirmed only by the same check, so nothing is sent and the seller keeps its record/)
    assert.match(excluded.get('4') ?? '', /could not be read from its published evidence \(no model audit was found/)
    assert.deepEqual(confirming.prepared.heldBack.map((line) => line.split(':')[0]), ['model-a 4'], 'only the unreadable one is tried again')

    // Right before the send the rule is decided again on fresh events: the same evidence still holds…
    assert.equal(await sameCheckChanged(audit.modelHash, audit.evidence.results, filter), null)
    // …and a first report that changed meanwhile (here: it is no longer waiting) makes it be built again.
    const later = sameCheckFilter({ events: [], auditor: second.address, reader: reader(files, firstAudit.evidenceHash) })
    assert.match(await sameCheckChanged(audit.modelHash, audit.evidence.results, later) ?? '', /the waiting DIFF it answers changed since its evidence was prepared/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a first look prepared before the other auditor\'s DIFF landed is decided again before it is sent', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-same-check-'))
  try {
    const { audit: firstAudit, files } = await firstAuditor(directory)
    // B prepares agent 3's DIFF (its pre-check) while nothing waits: a first look.
    const own = await prepare(directory, second, 'second', [fixture('3', 'DIFF', true)], {
      sameCheck: sameCheckFilter({ events: [], auditor: second.address, reader: reader(files, firstAudit.evidenceHash) }),
    })
    const [audit] = own.prepared.audits as [PreparedModelAudit]
    assert.equal(audit.evidence.results[0]?.confirmation, undefined)
    // A's DIFF on agent 3, by its questions, lands before B sends: B's evidence would now confirm another check.
    const now = sameCheckFilter({ events: [report(3n, VERIFIER_VERDICT.DIFF)], auditor: second.address, reader: reader(files, firstAudit.evidenceHash) })
    assert.match(await sameCheckChanged(audit.modelHash, audit.evidence.results, now) ?? '', /agent 3: .*a DIFF is confirmed only by the same check/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('with its evidence not published, submit sends no DIFF and says why', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-same-check-'))
  try {
    const { prepared } = await prepare(directory, first, 'first', [fixture('1', 'SAME'), fixture('2', 'DIFF', true)], { unpublishedDiffs: 'not published' })
    assert.deepEqual(prepared.audits[0]?.results.map((result) => [result.agentId, result.verdict]), [[1n, VERIFIER_VERDICT.SAME]])
    assert.deepEqual(prepared.excluded.map((entry) => [entry.agentId, entry.reason]), [['2', 'not published']])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('an UNDETERMINED answering a waiting DIFF is never sent, whether another check flagged or none decided', () => {
  const kbf: FirstFlag = { auditor: first.address, peerId: peerIdOf(sellers[1]!), evidenceUri: `ipfs://${CID}`, evidenceHash: '0x1', reportedAt: REPORTED_AT, checks: ['kbf'] }
  const otherFlagged = decide(candidate(2n, VERIFIER_VERDICT.UNDETERMINED, ['tokens']), [kbf])
  assert.equal(otherFlagged.kind, 'exclude')
  assert.match(otherFlagged.kind === 'exclude' ? otherFlagged.reason : '', /another check \(the token-count pre-check\) flagged and the questions, which flagged the waiting DIFF, did not decide; nothing is sent/)
  const undecided = decide(candidate(2n, VERIFIER_VERDICT.UNDETERMINED, []), [kbf])
  assert.match(undecided.kind === 'exclude' ? undecided.reason : '', /did not decide in this audit; nothing is sent, so the seller keeps its record/)
})

test('a first auditor\'s seller file about another model, or from another epoch, holds the result back', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-same-check-'))
  try {
    const { audit, files } = await firstAuditor(directory)
    const decideWith = async (published: PublishedFlagReader) => {
      const [decision] = await sameCheckFilter({ events: [report(2n, VERIFIER_VERDICT.DIFF)], auditor: second.address, reader: published })(
        audit.modelHash, [candidate(2n, VERIFIER_VERDICT.DIFF, ['tokens'])],
      )
      assert.equal(decision?.kind, 'hold')
      return decision?.kind === 'hold' ? decision.reason : ''
    }
    // The report is from more than eight days after the file was made: another epoch.
    assert.match(await decideWith({ ...reader(files, audit.evidenceHash), blockTimestamp: async () => REPORTED_AT + 9 * 86_400 }), /was not made in the epoch of its report/)
    // The report names another model than the file is about.
    const otherModel = `0x${'22'.repeat(32)}`
    const [decision] = await sameCheckFilter({ events: [report(2n, VERIFIER_VERDICT.DIFF, { modelHash: otherModel })], auditor: second.address, reader: {
      ...reader(files, audit.evidenceHash, { modelHash: otherModel }),
    } })(otherModel, [candidate(2n, VERIFIER_VERDICT.DIFF, ['tokens'])])
    assert.equal(decision?.kind, 'hold')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('before a confirmation is audited, the first checks are read and stored; unreadable or too recent ones are not audited now', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-same-check-'))
  try {
    const { audit, files } = await firstAuditor(directory)
    const target = (agentId: bigint) => ({ agentId, service: MODEL, waiting: [{ verdict: 'DIFF' as const, reports: 1, required: 2 }], ownReportedAt: null })
    const targets = () => new Map([[MODEL, new Map([['2', target(2n)], ['3', target(3n)]])]])
    const events = [report(2n, VERIFIER_VERDICT.DIFF), report(3n, VERIFIER_VERDICT.DIFF, { transactionHash: `0x${'ef'.repeat(32)}` })]
    const lines: string[] = []
    const read = targets()
    await attachFirstFlags(read, { events, auditor: second.address, reader: reader(files, audit.evidenceHash), now: REPORTED_AT + 2 * 3_600, log: (line) => lines.push(line) })
    assert.deepEqual(read.get(MODEL)!.get('2'), { ...target(2n), firstChecks: ['tokens'], firstReportedAt: REPORTED_AT })
    assert.equal(read.get(MODEL)!.has('3'), false, 'its first evidence cannot be read')
    assert.match(lines.join('\n'), /agent 3 is not audited now: which check flagged its waiting DIFF could not be read/)
    const early = targets()
    await attachFirstFlags(early, { events, auditor: second.address, reader: reader(files, audit.evidenceHash), now: REPORTED_AT + 600, log: () => {} })
    assert.equal(early.get(MODEL)!.has('2'), false, 'younger than an hour: audited by a later run')
    // A dry run's verifier.testTiming: ten minutes after the report is late enough with a five-minute delay.
    const timed = targets()
    await attachFirstFlags(timed, {
      events, auditor: second.address, reader: reader(files, audit.evidenceHash), now: REPORTED_AT + 600, log: () => {},
      timing: { confirmationMinDelaySeconds: 300 },
    })
    assert.equal(timed.get(MODEL)!.has('2'), true, 'five minutes after the report is fresh with verifier.testTiming')
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a dry run\'s verifier.testTiming shortens the fresh-material delay a confirmation is sent on; without it the rules\' hour stands', () => {
  const waiting: FirstFlag = { auditor: first.address, peerId: peerIdOf(sellers[2]!), evidenceUri: `ipfs://${CID}`, evidenceHash: '0x1', reportedAt: REPORTED_AT, checks: ['kbf'] }
  const soon = candidate(3n, VERIFIER_VERDICT.DIFF, ['kbf'], [], REPORTED_AT + 300)
  const rules = decide(soon, [waiting])
  assert.equal(rules.kind === 'exclude' && rules.code, 'confirmation-not-fresh')
  assert.equal(decide(soon, [waiting], undefined, null).kind, 'exclude')
  assert.equal(decide(soon, [waiting], undefined, { confirmationMinDelaySeconds: 300 }).kind, 'send')
  assert.equal(decide(soon, [waiting], undefined, { confirmationMinDelaySeconds: 301 }).kind, 'exclude')
})
