import type { TrustBreakdownView } from '../api/types'

type ModelChecks = Pick<NonNullable<TrustBreakdownView['verification']>, 'multiplierBps' | 'sameCount' | 'diffCount' | 'change'>

/**
 * How a seller's trust score adds up, e.g. "Power 44 · Usage 15 · GitHub 18 · Free models 5",
 * then any model-check effect: "Model checks −3" or "Model checks +5". `modelChecksEffect` says why.
 * Parts without data are left out; null when there is nothing to show.
 */
export function trustBreakdownLabel(breakdown: TrustBreakdownView | undefined): string | null {
  if (!breakdown) return null
  const parts: string[] = []
  const add = (label: string, value: number | null) => { if (value !== null) parts.push(`${label} ${Math.round(value)}`) }
  add('History', breakdown.history ?? null)
  add('Usage', breakdown.usage)
  add('Power', breakdown.power)
  if (breakdown.identity) add(breakdown.identity.kind === 'github' ? 'GitHub' : 'Domain', breakdown.identity.score)
  add('Free models', breakdown.freeModels)
  const checks = breakdown.verification
  if (checks) parts.push(`Model checks ${checks.change < 0 ? '−' : '+'}${Math.round(Math.abs(checks.change))}`)
  return parts.length > 0 ? parts.join(' · ') : null
}

/**
 * What the verification policy did to a seller's score, e.g.
 * "Model checks found 3 verified, 1 DIFF: it earns 102% of normal points, so the score moved from 88 to 90."
 */
export function modelChecksEffect(checks: ModelChecks, score: number): string {
  const counts = [checks.sameCount > 0 ? `${checks.sameCount} verified` : null, checks.diffCount > 0 ? `${checks.diffCount} DIFF` : null].filter(Boolean).join(', ')
  const rounded = (value: number) => (Math.round(value * 10) / 10).toLocaleString('en-US')
  return `Model checks found ${counts}: it earns ${Math.round(checks.multiplierBps / 100)}% of normal points, so the score moved from ${rounded(score - checks.change)} to ${rounded(score)}.`
}
