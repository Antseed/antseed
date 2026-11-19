import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Wallet } from 'ethers'
import { prepareModelAudits } from './model-audit.js'
import { FIXTURE_CONFIG, peerIdOf, referenceFixture, writeSignedAuditRun, type FixtureAudit } from './model-audit-fixtures.test-support.js'
import { PEERS, SERVICE, echoReference, echoScreenFor, fakeCapSeller, fakeEchoNetwork, runCapOn, tokens, wordReference } from './output-checks.test-support.js'
import { numberWords } from './output-cap.js'
import { loadEpochState, writeEpochSubmissionManifest } from './epoch-plan.js'
import { dryRunPreparedPath, writeDryRunPrepared } from './epoch-submission-record.js'
import type { FlipsV1 } from './flips.js'
import type { SameCheckDecision } from './same-check.js'

const MODEL = 'claude-opus-5.5'
const EPOCH = '7'
const words = (count: number): string => Array.from({ length: count }, (_value, index) => numberWords(301 + index)).join(', ')

/**
 * One known epoch, written through the build's own writers on mock sellers, then prepared as `submit --dry-run`
 * prepares it, with its prepared file. Every row has a known outcome. With `ANTSEED_KEEP_DRY_RUN_EPOCH` set, the tree
 * is kept there for the dry-run report's own check.
 */
