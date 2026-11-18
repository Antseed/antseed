import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Wallet } from 'ethers'
import { canonicalHashBytes32, canonicalJsonStringify } from '@antseed/fingerprints'
import { VERIFIER_VERDICT, serviceHash, type ModelAuditedEvent, type ServiceAuditedEvent, type VerifierVerdict } from '@antseed/node/payments'
import { flaggingChecks, passedChecks } from './flagging-checks.js'
import { prepareAuditPublication } from './ipfs-publication.js'
import { modelAuditUpstreams, prepareModelAudits, writeModelAuditEvidence, type PreparedModelAudit } from './model-audit.js'
import { FIXTURE_CONFIG, referenceFixture, writeSignedAuditRun, type FixtureAudit } from './model-audit-fixtures.test-support.js'
import {
  CONFIRMATION_MIN_DELAY_SECONDS,
  decide,
  sameCheckFilter,
  type FirstFlag,
  type PublishedFlagReader,
  type SameCheckCandidate,
} from './same-check.js'
import { sameCheckChanged } from '../cli/commands/verifier/submit.js'

const randomWallet = (): Wallet => new Wallet(Wallet.createRandom().privateKey)
const first = randomWallet()
const second = randomWallet()
const sellers = [randomWallet(), randomWallet(), randomWallet(), randomWallet()]
const MODEL = 'model-a'
const CID = 'bafytestfirstauditor'
const TX = `0x${'ab'.repeat(32)}`
/** The first report's block time; every fixture audit is made well over an hour after it. */
const REPORTED_AT = 1_000

const fixture = (agentId: string, verdict: FixtureAudit['verdict'], tokenizerMismatch = false): FixtureAudit => ({
  agentId, seller: sellers[Number(agentId) - 1]!, model: MODEL, service: MODEL, verdict, ...(tokenizerMismatch ? { tokenizerMismatch } : {}),
})

async function prepare(directory: string, auditor: Wallet, runId: string, audits: FixtureAudit[], options: {
  sameCheck?: Parameters<typeof prepareModelAudits>[0]['sameCheck']
  unpublishedDiffs?: string
} = {}) {
  const evidenceDir = join(directory, runId, 'evidence')
  const banksDir = join(directory, runId, 'banks')
  const manifest = await writeSignedAuditRun({ evidenceDir, banksDir, runId, epoch: '7', auditor, audits })
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

function reader(files: Map<string, string>, evidenceHash: string, overrides: Partial<ModelAuditedEvent> = {}): PublishedFlagReader & { fetched: string[] } {
  const fetched: string[] = []
  return {
    fetched,
    async modelAudits() {
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
): SameCheckCandidate => ({ agentId, serviceHash: serviceHash(MODEL), verdict, auditedAt, flaggedBy, passedBy })

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

test('a result answering a waiting DIFF is sent only when the same check flagged, or a check that flagged passed', () => {
  const tokens: FirstFlag = { auditor: first.address, evidenceUri: `ipfs://${CID}`, evidenceHash: '0x1', reportedAt: REPORTED_AT, checks: ['tokens'] }
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
    assert.equal(decisions[3], null, 'an UNDETERMINED follows the existing rules')
    assert.equal(decisions[4], null, 'a DIFF with no waiting DIFF to answer is a first look')
    assert.equal(published.fetched.filter((path) => path.endsWith('publication.json')).length, 1, 'the publication is read once per transaction')
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
