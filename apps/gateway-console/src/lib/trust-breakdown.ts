import type { TrustBreakdownView } from '../api/types'

/**
 * How a seller's trust score adds up, e.g. "History 31 · Usage 12 · Power 4 · GitHub 18 · Free models 5",
 * then any model-check penalty: "Model checks −3 (1 DIFF, points at 96%)".
 * Parts without data are left out; null when there is nothing to show.
 */
export function trustBreakdownLabel(breakdown: TrustBreakdownView | undefined): string | null {
  if (!breakdown) return null
  const parts: string[] = []
  const add = (label: string, value: number | null) => { if (value !== null) parts.push(`${label} ${Math.round(value)}`) }
  add('History', breakdown.history)
  add('Usage', breakdown.usage)
  add('Power', breakdown.power)
  if (breakdown.identity) add(breakdown.identity.kind === 'github' ? 'GitHub' : 'Domain', breakdown.identity.score)
  add('Free models', breakdown.freeModels)
  const checks = breakdown.verification
  if (checks) {
    parts.push(`Model checks −${Math.round(checks.penalty)} (${checks.diffCount} DIFF, points at ${Math.round(checks.multiplierBps / 100)}%)`)
  }
  return parts.length > 0 ? parts.join(' · ') : null
}