test('a known epoch: every row is decided as its outcome says, and the dry run\'s prepared file holds it', async () => {
  // Kept, the tree is written where it stays: its manifests name their files by absolute path.
  const keep = process.env.ANTSEED_KEEP_DRY_RUN_EPOCH
  const directory = keep ? await mkdir(keep, { recursive: true }).then(() => keep) : await mkdtemp(join(tmpdir(), 'antseed-dry-run-epoch-'))
  try {
    const evidenceDir = join(directory, 'evidence')
    const banksDir = join(directory, 'banks')
    const auditor = new Wallet(Wallet.createRandom().privateKey)
    const wallets = Array.from({ length: 15 }, () => new Wallet(Wallet.createRandom().privateKey))
    const peer = (agent: number) => peerIdOf(wallets[agent - 1]!)
    // A cap flag and an echo flag with seller bytes behind them: the preparation recomputes both and sends them.
    const capFlag = await runCapOn(fakeCapSeller(() => ({ text: words(120), billed: 900 })), wordReference, peer(2))
    const crowd = PEERS.slice(1)
    const honest = Object.fromEntries(crowd.map((other) => [other, tokens]))
    const echoFlag = (await echoScreenFor(fakeEchoNetwork({ ...honest, [peer(3)]: (text) => Math.round(tokens(text) * 1.25) }), echoReference, [peer(3), ...crowd])
      .check({ peerId: peer(3), service: SERVICE }, null, { thinking: null, crowdThinking: null, precheckMatch: true }))!
    assert.deepEqual([capFlag.outcome, echoFlag.outcome], ['flag', 'flag'])
    // FLIPS is recorded only: a first pass, a first flag of a probe with its 40-reply follow-up, a reasoning mismatch.
    const flips = (stage: 'first' | 'confirm', outcome: FlipsV1['outcome'], p: number | null, extra: Partial<FlipsV1> = {}): FlipsV1 => ({
      rule: 'flips-v1', draw: { auditor: auditor.address, model: MODEL, epoch: EPOCH, seed: '00', stage, ...(extra.draw ?? {}) }, service: SERVICE,
      referenceUpstream: null, referenceOneProvider: true, pairs: [], reasks: 0, outcome, counted: false,
      score: p === null ? null : -Math.log10(p) * 2, scoreMax: null, p, reason: outcome, ...extra,
    } as FlipsV1)
    const probeDraw = { auditor: auditor.address, model: MODEL, epoch: EPOCH, seed: '00', stage: 'first' as const, probe: true as const }
    const at = (agent: number, verdict: FixtureAudit['verdict'], extra: Partial<FixtureAudit> = {}): FixtureAudit => ({
      agentId: String(agent), seller: wallets[agent - 1]!, model: MODEL, service: SERVICE, verdict, ...extra,
    })
    const closeReference = referenceFixture(MODEL, 20)
    const first: FixtureAudit[] = [
      at(1, 'SAME', { flips: flips('first', 'pass', 0.4) }),
      at(2, 'DIFF', { outputCap: capFlag }),
      // Its anchor is this audit's own matching pre-check.
      at(3, 'DIFF', { outputEcho: echoFlag, tokenizerMatch: true }),
      at(4, 'DIFF'),
      at(5, 'DIFF', { tokenizerMismatch: true }),
      at(6, 'SAME', { flips: flips('first', 'flag', 0.001, { draw: probeDraw, followUp: flips('confirm', 'flag', 0.0005, { draw: { ...probeDraw, stage: 'confirm', excluding: [] } }) }) }),
      at(7, 'SAME', { flips: flips('first', 'inconclusive', null, { profileMismatch: { code: 'seller-reasons', diagnosticScoreIgnoringProfile: { score: 9, scoreMax: null, p: 0.0004 }, sellerReasoningReplies: 20, sellerReplies: 20, sellerReasoningTokens: 800, referenceReasoningReplies: 0, referenceReplies: 80, referenceReasoningTokens: 0 } }) }),
      { ...at(8, 'SAME'), reference: closeReference, closeCall: { firstWrong: 7 } },
      { ...at(9, 'SAME'), reference: closeReference, closeCall: { firstWrong: 7, extensionWrong: 1 } },
      at(10, 'SAME'),
    ]
    const outage = { version: 1, code: 'transport_error', summary: 'connection reset', retryable: true, source: 'transport', affectedBatchCount: 1, totalBatchCount: 1, nextAction: 'retry later' }
    await writeSignedAuditRun({
      evidenceDir, banksDir, runId: 'run-1', epoch: EPOCH, auditor, audits: first, completedAt: '2026-10-07T00:02:00.000Z',
      failures: { [MODEL]: [{ peerId: peer(11), agentId: '11', service: SERVICE, status: 'FAILED', reason: 'connection reset', outcomeReason: outage as never }] },
      skipped: { [MODEL]: [{ peerId: peer(12), agentId: '12', service: SERVICE, status: 'SKIPPED', code: 'upstream_credentials_invalid', reason: 'the seller\'s upstream key is gone', source: 'runtime', evidencePath: null } as never] },
    })
    // Later: the failed seller's retry, and two confirmations of another auditor's reports, an hour after them.
    const reportedAt = Date.parse('2026-10-07T00:30:00.000Z') / 1_000
    await writeSignedAuditRun({
      evidenceDir, banksDir, runId: 'run-2', epoch: EPOCH, auditor, completedAt: '2026-10-07T02:30:00.000Z', audits: [
        at(11, 'SAME'),
        at(13, 'DIFF', { confirming: { checks: ['kbf'], reportedAt } }),
        at(14, 'SAME', { confirming: { checks: ['kbf'], reportedAt } }),
      ],
    })
    const state = await loadEpochState(evidenceDir, EPOCH)
    const manifest = await writeEpochSubmissionManifest(evidenceDir, state)
    const confirmation = { auditor: '0x' + '0b'.repeat(20), evidenceUri: 'ipfs://example', evidenceHash: '0x' + '00'.repeat(32), reportedAt, firstChecks: ['kbf'], ownChecks: ['kbf'], sameCheck: 'kbf' }
    const prepared = await prepareModelAudits({
      evidenceDir, banksDir, manifest, auditor: auditor.address, config: FIXTURE_CONFIG,
      // Agent 10 belongs to the auditor itself.
      resolveAgentOwner: async (agentId) => (agentId === 10n ? auditor.address : new Wallet(Wallet.createRandom().privateKey).address),
      sameCheck: async (_model, candidates) => candidates.map((candidate): SameCheckDecision | null => (
        candidate.agentId === 13n ? { kind: 'send', confirmation: confirmation as never }
          : candidate.agentId === 14n ? { kind: 'exclude', code: 'repeated-test-open', reason: 'the repeated test did not decide' }
            : null)),
    })
    await writeDryRunPrepared(evidenceDir, EPOCH, { runIds: state.manifests.map((entry) => entry.runId), decisions: prepared.decisions, alreadyOnChain: prepared.alreadyOnChain })

    const decided = Object.fromEntries(prepared.decisions.map((row) => [row.agentId, `${row.decision}${row.reasonCode ? ` ${row.reasonCode}` : ''}${row.decision === 'send' ? ` ${row.verdict}` : ''}`]))
    assert.deepEqual(decided, {
      1: 'send SAME', 2: 'send DIFF', 3: 'send DIFF', 4: 'send DIFF', 5: 'send DIFF', 6: 'send SAME', 7: 'send SAME',
      8: 'held close-call-waiting', 9: 'send SAME', 10: 'excluded self-audit', 11: 'send SAME', 12: 'excluded skipped',
      13: 'send DIFF', 14: 'excluded repeated-test-open',
    })
    // The cap and the echo flag are sent with the test that flagged them.
    const flaggedBy = Object.fromEntries(prepared.audits.flatMap((entry) => entry.evidence.results.map((result) => [result.agentId, result.flaggedBy])))
    assert.deepEqual([flaggedBy['2'], flaggedBy['3']], [['output-cap'], ['output-echo']])

    if (keep) {
      // What the tree holds, for the report's check: the epoch, the model and each agent's seller.
      await writeFile(join(keep, 'known-epoch.json'), JSON.stringify({
        epoch: EPOCH, model: MODEL, evidenceDir: join(keep, 'evidence'), preparedPath: dryRunPreparedPath(join(keep, 'evidence'), EPOCH),
        sellers: Object.fromEntries(wallets.map((wallet, index) => [String(index + 1), peerIdOf(wallet)])),
      }, null, 1))
    }
  } finally {
    if (!keep) await rm(directory, { recursive: true, force: true })
  }
})
