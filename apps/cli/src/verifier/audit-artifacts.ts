import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { canonicalJsonStringify } from '@antseed/fingerprints'
import { readJsonIfExists, writeJsonAtomic, writeTextAtomic } from './atomic-files.js'
import type { AuditCostSummaryV1 } from './proxy-evidence.js'
import type { VerificationOutcomeReasonV1 } from './outcome-reason.js'
import type {
  ModelVerificationFailure,
  ModelVerificationSkip,
  ModelVerificationTargetResult,
} from './model-run.js'
import type { ModelProbeConsensusEvidenceV1 } from './model-consensus-evidence.js'
import { safeServiceSlug } from './slug.js'

export interface VerifierStatusV1 {
  version: 1
  kind: 'antseed-verifier-status'
  state: 'running' | 'completed' | 'failed'
  runId: string
  epoch: string
  startedAt: string
  completedAt: string | null
  epochStartedAt: string
  epochEndsAt: string
  currentModel: string | null
  currentPeerId: string | null
  activeAudits: Array<{ model: string; peerId: string; startedAt: string }>
  queuedAudits: number
  modelsCompleted: number
  modelsTotal: number
  auditsCompleted: number
  skipped: number
  failures: number
  cost: AuditCostSummaryV1
  reasonCounts?: Record<string, number>
  message: string
}

export interface ModelAuditSummaryV1 {
  version: 1
  kind: 'antseed-verifier-model-summary'
  runId: string
  epoch: string
  model: string
  startedAt: string
  completedAt: string
  results: ModelVerificationTargetResult[]
  failures: ModelVerificationFailure[]
  skipped: ModelVerificationSkip[]
  cost: AuditCostSummaryV1
  reasonCounts?: Record<string, number>
  consensusEvidencePath?: string
  referenceIntegrityPath?: string
}

export interface VerifierRunManifestV1 {
  version: 1
  kind: 'antseed-verifier-run-manifest'
  runId: string
  state: 'completed' | 'completed-with-failures'
  epoch: string
  epochSource: 'onchain' | 'utc-day'
  epochStartedAt: string
  epochEndsAt: string
  startedAt: string
  completedAt: string
  summaryPath: string
  selection?: {
    peerIds: string[]
  }
  modelOrder: string[]
  models: EpochAuditSummaryV1['models']
  failureCount: number
}

export interface EpochAuditSummaryV1 {
  version: 1
  kind: 'antseed-verifier-epoch-summary'
  runId: string
  epoch: string
  epochStartedAt: string
  epochEndsAt: string
  startedAt: string
  completedAt: string
  reportPaths: Array<{ model: string; path: string }>
  models: Array<{
    model: string
    summaryPath: string
    reportPath?: string
    resultCount: number
    failureCount: number
    skippedCount: number
    cost: AuditCostSummaryV1
    reasonCounts?: Record<string, number>
  }>
  failureCount: number
  cost: AuditCostSummaryV1
  reasonCounts?: Record<string, number>
}

interface SellerAuditReportResult {
  peerId: string
  displayName: string | null
  status: string
  parsedProbeCount: number
  probeCount: number
  correctProbeCount: number
  incorrectProbeCount: number
  correctRate: number | null
  auditId?: string
  evidencePath?: string
  outcomeReason?: VerificationOutcomeReasonV1 | null
}

interface SellerAuditReportFailure {
  peerId: string
  displayName?: string | null
  status: 'FAILED'
  reason: string
  outcomeReason?: VerificationOutcomeReasonV1
}

type SellerAuditReportSkip = ModelVerificationSkip

interface SellerAuditReportRow {
  seller: string
  coverage: string
  correct: string
  incorrect: string
  correctRate: string
  verdict: string
  reason: string
  nextAction: string
  auditId?: string
  evidencePath?: string
  evidenceFiles?: ReportEvidenceFile[]
}

interface ReportEvidenceFile {
  label: string
  path: string
  purpose: string | null
}

export function verifierStatusPath(evidenceDir: string): string {
  return join(evidenceDir, 'status.json')
}

export function epochDirectory(evidenceDir: string, epoch: string): string {
  return join(evidenceDir, 'epochs', epoch)
}

export function modelDirectory(evidenceDir: string, epoch: string, model: string): string {
  return join(epochDirectory(evidenceDir, epoch), safeServiceSlug(model))
}

export function modelAuditsDirectory(
  evidenceDir: string,
  epoch: string,
  model: string,
  runId: string,
): string {
  return join(modelDirectory(evidenceDir, epoch, model), 'audits', safeServiceSlug(runId))
}

