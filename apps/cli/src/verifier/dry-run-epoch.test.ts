import { AUDIT_TEST_COUNTS } from './audit-test-counts.js'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Wallet } from 'ethers'
import { prepareModelAudits } from './model-audit.js'
import { sameCheckChanged } from '../cli/commands/verifier/submit.js'
import { FIXTURE_CONFIG, peerIdOf, referenceFixture, writeSignedAuditRun, type FixtureAudit } from './model-audit-fixtures.test-support.js'
import { PEERS, SERVICE, echoReference, echoScreenFor, fakeCapSeller, fakeEchoNetwork, runCapOn, signedFlipsRecord, tokens, wordReference } from './methods/shared/output-checks.test-support.js'
import { numberWords } from './methods/output-cap/output-cap.js'
import { loadEpochState, writeEpochSubmissionManifest } from './epoch-plan.js'
import { auditWindowSellersLeft, closeFinishedAuditWindows, openAuditWindow, readAuditWindow } from './audit-window.js'
import { closeFinishedWindowsRecovering, recoveringFirstLooks } from './first-look-recovery.js'
import { dryRunPreparedPath, writeDryRunPrepared } from './epoch-submission-record.js'
import type { FlipsV1 } from './methods/flips/flips.js'
import { decide, type FirstFlag, type SameCheckCandidate, type SameCheckDecision } from './same-check.js'

