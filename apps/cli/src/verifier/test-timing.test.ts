import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Wallet } from 'ethers'
import { prepareModelAudits } from './model-audit.js'
import { FIXTURE_CONFIG, writeSignedAuditRun } from './model-audit-fixtures.test-support.js'
import { VerifierConfigSchema } from './config-schema.js'
import { CONFIRMATION_RECHECK_SPACING_SECONDS, SELLER_RETRY_SPACING_SECONDS } from './epoch-plan.js'
import { CONFIRMATION_WINDOW_SECONDS } from './pending-confirmations.js'
import { CONFIRMATION_MIN_DELAY_SECONDS } from './same-check.js'
import { PRODUCTION_AUDIT_TIMING, auditTiming, describeTestTiming, testTimingFor } from './test-timing.js'
import { verifierRulesFingerprint } from './verifier-compat.js'

const TIMING = { sellerRetrySpacingSeconds: 60, confirmationMinDelaySeconds: 120, confirmationRecheckSpacingSeconds: 30, confirmationWindowSeconds: 600 }

test('verifier.testTiming applies only while the chain RPC is on this machine; anywhere else it stops the command', () => {
  for (const rpcUrl of ['http://127.0.0.1:8545', 'http://localhost:8545', 'http://[::1]:8545']) {
    assert.deepEqual(testTimingFor(TIMING, rpcUrl), TIMING, rpcUrl)
  }
  assert.deepEqual(testTimingFor({ sellerRetrySpacingSeconds: 60 }, 'http://127.0.0.1:8545'), { sellerRetrySpacingSeconds: 60 }, 'only what it sets')
  assert.throws(() => testTimingFor(TIMING, 'https://mainnet.base.org'), /verifier\.testTiming is for a dry run on a local fork only.*not mainnet\.base\.org/)
  assert.throws(() => testTimingFor(TIMING, 'http://127.0.0.2:8545'), /local fork only/)
  assert.throws(() => testTimingFor(TIMING, undefined), /the default Base RPC/)
  // Not set (or set to nothing): the rules' waits, on any RPC.
  assert.equal(testTimingFor(undefined, 'https://mainnet.base.org'), null)
  assert.equal(testTimingFor({}, 'https://mainnet.base.org'), null)
})

test('without verifier.testTiming every wait is the rules\' and the rules carry the production values', () => {
  assert.deepEqual({ ...PRODUCTION_AUDIT_TIMING }, {
    sellerRetrySpacingSeconds: 30 * 60, confirmationMinDelaySeconds: 60 * 60, confirmationRecheckSpacingSeconds: 10 * 60, confirmationWindowSeconds: 12 * 60 * 60,
  })
  assert.deepEqual([SELLER_RETRY_SPACING_SECONDS, CONFIRMATION_MIN_DELAY_SECONDS, CONFIRMATION_RECHECK_SPACING_SECONDS, CONFIRMATION_WINDOW_SECONDS], [1_800, 3_600, 600, 43_200])
  assert.deepEqual(auditTiming(null), PRODUCTION_AUDIT_TIMING)
  assert.deepEqual(auditTiming({ sellerRetrySpacingSeconds: 60 }), { ...PRODUCTION_AUDIT_TIMING, sellerRetrySpacingSeconds: 60 })
  // The rules carry the production values; `verifier-compat.test.ts` pins their hash for compat 5.
  const fingerprint = verifierRulesFingerprint() as unknown as Record<string, Record<string, unknown>>
  const window = fingerprint['window']!
  assert.equal(window['sellerRetrySpacingSeconds'], SELLER_RETRY_SPACING_SECONDS)
  assert.equal(window['confirmationRecheckSpacingSeconds'], CONFIRMATION_RECHECK_SPACING_SECONDS)
  assert.equal(window['confirmationWindowSeconds'], CONFIRMATION_WINDOW_SECONDS)
  assert.equal(fingerprint['confirmation']!['minDelaySeconds'], CONFIRMATION_MIN_DELAY_SECONDS)
})

test('the setting: four optional positive whole seconds, nothing else, and one line naming what it shortens', () => {
  assert.ok(VerifierConfigSchema.safeParse({ testTiming: TIMING }).success)
  assert.ok(VerifierConfigSchema.safeParse({ testTiming: { confirmationWindowSeconds: 600 } }).success)
  assert.equal(VerifierConfigSchema.safeParse({ testTiming: { ...TIMING, epochCutoffSeconds: 60 } }).success, false)
  assert.equal(VerifierConfigSchema.safeParse({ testTiming: { confirmationWindowSeconds: 0 } }).success, false)
  assert.equal(VerifierConfigSchema.safeParse({ testTiming: { sellerRetrySpacingSeconds: 1.5 } }).success, false)
  assert.equal(
    describeTestTiming({ sellerRetrySpacingSeconds: 60, confirmationMinDelaySeconds: 90 }),
    'verifier.testTiming is set: seller retry 1 min (rules: 30 min), confirmation delay 90 s (rules: 1 h). '
      + 'For a dry run on a local fork only; every auditor in the test must use the same values.',
  )
})

test('a run\'s test timing is in the evidence it publishes, so a reader tells it from the rules\'; a run without one publishes none', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-test-timing-evidence-'))
  try {
    const evidenceDir = join(directory, 'evidence')
    const banksDir = join(directory, 'banks')
    const auditor = new Wallet(Wallet.createRandom().privateKey)
    const seller = new Wallet(Wallet.createRandom().privateKey)
    const manifest = await writeSignedAuditRun({
      evidenceDir, banksDir, runId: 'run-1', epoch: '7', auditor, audits: [{ agentId: '1', seller, model: 'model-a', service: 'model-a', verdict: 'SAME' }],
    })
    const evidence = async (run: typeof manifest) => (await prepareModelAudits({
      evidenceDir, banksDir, manifest: run, auditor: auditor.address, config: FIXTURE_CONFIG,
      resolveAgentOwner: async () => new Wallet(Wallet.createRandom().privateKey).address,
    })).audits.map((audit) => audit.evidence)
    const plain = await evidence(manifest)
    assert.equal(plain.length, 1)
    assert.equal('testTiming' in plain[0]!, false, 'production evidence is as before')
    const timed = await evidence({ ...manifest, testTiming: { sellerRetrySpacingSeconds: 60 } })
    assert.deepEqual(timed.map((entry) => entry.testTiming), [{ sellerRetrySpacingSeconds: 60 }])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