export function modelAuditSellersDirectory(
  evidenceDir: string,
  epoch: string,
  model: string,
  runId: string,
): string {
  return join(modelAuditsDirectory(evidenceDir, epoch, model, runId), 'sellers')
}

export function modelReferencesDirectory(evidenceDir: string, epoch: string, model: string): string {
  return join(modelDirectory(evidenceDir, epoch, model), 'references')
}

export function modelReferenceDirectory(
  evidenceDir: string,
  epoch: string,
  model: string,
  referenceId: string,
): string {
  return join(modelReferencesDirectory(evidenceDir, epoch, model), safeServiceSlug(referenceId))
}

export function modelAuditReportPath(evidenceDir: string, epoch: string, model: string): string {
  return join(modelDirectory(evidenceDir, epoch, model), 'report.html')
}

export function verifierRunManifestPath(evidenceDir: string, runId: string): string {
  return join(evidenceDir, 'runs', `${runId}.json`)
}

export async function writeVerifierStatus(evidenceDir: string, status: VerifierStatusV1): Promise<string> {
  const path = verifierStatusPath(evidenceDir)
  await writeJsonAtomic(path, status)
  return path
}

export async function readVerifierStatus(evidenceDir: string): Promise<VerifierStatusV1 | null> {
  return readJsonIfExists(verifierStatusPath(evidenceDir))
}

export async function appendVerifierEvent(
  evidenceDir: string,
  epoch: string,
  event: Record<string, unknown>,
): Promise<string> {
  const path = join(epochDirectory(evidenceDir, epoch), 'events.jsonl')
  await mkdir(dirname(path), { recursive: true })
  await appendFile(path, `${canonicalJsonStringify(event)}\n`)
  return path
}

export async function writeModelAuditSummary(
  evidenceDir: string,
  epoch: string,
  model: string,
  summary: ModelAuditSummaryV1,
): Promise<string> {
  const path = join(modelAuditsDirectory(evidenceDir, epoch, model, summary.runId), 'summary.json')
  await writeJsonAtomic(path, summary)
  return path
}

export async function writeEpochAuditSummary(
  evidenceDir: string,
  _epoch: string,
  summary: EpochAuditSummaryV1,
): Promise<string> {
  const path = join(evidenceDir, 'runs', `${safeServiceSlug(summary.runId)}.summary.json`)
  await writeJsonAtomic(path, summary)
  return path
}

export async function writeVerifierRunManifest(
  evidenceDir: string,
  manifest: VerifierRunManifestV1,
): Promise<string> {
  const path = verifierRunManifestPath(evidenceDir, manifest.runId)
  await writeJsonAtomic(path, manifest)
  return path
}

export async function readVerifierRunManifest(
  evidenceDir: string,
  runId: string,
): Promise<VerifierRunManifestV1> {
  const path = verifierRunManifestPath(evidenceDir, runId)
  let parsed: VerifierRunManifestV1
  try {
    parsed = JSON.parse(await readFile(path, 'utf8')) as VerifierRunManifestV1
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`verifier run manifest not found: ${path}`)
    }
    throw error
  }
  if (parsed.version !== 1 || parsed.kind !== 'antseed-verifier-run-manifest' || parsed.runId !== runId) {
    throw new Error(`invalid verifier run manifest: ${path}`)
  }
  return parsed
}

export async function writeModelAuditReports(
  evidenceDir: string,
  epoch: string,
  summary: EpochAuditSummaryV1,
): Promise<Array<{ model: string; path: string }>> {
  const rendered = await renderModelAuditReports(evidenceDir, epoch, summary)
  await Promise.all(rendered.map((entry) => writeTextAtomic(entry.path, entry.html)))
  return rendered.map(({ model, path }) => ({ model, path }))
}