const MODEL = 'claude-opus-5.5'
/** A second model whose audit window holds one seller: its first look's DIFF is damaged, then recovered in the window. */
const WINDOWED = 'claude-sonnet-5.5'
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
    const wallets = Array.from({ length: 17 }, () => new Wallet(Wallet.createRandom().privateKey))
    // The second model's window opens before its first look, for its one seller.
    await openAuditWindow({ evidenceDir, epoch: EPOCH, model: WINDOWED, runId: 'run-1', sellers: [peerIdOf(wallets[14]!)], now: () => Date.parse('2026-10-07T00:01:00.000Z') })
    const peer = (agent: number) => peerIdOf(wallets[agent - 1]!)
    // A cap flag and an echo flag with seller bytes behind them: the preparation recomputes both and sends them.
    const capFlag = await runCapOn(fakeCapSeller(() => ({ text: words(120), billed: 900 })), wordReference, peer(2))
    const crowd = PEERS.slice(1)
    const honest = Object.fromEntries(crowd.map((other) => [other, tokens]))
    const echoFlag = (await echoScreenFor(fakeEchoNetwork({ ...honest, [peer(3)]: (text) => Math.round(tokens(text) * 1.25) }), echoReference, [peer(3), ...crowd])
      .check({ peerId: peer(3), service: SERVICE }, null, { thinking: null, crowdThinking: null, precheckMatch: true }))!
    assert.deepEqual([capFlag.outcome, echoFlag.outcome], ['flag', 'flag'])
    // FLIPS recorded only (a rule this CLI does not know): a first pass, a first flag of a probe with its 40-reply
    // follow-up, a reasoning mismatch.
    const flips = (stage: 'first' | 'confirm', outcome: FlipsV1['outcome'], p: number | null, extra: Partial<FlipsV1> = {}): FlipsV1 => ({
      rule: 'flips-v0', draw: { auditor: auditor.address, model: MODEL, epoch: EPOCH, seed: '00', stage, ...(extra.draw ?? {}) }, service: SERVICE,
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
      { ...at(15, 'DIFF'), model: WINDOWED },
    ]
    const outage = { version: 1, code: 'transport_error', summary: 'connection reset', retryable: true, source: 'transport', affectedBatchCount: 1, totalBatchCount: 1, nextAction: 'retry later' }
    await writeSignedAuditRun({
      evidenceDir, banksDir, runId: 'run-1', epoch: EPOCH, auditor, audits: first, completedAt: '2026-10-07T00:02:00.000Z',
      failures: { [MODEL]: [{ peerId: peer(11), agentId: '11', service: SERVICE, status: 'FAILED', reason: 'connection reset', outcomeReason: outage as never }] },
      skipped: { [MODEL]: [{ peerId: peer(12), agentId: '12', service: SERVICE, status: 'SKIPPED', code: 'upstream_credentials_invalid', reason: 'the seller\'s upstream key is gone', source: 'runtime', evidencePath: null } as never] },
    })
    // The windowed seller's evidence file is damaged after it was written: submit would refuse its DIFF.
    const firstRun = await (async () => {
      const state = await loadEpochState(evidenceDir, EPOCH)
      return [...state.ordinaryCells!.values()].find((cell) => cell.model === WINDOWED)!
    })()
    await writeFile(firstRun.result!.evidencePath, 'damaged')
    {
      const state = await loadEpochState(evidenceDir, EPOCH)
      const window = (await readAuditWindow(evidenceDir, EPOCH, WINDOWED))!
      const recovering = new Set((await recoveringFirstLooks(state)).keys())
      // Its cell reads done, but it is still to be recovered: the window stays open for it.
      assert.deepEqual(auditWindowSellersLeft(window, state), [], 'without the recovery the window would close on a DIFF that cannot be sent')
      assert.deepEqual(auditWindowSellersLeft(window, state, recovering), [peer(15)])
      await closeFinishedAuditWindows({ evidenceDir, epoch: EPOCH, state, secondsLeftInEpoch: 86_400, recovering })
      assert.equal((await readAuditWindow(evidenceDir, EPOCH, WINDOWED))?.state, 'open')
      // A submit in the spacing makes the same close (run, submit, run): the window stays open for the recovery.
      await closeFinishedWindowsRecovering({ evidenceDir, epoch: EPOCH, state, secondsLeftInEpoch: 86_400 })
      assert.equal((await readAuditWindow(evidenceDir, EPOCH, WINDOWED))?.state, 'open', 'a submit between the runs does not close it')
    }
    // Later: the failed seller's retry, the windowed seller's recovery, and two confirmations of another auditor's
    // reports, an hour after them.
    const reportedAt = Date.parse('2026-10-07T00:30:00.000Z') / 1_000
    // A seller that is no random source: nearly every symbol the pair's first word, the two others placed by the slot so
    // no reply repeats another. It flags at either stage's bar.
    const flipsOf = (agent: number, stage: 'first' | 'confirm') => signedFlipsRecord({
      draw: { auditor: auditor.address, model: MODEL, epoch: EPOCH, seed: `${stage}-${agent}`, stage }, service: SERVICE, peerId: peer(agent),
      seller: wallets[agent - 1]!, buyer: auditor.address,
      reply: (pair, slot) => Array.from({ length: 64 }, (_, index) => pair[index === slot || index === 63 - slot * 2 ? 1 : 0]).join(' '),
    })
    assert.deepEqual([flipsOf(16, 'confirm').outcome, flipsOf(16, 'confirm').counted, flipsOf(17, 'first').outcome], ['flag', true, 'flag'])
    // FLIPS's own rule counts the model, but the table of which tests count does not count FLIPS today
    // (`AUDIT_TEST_COUNTS`): both flags are recorded only.
    assert.equal(AUDIT_TEST_COUNTS.flips, false)
    await writeSignedAuditRun({
      evidenceDir, banksDir, runId: 'run-2', epoch: EPOCH, auditor, completedAt: '2026-10-07T02:30:00.000Z', audits: [
        at(11, 'SAME'),
        { ...at(15, 'DIFF'), model: WINDOWED },
        at(13, 'DIFF', { confirming: { checks: ['kbf'], reportedAt } }),
        at(14, 'SAME', { confirming: { checks: ['kbf'], reportedAt } }),
        // Two answers to another auditor's FLIPS-only report, both flagged by a signed FLIPS that is recorded only: a
        // confirmation of FLIPS (the confirm stage), undecided, and an untagged first look (the first stage), whose
        // questions pass, so it is a SAME.
        at(16, 'UNDETERMINED', { questionsVerdict: 'SAME', confirming: { checks: ['flips'], reportedAt }, flips: flipsOf(16, 'confirm') }),
        at(17, 'SAME', { questionsVerdict: 'SAME', flips: flipsOf(17, 'first') }),
      ],
    })
    const state = await loadEpochState(evidenceDir, EPOCH)
    // Recovered in its window: nothing is left, and the window closes.
    assert.equal((await recoveringFirstLooks(state)).size, 0)
    await closeFinishedAuditWindows({ evidenceDir, epoch: EPOCH, state, secondsLeftInEpoch: 86_400, recovering: new Set((await recoveringFirstLooks(state)).keys()) })
    assert.equal((await readAuditWindow(evidenceDir, EPOCH, WINDOWED))?.state, 'closed')
    const manifest = await writeEpochSubmissionManifest(evidenceDir, state)
    const flipsReport: FirstFlag = { auditor: '0x' + '0c'.repeat(20), peerId: 'aa'.repeat(20), evidenceUri: 'ipfs://flips', evidenceHash: '0x' + '01'.repeat(32), reportedAt, checks: ['flips'] }
    const confirmation = { auditor: '0x' + '0b'.repeat(20), evidenceUri: 'ipfs://example', evidenceHash: '0x' + '00'.repeat(32), reportedAt, firstChecks: ['kbf'], ownChecks: ['kbf'], sameCheck: 'kbf' }
    const prepared = await prepareModelAudits({
      evidenceDir, banksDir, manifest, auditor: auditor.address, config: FIXTURE_CONFIG,
      // Agent 10 belongs to the auditor itself.
      resolveAgentOwner: async (agentId) => (agentId === 10n ? auditor.address : new Wallet(Wallet.createRandom().privateKey).address),
      sameCheck: async (_model, candidates) => candidates.map((candidate): SameCheckDecision | null => (
        candidate.agentId === 13n ? { kind: 'send', confirmation: confirmation as never }
          : candidate.agentId === 14n ? { kind: 'exclude', code: 'repeated-test-open', reason: 'the repeated test did not decide' }
            // The real decision for the two answers to the FLIPS-only report.
            : candidate.agentId === 16n || candidate.agentId === 17n ? decide(candidate, [flipsReport])
              : null)),
    })
    await writeDryRunPrepared(evidenceDir, EPOCH, { runIds: state.manifests.map((entry) => entry.runId), decisions: prepared.decisions, alreadyOnChain: prepared.alreadyOnChain })

    const decided = Object.fromEntries(prepared.decisions.map((row) => [row.agentId, `${row.decision}${row.reasonCode ? ` ${row.reasonCode}` : ''}${row.decision === 'send' ? ` ${row.verdict}` : ''}`]))
    assert.deepEqual(decided, {
      1: 'send SAME', 2: 'send DIFF', 3: 'send DIFF', 4: 'send DIFF', 5: 'send DIFF', 6: 'send SAME', 7: 'send SAME',
      8: 'held close-call-waiting', 9: 'send SAME', 10: 'excluded self-audit', 11: 'send SAME', 12: 'excluded skipped',
      13: 'send DIFF', 14: 'excluded repeated-test-open', 15: 'send DIFF',
      // While FLIPS is recorded only, a confirmation of a FLIPS flag can decide nothing: never sent. The untagged first
      // look's SAME cannot clear the FLIPS report, whose test neither flagged nor passed here: not sent either.
      16: 'excluded confirmation-undecided', 17: 'excluded repeated-test-open',
    })
    // The cap and the echo flag are sent with the test that flagged them.
    const flaggedBy = Object.fromEntries(prepared.audits.flatMap((entry) => entry.evidence.results.map((result) => [result.agentId, result.flaggedBy])))
    assert.deepEqual([flaggedBy['2'], flaggedBy['3']], [['output-cap'], ['output-echo']])
    // The report a confirmation answers goes out with its row, from its evidence: the final reread right before sending
    // (`sameCheckChanged`) decides on it again and finds the decision unchanged; a first look carries none.
    const sentRows = prepared.audits.flatMap((entry) => entry.evidence.results)
    assert.deepEqual(sentRows.find((row) => row.agentId === '13')?.confirming, { checks: ['kbf'], reportedAt })
    assert.equal(sentRows.find((row) => row.agentId === '1')?.confirming, undefined)
    // No FLIPS row is sent, and no row is flagged by FLIPS.
    assert.equal(sentRows.some((row) => row.agentId === '16' || row.agentId === '17' || (row.flaggedBy ?? []).includes('flips')), false)
    // The final reread right before sending: the confirmation of the questions is sent as prepared; had its report
    // changed since, it is held and built again.
    const kbfReport: FirstFlag = { ...flipsReport, checks: ['kbf'] }
    const reread = (report: FirstFlag) => async (_model: string, candidates: readonly SameCheckCandidate[]) => candidates.map((candidate): SameCheckDecision | null => (
      candidate.agentId !== 13n ? null
        : report.reportedAt === reportedAt ? { kind: 'send', confirmation: confirmation as never }
          : { kind: 'exclude', code: 'confirms-another-report', reason: 'this audit confirms another report than the DIFF waiting now; it is not sent, and the seller is audited again' }))
    for (const entry of prepared.audits) assert.equal(await sameCheckChanged(entry.modelHash, entry.evidence.results, reread(kbfReport)), null)
    const changed = await Promise.all(prepared.audits.map((entry) => sameCheckChanged(entry.modelHash, entry.evidence.results, reread({ ...kbfReport, reportedAt: reportedAt + 60 }))))
    assert.ok(changed.some((reason) => /confirms another report/.test(reason ?? '')))

    if (keep) {
      // What the tree holds, for the report's check: the epoch, the model and each agent's seller.
      await writeFile(join(keep, 'known-epoch.json'), JSON.stringify({
        epoch: EPOCH, model: MODEL, windowedModel: WINDOWED, evidenceDir: join(keep, 'evidence'), preparedPath: dryRunPreparedPath(join(keep, 'evidence'), EPOCH),
        sellers: Object.fromEntries(wallets.map((wallet, index) => [String(index + 1), peerIdOf(wallet)])),
      }, null, 1))
    }
  } finally {
    if (!keep) await rm(directory, { recursive: true, force: true })
  }
})
