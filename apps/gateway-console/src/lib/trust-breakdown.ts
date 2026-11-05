import type { TrustBreakdownView } from '../api/types'

/**
 * How a seller's trust score adds up, e.g. "Power 44 · Usage 15 · GitHub 18 · Free models 5",
 * then any model-check effect: "Model checks −3 (1 DIFF, points at 96%)" or "Model checks +5 (3 verified, points at 106%)".
 * Parts without data are left out; null when there is nothing to show.
 */
export function trustBreakdownLabel(breakdown: TrustBreakdownView | undefined): string | null {
  if (!breakdown) return null
  const parts: string[] = []
  const add = (label: string, value: number | null) => { if (value !== null) parts.push(`${label} ${Math.round(value)}`) }
  add('Usage', breakdown.usage)
  add('Power', breakdown.power)
  if (breakdown.identity) add(breakdown.identity.kind === 'github' ? 'GitHub' : 'Domain', breakdown.identity.score)
  add('Free models', breakdown.freeModels)
  const checks = breakdown.verification
  if (checks) {
    const counts = [checks.sameCount > 0 ? `${checks.sameCount} verified` : null, checks.diffCount > 0 ? `${checks.diffCount} DIFF` : null].filter(Boolean)
    parts.push(`Model checks ${checks.change < 0 ? '−' : '+'}${Math.round(Math.abs(checks.change))} (${[...counts, `points at ${Math.round(checks.multiplierBps / 100)}%`].join(', ')})`)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}