export async function renderModelAuditReports(
  evidenceDir: string,
  epoch: string,
  summary: EpochAuditSummaryV1,
): Promise<Array<{ model: string; path: string; html: string }>> {
  const rendered = await Promise.all(summary.models.map(async (model) => {
    const modelSummary = JSON.parse(await readFile(model.summaryPath, 'utf8')) as {
      results?: SellerAuditReportResult[]
      failures?: SellerAuditReportFailure[]
      skipped?: SellerAuditReportSkip[]
      consensusEvidencePath?: string
      referenceIntegrityPath?: string
    }
    const consensus = modelSummary.consensusEvidencePath
      ? JSON.parse(await readFile(modelSummary.consensusEvidencePath, 'utf8')) as ModelProbeConsensusEvidenceV1
      : null
    const results = [...(modelSummary.results ?? [])].sort((left, right) => {
      if (left.correctRate === null && right.correctRate !== null) return 1
      if (left.correctRate !== null && right.correctRate === null) return -1
      if (left.correctRate !== null && right.correctRate !== null && left.correctRate !== right.correctRate) {
        return right.correctRate - left.correctRate
      }
      return sellerLabel(left).localeCompare(sellerLabel(right))
    })
    const reasonCounts = new Map<string, number>()
    const countReason = (reason?: VerificationOutcomeReasonV1 | null): void => {
      if (!reason) return
      reasonCounts.set(reason.code, (reasonCounts.get(reason.code) ?? 0) + 1)
    }
    const rows: SellerAuditReportRow[] = await Promise.all(results.map(async (result) => {
      countReason(result.outcomeReason)
      return {
        seller: sellerLabel(result),
        coverage: `${result.parsedProbeCount}/${result.probeCount}`,
        correct: result.parsedProbeCount === 0 ? '—' : String(result.correctProbeCount),
        incorrect: result.parsedProbeCount === 0 ? '—' : String(result.incorrectProbeCount),
        correctRate: result.correctRate === null ? 'N/A' : `${(result.correctRate * 100).toFixed(1)}%`,
        verdict: result.status,
        reason: reportReason(result.outcomeReason),
        nextAction: result.outcomeReason?.nextAction ?? '—',
        auditId: result.auditId,
        evidencePath: result.evidencePath,
        evidenceFiles: await readReportEvidenceFiles(result.evidencePath),
      }
    }))
    for (const failure of modelSummary.failures ?? []) {
      countReason(failure.outcomeReason)
      rows.push({
        seller: sellerLabel(failure), coverage: '—', correct: '—', incorrect: '—', correctRate: 'N/A',
        verdict: 'FAILED', reason: reportReason(failure.outcomeReason, failure.reason),
        nextAction: failure.outcomeReason?.nextAction ?? 'inspect verifier evidence',
      })
    }
    const skippedResults = [...(modelSummary.skipped ?? [])]
      .sort((left, right) => sellerLabel(left).localeCompare(sellerLabel(right)))
    for (const skipped of skippedResults) {
      countReason(skipped.outcomeReason)
      rows.push({
        seller: sellerLabel(skipped), coverage: '—', correct: '—', incorrect: '—', correctRate: 'N/A',
        verdict: 'SKIPPED', reason: reportReason(skipped.outcomeReason, skipped.reason),
        nextAction: skipped.outcomeReason?.nextAction ?? 'inspect verifier evidence',
        auditId: skipped.auditId ?? undefined,
        evidencePath: skipped.evidencePath ?? undefined,
        evidenceFiles: await readReportEvidenceFiles(skipped.evidencePath ?? undefined),
      })
    }
    const reasonBreakdown = [...reasonCounts.entries()].sort(([left], [right]) => left.localeCompare(right))
    const reportPath = modelAuditReportPath(evidenceDir, epoch, model.model)
    const reportDirectory = dirname(reportPath)
    return {
      model: model.model,
      path: reportPath,
      reasonCounts,
      html: renderModelReportSection(
        model.model,
        rows,
        reasonBreakdown,
        model.summaryPath,
        modelSummary.consensusEvidencePath,
        modelSummary.referenceIntegrityPath,
        consensus,
        reportDirectory,
      ),
      consensusEvidencePath: modelSummary.consensusEvidencePath,
      referenceIntegrityPath: modelSummary.referenceIntegrityPath,
    }
  }))
  return rendered.map((entry) => {
    const modelSummary = summary.models.find((model) => model.model === entry.model)
    if (!modelSummary) throw new Error(`missing ${entry.model} summary while rendering report`)
    const reasonBreakdown = [...entry.reasonCounts.entries()].sort(([left], [right]) => left.localeCompare(right))
    const path = entry.path
    const text = renderModelAuditReportHtml(
      {
        ...summary,
        reportPaths: [{ model: entry.model, path }],
        models: [modelSummary],
        failureCount: modelSummary.failureCount,
        cost: modelSummary.cost,
        reasonCounts: modelSummary.reasonCounts,
      },
      entry.model,
      reasonBreakdown,
      entry.html,
      {
        summaryPath: join(evidenceDir, 'runs', `${safeServiceSlug(summary.runId)}.summary.json`),
        manifestPath: verifierRunManifestPath(evidenceDir, summary.runId),
        modelConsensus: entry.consensusEvidencePath
          ? [{ model: entry.model, path: entry.consensusEvidencePath }]
          : [],
        modelReferences: entry.referenceIntegrityPath
          ? [{ model: entry.model, path: entry.referenceIntegrityPath }]
          : [],
      },
      dirname(path),
    )
    return { model: entry.model, path, html: text }
  })
}

