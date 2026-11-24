import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Wallet } from 'ethers'
import { modelAuditsDirectory } from './audit-artifacts.js'
import { prepareModelAudits, testsWithoutRecord } from './model-audit.js'
import { FIXTURE_CONFIG, writeSignedAuditRun, type FixtureAudit } from './model-audit-fixtures.test-support.js'
import type { ProxyAuditEvidenceV1 } from './proxy-evidence.js'

const randomWallet = (): Wallet => new Wallet(Wallet.createRandom().privateKey)
const reference = (check: string, record: unknown) => ({ version: 1, kind: 'antseed-verifier-output-check-reference', model: 'model-a', check, record })
const flipsStatus = (extra: Record<string, unknown>) => ({ version: 1, kind: 'antseed-verifier-flips-status', model: 'model-a', unavailable: [], ...extra })
/** Evidence with only what `testsWithoutRecord` reads: which tests kept a record, and whether it is a confirmation. */
const evidence = (slots: Record<string, unknown> = {}): ProxyAuditEvidenceV1 => slots as unknown as ProxyAuditEvidenceV1

async function runFolder(files: Record<string, unknown>): Promise<{ root: string; evidencePath: string }> {
  const root = await mkdtemp(join(tmpdir(), 'antseed-no-record-'))
  const run = join(root, 'audits', 'run-1')
  await mkdir(join(run, 'sellers', 'seller-1'), { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    await writeFile(join(run, name), typeof content === 'string' ? content : JSON.stringify(content))
  }
  return { root, evidencePath: join(run, 'sellers', 'seller-1', 'evidence.json') }
}

test('a test without a record names the reason its own reference wrote for the model, and nothing else', async () => {
  const { root, evidencePath } = await runFolder({
    'output-cap-reference.json': reference('output-cap', { applies: false, reason: 'the reference\'s own answer could not be measured, so the cap check does not apply to the model this run' }),
    'output-echo-reference.json': reference('output-echo', { applies: false, reason: 'the reference did not echo cleanly (the reference\'s echo is not usable (not finished)), so the echo check does not apply to the model this run' }),
    'flips-status.json': flipsStatus({ unavailable: [
      { stage: 'confirm', code: 'reference-failed', detail: 'the confirmation\'s reference failed' },
      { stage: 'first', code: 'check-failed', detail: 'one seller\'s own failure' },
      { stage: 'first', code: 'reference-failed', detail: 'the reference answered 8 of its 80 requests after asking the rest again' },
    ] }),
  })
  try {
    assert.deepEqual(await testsWithoutRecord(evidencePath, evidence()), [
      { slot: 'outputCap', reason: 'the reference\'s own answer could not be measured, so the cap check does not apply to the model this run' },
      { slot: 'outputEcho', reason: 'the reference did not echo cleanly (the reference\'s echo is not usable (not finished)), so the echo check does not apply to the model this run' },
      { slot: 'flips', reason: 'the reference answered 8 of its 80 requests after asking the rest again' },
    ])
    // A confirmation of FLIPS reads the confirmation stage's reference.
    assert.deepEqual((await testsWithoutRecord(evidencePath, evidence({ confirming: { checks: ['flips'] } }))).find((entry) => entry.slot === 'flips'),
      { slot: 'flips', reason: 'the confirmation\'s reference failed' })
    // A confirmation of another test asks FLIPS as a first look, so it names the first stage's reference, also among
    // several tests confirmed.
    for (const checks of [['output-cap'], ['tokens', 'kbf']]) {
      assert.deepEqual((await testsWithoutRecord(evidencePath, evidence({ confirming: { checks } }))).find((entry) => entry.slot === 'flips'),
        { slot: 'flips', reason: 'the reference answered 8 of its 80 requests after asking the rest again' }, checks.join(' and '))
    }
    assert.deepEqual((await testsWithoutRecord(evidencePath, evidence({ confirming: { checks: ['output-cap', 'flips'] } }))).find((entry) => entry.slot === 'flips'),
      { slot: 'flips', reason: 'the confirmation\'s reference failed' })
    // A test that kept a record has no entry, whatever its reference file says.
    assert.deepEqual((await testsWithoutRecord(evidencePath, evidence({ outputCap: {}, flips: {} }))).map((entry) => entry.slot), ['outputEcho'])
    // The tokenizer pre-check always keeps a record when it ran: it never has an entry.
    assert.equal((await testsWithoutRecord(evidencePath, evidence())).some((entry) => entry.slot === 'tokenizerPrecheck'), false)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a reference that applied, a seller\'s own failure, and a file that is missing or unreadable give no entry', async () => {
  const { root, evidencePath } = await runFolder({
    'output-cap-reference.json': reference('output-cap', { applies: true, reason: 'the reference kept a limit of 30 (billed 30) and its answer measures 30' }),
    'output-echo-reference.json': 'not json',
    'flips-status.json': flipsStatus({ unavailable: [{ stage: 'first', code: 'check-failed', detail: 'the seller\'s slots ran out FLIPS\'s time' }] }),
  })
  try {
    assert.deepEqual(await testsWithoutRecord(evidencePath, evidence()), [])
    // No file at all, and evidence that is not in a run's sellers folder.
    assert.deepEqual(await testsWithoutRecord(join(root, 'audits', 'run-2', 'sellers', 'seller-1', 'evidence.json'), evidence()), [])
    assert.deepEqual(await testsWithoutRecord(join(root, 'elsewhere', 'evidence.json'), evidence()), [])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a run with no FLIPS at all says so, and a long or unclean reason is cleaned and cut', async () => {
  const { root, evidencePath } = await runFolder({
    'flips-status.json': flipsStatus({ keyFailed: 'the randomness key could not be read' }),
    'output-echo-reference.json': reference('output-echo', { applies: false, reason: `reference endpoint 401: Bearer secret-token-123 ${'x'.repeat(600)}` }),
  })
  try {
    const found = await testsWithoutRecord(evidencePath, evidence())
    assert.deepEqual(found.find((entry) => entry.slot === 'flips'), { slot: 'flips', reason: 'no randomness check this run: the randomness key could not be read' })
    const echo = found.find((entry) => entry.slot === 'outputEcho')!
    assert.equal(echo.reason.length, 300)
    assert.doesNotMatch(echo.reason, /secret-token/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('a published seller result carries the evidence\'s own tests without a record and which tests were active; files beside the run are not read for it', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-no-record-publish-'))
  try {
    const auditor = randomWallet()
    const evidenceDir = join(directory, 'evidence')
    const banksDir = join(directory, 'banks')
    const prepare = async (runId: string, audit: Partial<FixtureAudit>, files: Record<string, unknown>) => {
      const audits = [{ agentId: '1', seller: randomWallet(), model: 'model-a', service: 'model-a', verdict: 'SAME' as const, ...audit }]
      const manifest = await writeSignedAuditRun({ evidenceDir, banksDir, runId, epoch: '7', auditor, audits })
      const run = modelAuditsDirectory(evidenceDir, '7', 'model-a', runId)
      for (const [name, content] of Object.entries(files)) await writeFile(join(run, name), JSON.stringify(content))
      const prepared = await prepareModelAudits({
        evidenceDir, banksDir, manifest, auditor: auditor.address, resolveAgentOwner: async () => randomWallet().address, config: FIXTURE_CONFIG,
      })
      assert.deepEqual(prepared.excluded, [])
      return prepared.audits[0]!.evidence.results[0]!
    }
    // The run had none of the tests for the model: each is named with its reason, and none is active, so the questions'
    // SAME stands. FLIPS is not active by its rule (recorded only), before any reason of the run.
    const none = await prepare('run-a', {}, {})
    assert.deepEqual(none.noRecord?.map((entry) => entry.slot), ['tokenizerPrecheck', 'outputCap', 'outputEcho', 'flips'])
    assert.deepEqual(none.inactive?.map((entry) => [entry.check, entry.cause]), [
      ['tokens', 'run'], ['output-cap', 'run'], ['output-echo', 'run'], ['output-offset', 'run'], ['flips', 'rule'],
    ])
    assert.equal(none.verdict, 'SAME')
    // Only the echo check was switched off by its reference: the others are active and did not run for the seller, so it
    // is UNDETERMINED, and a reason file beside the run for another test changes nothing (the evidence says it).
    const echoOff = await prepare('run-b', {
      verdict: 'UNDETERMINED', questionsVerdict: 'SAME',
      noRecord: [{ slot: 'outputEcho', reason: 'the reference did not echo cleanly, so the echo check does not apply to the model this run' }],
    }, {
      'output-cap-reference.json': reference('output-cap', { applies: false, reason: 'the reference\'s own answer could not be measured' }),
    })
    assert.deepEqual(echoOff.noRecord, [{ slot: 'outputEcho', reason: 'the reference did not echo cleanly, so the echo check does not apply to the model this run' }])
    assert.deepEqual(echoOff.inactive?.map((entry) => entry.check), ['output-echo', 'output-offset', 'flips'])
    assert.equal(echoOff.verdict, 'UNDETERMINED')
    assert.match(echoOff.verdictReason ?? '', /the token-count pre-check did not run for this seller; the cap check did not run for this seller$/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
