import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { writeJsonAtomic } from './atomic-files.js'
import { modelHash } from '@antseed/node/payments'
import {
  buildEpochOverview, epochOverviewPath, renderEpochOverview, writeEpochOverview, type EpochOverview, type OverviewCell,
} from './epoch-overview.js'
import { disputeKey } from './pending-confirmations.js'
import { explainInconclusive, explainSkipReason } from './plain-reason.js'
import { emptyAuditCostSummary } from './proxy-evidence.js'

function result(peerId: string, agentId: string, status: 'SAME' | 'DIFF' | 'UNDETERMINED', extra: Record<string, unknown> = {}) {
  return {
    peerId, displayName: `Seller ${agentId}`, agentId, service: 'model-a', status, auditId: `${peerId}-${status}`,
    parsedProbeCount: 90, probeCount: 100, correctProbeCount: 50, incorrectProbeCount: 40, correctRate: 0.55,
    requestCount: 10, cost: emptyAuditCostSummary(), evidencePath: 'e.json', evidenceHash: '0x00', ...extra,
  }
}

async function writeRun(dir: string, runId: string, completedAt: string, summary: Record<string, unknown>) {
  const summaryPath = join(dir, `${runId}-model-a.json`)
  await writeJsonAtomic(summaryPath, {
    version: 1, kind: 'antseed-verifier-model-summary', runId, epoch: '9', model: 'model-a',
    startedAt: completedAt, completedAt, failures: [], skipped: [], results: [], cost: emptyAuditCostSummary(), ...summary,
  })
  await writeJsonAtomic(join(dir, 'runs', `${runId}.json`), {
    version: 1, kind: 'antseed-verifier-run-manifest', runId, state: 'completed', epoch: '9', epochSource: 'onchain',
    epochStartedAt: completedAt, epochEndsAt: completedAt, startedAt: completedAt, completedAt,
    summaryPath: join(dir, 'runs', `${runId}.summary.json`), modelOrder: ['model-a'],
    models: [{ model: 'model-a', summaryPath, resultCount: 0, failureCount: 0, skippedCount: 0, cost: emptyAuditCostSummary() }],
    failureCount: 0,
  })
}

test('epoch overview merges runs in submit order; a DIFF counts as found', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-overview-'))
  try {
    await writeRun(dir, 'run-1', '2026-10-01T00:00:00.000Z', {
      results: [
        result('p1', '1', 'SAME'),
        result('p2', '2', 'DIFF'),
        result('p3', '3', 'UNDETERMINED', { outcomeReason: { code: 'malformed_output', summary: 'x' } }),
        result('p4', '4', 'DIFF'),
        result('p5', '5', 'UNDETERMINED', { outcomeReason: { code: 'deadline_exceeded', summary: 'x' }, parsedProbeCount: 17 }),
      ],
      skipped: [{
        peerId: 'p6', displayName: 'Pricey', agentId: '6', service: 'model-a', status: 'SKIPPED', code: 'price_above_reference',
        reason: 'priced $16.9998/$84.999 per 1M, above the model-a reference $10/$50 · not audited',
        source: 'preflight', auditId: null, evidencePath: null, evidenceHash: null,
      }],
    })
    // A later run replaces seller 1's verdict and keeps seller 2's DIFF when it only skips it.
    await writeRun(dir, 'run-2', '2026-10-02T00:00:00.000Z', {
      results: [result('p1', '1', 'UNDETERMINED', { outcomeReason: { code: 'transport_error', summary: 'x' } })],
      skipped: [{
        peerId: 'p2', displayName: null, agentId: '2', service: 'model-a', status: 'SKIPPED', code: 'policy_rejected',
        reason: 'pinned peer could not complete', source: 'runtime', auditId: null, evidencePath: null, evidenceHash: null,
      }],
    })

    const overview = await buildEpochOverview(dir, '9')
    assert.deepEqual(overview.runIds, ['run-1', 'run-2'])
    const cell = (agentId: string) => overview.sellers.find((seller) => seller.agentId === agentId)!.cells.get('model-a')!
    assert.equal(cell('1').state, 'undetermined')
    assert.equal(cell('1').audits, 2)
    assert.equal(cell('1').reason?.headline, "Inconclusive: the seller's connection failed")
    assert.equal(cell('2').state, 'diff')
    assert.equal(cell('3').state, 'undetermined')
    assert.equal(cell('3').reason?.headline, "Inconclusive: answers couldn't be read")
    assert.equal(cell('4').state, 'diff', 'a DIFF is submitted as found; another auditor confirms it')
    assert.match(cell('5').reason!.detail, /answered 17 of 100 questions/)
    assert.equal(cell('6').state, 'skipped')
    assert.match(cell('6').reason!.detail, /\$17 in \/ \$85 out .* \$10 in \/ \$50 out for model-a/)

    const path = await writeEpochOverview(dir, '9')
    assert.equal(path, epochOverviewPath(dir, '9'))
    const html = await readFile(path!, 'utf8')
    assert.match(html, /KBF audits · epoch 9/)
    assert.match(html, /Inconclusive: answers couldn&#39;t be read/)
    assert.match(html, /Not audited: the auditor won&#39;t pay this price/)
    // A single auditor's DIFF is one report, not a confirmed result.
    assert.match(html, /DIFF REPORTS/)
    assert.match(html, /counts on-chain once another auditor confirms it/)
    assert.doesNotMatch(html, /2×|DIFF twice|both checks|CONFIRMED/)
    assert.equal(await writeEpochOverview(dir, '10'), null)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('plain reasons match the AntScan wording', () => {
  assert.deepEqual(explainInconclusive({ code: 'malformed_output', answered: 48, asked: 140 }), {
    headline: "Inconclusive: answers couldn't be read",
    detail: 'Too many answers were empty or not in the requested format, so there were too few readable answers to decide.'
      + ' The seller answered 48 of 140 questions.',
  })
  assert.equal(explainInconclusive({ summary: 'odd' }).detail, 'odd')
  assert.equal(
    explainSkipReason('pinned peer could not complete: {"message":"Invalid request parameters"}').detail,
    'The seller returned an error: “Invalid request parameters”.',
  )
  assert.equal(explainSkipReason('something new').headline, 'Not audited')
})

test('a disputed seller is marked on its model only', () => {
  const cell = (model: string): OverviewCell => ({
    state: 'same', model, service: model, runId: 'run-1', correctRate: 1, answered: 10, asked: 10, reason: null, audits: 1,
  })
  const overview: EpochOverview = {
    epoch: '7',
    runIds: ['run-1'],
    models: ['model-a', 'model-b'],
    sellers: [{
      key: 'agent:1', label: 'Seller', agentId: '1', peerId: 'peer',
      cells: new Map([['model-a', cell('model-a')], ['model-b', cell('model-b')]]),
    }],
  }
  const marker = '<sup class="disputed">'
  assert.equal(renderEpochOverview(overview).includes(marker), false)
  const html = renderEpochOverview(overview, new Set([disputeKey('1', modelHash('model-a'))]))
  assert.equal(html.split(marker).length - 1, 1)
  assert.match(html, /Disputed: two auditors disagree/)
})
