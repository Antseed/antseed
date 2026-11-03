import type { AuditResult } from './audit.js'

/** Process exit code for a verdict: 0 SAME, 2 DIFF, 3 UNDETERMINED or UNKNOWN. */
export function verdictExitCode(result: AuditResult): number {
  if (result.evaluation.verdict === 'SAME') return 0
  if (result.evaluation.verdict === 'DIFF') return 2
  return 3
}

export function auditSummaryJson(result: AuditResult): Record<string, unknown> {
  return {
    verdict: result.evaluation.verdict,
    reason: result.evaluation.verdictReason,
    target: result.target,
    referenceId: result.referenceId,
    referenceModel: result.referenceModel,
    stats: result.evaluation.stats,
    probes: result.probeIds.length,
    statisticalPower: result.statisticalPower,
  }
}

export function formatAuditSummary(result: AuditResult): string[] {
  const { evaluation } = result
  const { stats } = evaluation
  const lines = [
    `Target     ${result.target.model} @ ${result.target.endpoint}`,
    `Reference  ${result.referenceModel} (${result.referenceId})`,
    `Probes     ${result.probeIds.length} (power ${result.statisticalPower.toFixed(3)})`,
  ]
  if (stats.targetTotal !== null) {
    lines.push(`Mismatches ${stats.targetHamming}/${stats.targetTotal} (reference honest-error bound ${formatRate(stats.p0Cp99)})`)
  }
  if (stats.pValueBinomial !== null) lines.push(`p-value    ${stats.pValueBinomial.toExponential(3)}`)
  lines.push(`Verdict    ${evaluation.verdict}${evaluation.verdictReason ? ` — ${evaluation.verdictReason}` : ''}`)
  return lines
}

function formatRate(rate: number | null): string {
  return rate === null ? 'n/a' : `${(rate * 100).toFixed(1)}%`
}