function reportReason(reason?: VerificationOutcomeReasonV1 | null, fallback = '—'): string {
  if (!reason) return fallback
  const progress = reason.totalBatchCount > 0
    ? ` (${reason.affectedBatchCount}/${reason.totalBatchCount} batches)`
    : ''
  return `${reason.code}: ${reason.summary}${progress}${reason.retryable ? '; resumable' : ''}`
}

function renderModelAuditReportHtml(
  summary: EpochAuditSummaryV1,
  model: string,
  reasonBreakdown: Array<[string, number]>,
  modelSection: string,
  evidenceLinks: {
    summaryPath: string
    manifestPath: string | null
    modelConsensus: Array<{ model: string; path: string }>
    modelReferences: Array<{ model: string; path: string }>
  },
  reportDirectory: string,
): string {
  const title = `AntSeed ${model} Verification Report — ${summary.epoch}`
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <style>
    :root { color-scheme: light dark; --bg: #f4f6f8; --panel: #fff; --text: #17202a; --muted: #5d6d7e; --line: #d5dbe1; --accent: #315efb; --same: #16794a; --diff: #b42318; --undetermined: #9a6700; --skipped: #59636e; --failed: #8e1b1b; }
    @media (prefers-color-scheme: dark) { :root { --bg: #11151a; --panel: #1a2027; --text: #edf2f7; --muted: #aeb8c4; --line: #36404b; --accent: #8aa4ff; --same: #56d597; --diff: #ff8c82; --undetermined: #f2c14e; --skipped: #b8c0ca; --failed: #ff7b72; } }
    * { box-sizing: border-box; }
    body { margin: 0; background: var(--bg); color: var(--text); font: 14px/1.5 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    main { width: min(1600px, calc(100% - 32px)); margin: 32px auto 64px; }
    header, section { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; box-shadow: 0 2px 8px rgb(0 0 0 / 6%); }
    header { padding: 24px; margin-bottom: 20px; }
    h1, h2, h3 { margin: 0; line-height: 1.2; }
    h1 { font-size: clamp(24px, 4vw, 38px); }
    h2 { font-size: 22px; }
    .subtitle { color: var(--muted); margin: 6px 0 20px; }
    .explanation { color: var(--muted); margin: -8px 0 20px; max-width: 900px; }
    .metadata { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; margin: 0; }
    .metadata div { border-left: 3px solid var(--accent); padding-left: 10px; min-width: 0; }
    dt { color: var(--muted); font-size: 12px; font-weight: 700; letter-spacing: .04em; text-transform: uppercase; }
    dd { margin: 2px 0 0; overflow-wrap: anywhere; }
    section { padding: 20px; margin-top: 20px; }
    .probe-consensus { border-top: 1px solid var(--line); margin-top: 18px; padding-top: 18px; }
    .probe-consensus h3 { font-size: 17px; margin-bottom: 14px; }
    .consensus-question { border: 1px solid var(--line); border-radius: 10px; margin-top: 12px; padding: 0 14px 14px; }
    .consensus-question > summary { align-items: baseline; display: flex; flex-wrap: wrap; gap: 8px; padding: 14px 0; }
    .question-number { color: var(--muted); font-weight: 700; }
    .question-text { color: var(--text); flex: 1 1 520px; font-weight: 700; }
    .reference-answer { font-variant-numeric: tabular-nums; white-space: nowrap; }
    .vote-group { margin-top: 18px; }
    .vote-group h4 { margin: 0 0 8px; }
    .vote-table { min-width: 860px; }
    .evidence-description { color: var(--muted); display: block; margin-top: 5px; max-width: 700px; }
    .reasons { color: var(--muted); margin: 10px 0 0; padding-left: 20px; }
    .table-wrap { overflow-x: auto; margin-top: 16px; }
    table { border-collapse: collapse; width: 100%; min-width: 1120px; }
    th, td { border-bottom: 1px solid var(--line); padding: 10px 12px; text-align: left; vertical-align: top; }
    th { color: var(--muted); font-size: 12px; letter-spacing: .03em; text-transform: uppercase; white-space: nowrap; }
    tbody tr:last-child td { border-bottom: 0; }
    td.numeric { font-variant-numeric: tabular-nums; white-space: nowrap; }
    .badge { border: 1px solid currentColor; border-radius: 999px; display: inline-block; font-size: 12px; font-weight: 800; letter-spacing: .03em; padding: 2px 8px; }
    .same { color: var(--same); } .diff { color: var(--diff); } .undetermined { color: var(--undetermined); } .skipped { color: var(--skipped); } .failed { color: var(--failed); }
    a { color: var(--accent); overflow-wrap: anywhere; }
    .evidence-links { align-items: center; display: flex; flex-wrap: wrap; gap: 8px 14px; margin-top: 14px; }
    .evidence-links a { border: 1px solid var(--line); border-radius: 8px; padding: 6px 9px; text-decoration: none; }
    .evidence-links a:hover { border-color: var(--accent); }
    details { margin-top: 8px; }
    summary { color: var(--accent); cursor: pointer; }
    .evidence-files { margin: 8px 0 0; padding-left: 18px; }
    .evidence-files li { margin: 4px 0; }
    .evidence-files small { color: var(--muted); display: block; }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: .92em; }
    .empty { color: var(--muted); font-style: italic; }
  </style>
</head>
<body>
<main>
  <header>
    <h1>AntSeed Model Verification Report</h1>
    <p class="subtitle">${escapeHtml(model)} · Epoch ${escapeHtml(summary.epoch)}</p>
    <p class="explanation">This report covers one model in one verification run. Each seller row links to that seller's signed evidence.</p>
    <dl class="metadata">
      ${renderMetadata('Verification Run ID', summary.runId)}
      ${renderMetadata('View', 'latest verification run for this model and epoch')}
      ${renderMetadata('Epoch window', `${summary.epochStartedAt} – ${summary.epochEndsAt}`)}
      ${renderMetadata('Started', summary.startedAt)}
      ${renderMetadata('Completed', summary.completedAt)}
      ${renderMetadata('Estimated cost', `$${summary.cost.estimatedCostUsd.toFixed(6)}`)}
    </dl>
    ${renderGlobalEvidenceLinks(evidenceLinks, reportDirectory)}
    ${renderReasonBreakdown('Model reason breakdown', reasonBreakdown)}
  </header>
  ${modelSection}
</main>
</body>
</html>
`
}

function renderModelReportSection(
  model: string,
  rows: SellerAuditReportRow[],
  reasonBreakdown: Array<[string, number]>,
  summaryPath: string,
  consensusEvidencePath?: string,
  referenceIntegrityPath?: string,
  consensus: ModelProbeConsensusEvidenceV1 | null = null,
  reportDirectory?: string,
): string {
  const body = rows.length === 0
    ? '<tr><td class="empty" colspan="9">No advertised sellers were audited for this model.</td></tr>'
    : rows.map((row) => `<tr>
          <td>${escapeHtml(row.seller)}</td>
          <td class="numeric">${escapeHtml(row.coverage)}</td>
          <td class="numeric">${escapeHtml(row.correct)}</td>
          <td class="numeric">${escapeHtml(row.incorrect)}</td>
          <td class="numeric">${escapeHtml(row.correctRate)}</td>
          <td>${renderVerdict(row.verdict)}</td>
          <td>${escapeHtml(row.reason)}</td>
          <td>${escapeHtml(row.nextAction)}</td>
          <td>${renderEvidence(row.auditId, row.evidencePath, row.evidenceFiles, reportDirectory)}</td>
        </tr>`).join('\n        ')
  return `<section>
    <h2>${escapeHtml(model)}</h2>
    <div class="evidence-links"><strong>Model audit</strong>
      ${renderFileLink(dirname(summaryPath), 'Open audit folder', reportDirectory)}
      ${renderFileLink(summaryPath, 'Summary JSON', reportDirectory)}
      ${consensusEvidencePath ? renderFileLink(consensusEvidencePath, 'Probe consensus JSON', reportDirectory) : ''}
      ${consensusEvidencePath ? renderFileLink(join(dirname(consensusEvidencePath), 'manifest.json'), 'Manifest JSON', reportDirectory) : ''}
      ${referenceIntegrityPath ? renderFileLink(referenceIntegrityPath, 'Reference probe integrity', reportDirectory) : ''}
      ${consensus ? '<a href="#audit-integrity">Audit Integrity</a>' : ''}
    </div>
    ${renderProbeConsensus(consensus, consensusEvidencePath, reportDirectory)}
    ${renderReasonBreakdown('Model reason breakdown', reasonBreakdown)}
    <div class="table-wrap">
      <table>
        <thead><tr><th>Seller</th><th>Coverage</th><th>Correct</th><th>Incorrect</th><th>Correct Rate</th><th>Verdict</th><th>Reason</th><th>Next Action</th><th>Seller Audit Evidence</th></tr></thead>
        <tbody>
        ${body}
        </tbody>
      </table>
    </div>
  </section>`
}

function renderProbeConsensus(
  consensus: ModelProbeConsensusEvidenceV1 | null,
  consensusEvidencePath?: string,
  reportDirectory?: string,
): string {
  if (!consensus) return ''
  const summary = consensus.summary
  const consensusDirectory = consensusEvidencePath ? dirname(consensusEvidencePath) : null
  const openRouterReference = consensus.reference?.sourceId?.startsWith('openrouter') === true
  const referenceName = openRouterReference ? 'OpenRouter reference answer' : 'Reference answer'
  const referenceSource = consensus.reference
    ? [consensus.reference.sourceId, consensus.reference.upstreamModel].filter(Boolean).join(' · ')
    : 'Unavailable'
  const questionCards = consensus.probes.map((probe, index) => {
    const confirming = probe.sellerAnswers.filter((answer) => answer.sellerDecision === 'CONFIRMED')
    const rejecting = probe.sellerAnswers.filter((answer) => answer.sellerDecision === 'REJECTED')
    const excluded = probe.sellerAnswers.filter((answer) => answer.sellerDecision === 'EXCLUDED')
    const noResponsePeerIds = new Set(probe.sellerDecisions.NO_RESPONSE.peerIds)
    const noResponse = consensus.sellers.filter((seller) => noResponsePeerIds.has(seller.peerId))
    return `<details class="consensus-question">
      <summary>
        <span class="question-number">Question ${index + 1}</span>
        <span class="question-text">${escapeHtml(probe.question)}</span>
        <span class="reference-answer">${escapeHtml(referenceName)}: <strong>${escapeHtml(String(probe.referenceConsensus))}</strong></span>
        <span>${probe.sellerDecisions.CONFIRMED.count} confirmed · ${probe.sellerDecisions.REJECTED.count} rejected · ${probe.sellerDecisions.NO_RESPONSE.count} no response</span>
        ${renderVerdict(probe.referenceDecision)}
      </summary>
      <dl class="metadata">
        ${renderMetadata('Probe ID', probe.probeId)}
        ${renderMetadata('Domain', probe.domain)}
        ${renderMetadata(referenceName, String(probe.referenceConsensus))}
        ${renderMetadata('Physical validity range', `${probe.range[0]} to ${probe.range[1]}`)}
        ${renderMetadata('Tolerance rule', `${probe.tolerance.mode} ${probe.tolerance.value}`)}
        ${renderMetadata('Accepted answer interval', `${probe.acceptedAnswerInterval.minimum} to ${probe.acceptedAnswerInterval.maximum} (inclusive)`)}
        ${renderMetadata('Majority vote', `${probe.referenceSupportCount} confirm / ${probe.referenceRejectCount} reject`)}
        ${renderMetadata('Required to confirm', String(probe.globalDecision.requiredConfirmedSellerCount))}
        ${renderMetadata('Support rate', formatPercent(probe.referenceSupportRate))}
        ${renderMetadata('Global decision', probe.globalDecision.decision)}
      </dl>
      ${renderConsensusSellerAnswers('CONFIRMED — within the accepted answer interval', confirming, consensusDirectory, reportDirectory)}
      ${renderConsensusSellerAnswers('REJECTED — outside tolerance or malformed completed answer', rejecting, consensusDirectory, reportDirectory)}
      ${renderConsensusNoResponseSellers(noResponse, consensusDirectory, reportDirectory)}
      ${excluded.length > 0
        ? renderConsensusSellerAnswers('EXCLUDED — authenticated response could not be scored', excluded, consensusDirectory, reportDirectory)
        : ''}
    </details>`
  }).join('\n')
  return `<div class="probe-consensus" id="audit-integrity">
    <h3>Does the seller majority agree with the ${openRouterReference ? 'OpenRouter' : 'enrolled'} reference?</h3>
    <p class="explanation">Each question shows the reference answer, the seller answers that confirm it, the seller answers that reject it, and direct links to each signed exchange. Every scoreable answer backed by verified ResponseAuth votes, including answers from sellers whose final model-level verdict is UNDETERMINED. Unsigned or missing answers do not vote. A tie confirms the reference.</p>
    <dl class="metadata">
      ${renderMetadata('Reference source', referenceSource)}
      ${renderMetadata('Eligible sellers', String(summary.eligibleSellerCount))}
      ${renderMetadata('Confirmed reference points', `${summary.confirmedReferencePointCount}/${summary.probeCount}`)}
      ${renderMetadata('Rejected reference points', String(summary.rejectedReferencePointCount))}
      ${renderMetadata('No-response reference points', String(summary.noResponseReferencePointCount))}
      ${renderMetadata('Confirmation rate', formatPercent(summary.referencePointConfirmationRate))}
    </dl>
    <div class="question-consensus-list">${questionCards}</div>
  </div>`
}

function renderConsensusSellerAnswers(
  title: string,
  answers: ModelProbeConsensusEvidenceV1['probes'][number]['sellerAnswers'],
  consensusDirectory: string | null,
  reportDirectory?: string,
): string {
  const rows = answers.length === 0
    ? '<tr><td class="empty" colspan="4">No seller answers in this group.</td></tr>'
    : answers.map((answer) => {
      const exchangePath = consensusDirectory
        ? join(consensusDirectory, answer.rawResponse.exchangePath)
        : null
      return `<tr>
        <td><code>${escapeHtml(answer.peerId)}</code></td>
        <td class="numeric">${escapeHtml(answer.match === null ? 'unavailable' : answer.answer === null ? 'unparsed' : String(answer.answer))}</td>
        <td>${renderVerdict(answer.sellerVerdict)}</td>
        <td>${exchangePath ? renderFileLink(exchangePath, 'Open signed exchange JSON', reportDirectory) : '—'}
          <small class="evidence-description">Contains the raw buyer-proxy request and response, ResponseAuth signature, exact signed request/response preimages, and hashes.</small>
          <small class="evidence-description">Decision reason: <code>${escapeHtml(answer.decisionReason)}</code></small>
          <details><summary>Signature and hashes</summary><ul class="evidence-files">
            <li>Request ID: <code>${escapeHtml(answer.requestId)}</code></li>
            <li>Request hash: <code>${escapeHtml(answer.requestHash)}</code></li>
            <li>Response hash: <code>${escapeHtml(answer.responseHash)}</code></li>
            <li>ResponseAuth signature: <code>${escapeHtml(answer.responseAuthSignature)}</code></li>
          </ul></details>
        </td>
      </tr>`
    }).join('')
  return `<div class="vote-group">
    <h4>${escapeHtml(title)} (${answers.length})</h4>
    <div class="table-wrap"><table class="vote-table">
      <thead><tr><th>Seller peer</th><th>Seller answer</th><th>Seller audit verdict</th><th>Signed evidence and underlying data</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`
}

function renderConsensusNoResponseSellers(
  sellers: ModelProbeConsensusEvidenceV1['sellers'],
  consensusDirectory: string | null,
  reportDirectory?: string,
): string {
  const rows = sellers.length === 0
    ? '<tr><td class="empty" colspan="3">Every audited seller has a classified answer for this question.</td></tr>'
    : sellers.map((seller) => {
      const evidencePath = consensusDirectory
        ? join(consensusDirectory, seller.relativeEvidencePath)
        : null
      return `<tr>
        <td><code>${escapeHtml(seller.peerId)}</code></td>
        <td>${renderVerdict(seller.verdict)}</td>
        <td>${evidencePath ? renderFileLink(evidencePath, 'Open seller evidence JSON', reportDirectory) : '—'}
          <small class="evidence-description">No verified seller answer was available for this question, so this seller does not participate in the majority calculation.</small>
        </td>
      </tr>`
    }).join('')
  return `<div class="vote-group">
    <h4>NO_RESPONSE — no eligible signed answer (${sellers.length})</h4>
    <div class="table-wrap"><table class="vote-table">
      <thead><tr><th>Seller peer</th><th>Seller audit verdict</th><th>Seller evidence</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </div>`
}

function formatPercent(value: number | null): string {
  return value === null ? 'N/A' : `${(value * 100).toFixed(1)}%`
}

function renderMetadata(label: string, value: string): string {
  return `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`
}

function renderReasonBreakdown(title: string, reasons: Array<[string, number]>): string {
  if (reasons.length === 0) return ''
  const items = reasons
    .map(([code, count]) => `<li><code>${escapeHtml(code)}</code>: ${count}</li>`)
    .join('')
  return `<div><strong>${escapeHtml(title)}</strong><ul class="reasons">${items}</ul></div>`
}

function renderVerdict(verdict: string): string {
  const normalized = verdict.toLowerCase()
  const className = normalized === 'confirmed'
    ? 'same'
    : normalized === 'rejected'
      ? 'diff'
      : normalized === 'no_response'
        ? 'undetermined'
        : ['same', 'diff', 'undetermined', 'skipped', 'failed'].includes(normalized)
          ? normalized
          : 'skipped'
  return `<span class="badge ${className}">${escapeHtml(verdict)}</span>`
}

function renderEvidence(
  auditId?: string,
  evidencePath?: string,
  evidenceFiles: ReportEvidenceFile[] = [],
  reportDirectory?: string,
): string {
  if (!auditId && !evidencePath) return '—'
  const audit = auditId ? `seller audit ${auditId.slice(0, 14)}…` : null
  if (!evidencePath) return audit ? escapeHtml(audit) : '—'
  const isPack = basename(evidencePath) === 'evidence.json'
  const directLinks = isPack
    ? `${renderFileLink(dirname(evidencePath), 'Open folder', reportDirectory)}<br>${renderFileLink(evidencePath, 'Evidence JSON', reportDirectory)}`
    : renderFileLink(evidencePath, 'Open evidence record', reportDirectory)
  const allFiles = evidenceFiles.length === 0 ? '' : `<details><summary>All evidence files (${evidenceFiles.length})</summary>
      <ul class="evidence-files">${evidenceFiles.map((file) => `<li>${renderFileLink(file.path, file.label, reportDirectory)}`
        + `${file.purpose ? `<small>${escapeHtml(file.purpose)}</small>` : ''}</li>`).join('')}</ul>
    </details>`
  return `${directLinks}${allFiles}${audit ? `<br><code>${escapeHtml(audit)}</code>` : ''}`
}

function renderGlobalEvidenceLinks(
  links: {
    summaryPath: string
    manifestPath: string | null
    modelConsensus: Array<{ model: string; path: string }>
    modelReferences: Array<{ model: string; path: string }>
  },
  reportDirectory?: string,
): string {
  const entries = [
    renderFileLink(links.summaryPath, 'Open run summary', reportDirectory),
    ...(links.manifestPath ? [renderFileLink(links.manifestPath, 'Open run manifest', reportDirectory)] : []),
    ...links.modelConsensus.flatMap((entry) => [
      renderFileLink(dirname(entry.path), `${entry.model} evidence folder`, reportDirectory),
      renderFileLink(entry.path, `${entry.model} consensus JSON`, reportDirectory),
      renderFileLink(join(dirname(entry.path), 'manifest.json'), `${entry.model} manifest`, reportDirectory),
    ]),
    ...links.modelReferences.map((entry) => renderFileLink(
      entry.path,
      `${entry.model} reference integrity`,
      reportDirectory,
    )),
  ]
  return `<nav class="evidence-links" aria-label="Run evidence"><strong>Run evidence</strong>${entries.join('')}</nav>`
}

function renderFileLink(path: string, label: string, reportDirectory?: string): string {
  const href = reportDirectory ? portableRelativeHref(reportDirectory, path) : path
  return `<a href="${escapeHtml(href)}" title="${escapeHtml(path)}">${escapeHtml(label)}</a>`
}

function portableRelativeHref(fromDirectory: string, path: string): string {
  const pathSegments = relative(fromDirectory, path).split(sep)
  return pathSegments.map((segment) => segment === '..' || segment === '.'
    ? segment
    : encodeURIComponent(segment)).join('/')
}

async function readReportEvidenceFiles(evidencePath?: string): Promise<ReportEvidenceFile[]> {
  if (!evidencePath) return []
  if (basename(evidencePath) !== 'evidence.json') {
    return [{ label: basename(evidencePath), path: evidencePath, purpose: null }]
  }
  const packDirectory = dirname(evidencePath)
  try {
    const manifest = JSON.parse(await readFile(join(packDirectory, 'manifest.json'), 'utf8')) as {
      files?: Array<{ path?: string; purpose?: string }>
    }
    return [
      { label: 'README.md', path: join(packDirectory, 'README.md'), purpose: 'Human-readable pack guide' },
      { label: 'manifest.json', path: join(packDirectory, 'manifest.json'), purpose: 'Canonical file hashes and evidence scope' },
      ...(manifest.files ?? []).flatMap((file) => file.path
        ? [{ label: file.path, path: join(packDirectory, file.path), purpose: file.purpose ?? null }]
        : []),
    ]
  } catch {
    return [{ label: 'evidence.json', path: evidencePath, purpose: 'Canonical complete audit evidence' }]
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function sellerLabel(value: { peerId: string; displayName?: string | null }): string {
  const peer = `${value.peerId.slice(0, 12)}…`
  return value.displayName ? `${value.displayName} (${peer})` : peer
}
