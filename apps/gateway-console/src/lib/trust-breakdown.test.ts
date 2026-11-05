import { describe, expect, it } from 'vitest'
import { trustBreakdownLabel } from './trust-breakdown'

describe('trustBreakdownLabel', () => {
  it('lists the parts that have data', () => {
    expect(trustBreakdownLabel({ usage: 12, power: null, identity: { score: 18, kind: 'github' }, freeModels: 5 }))
      .toBe('Usage 12 · GitHub 18 · Free models 5')
  })

  it('ends with the model-check penalty', () => {
    expect(trustBreakdownLabel({ usage: 14, power: 44, identity: { score: 6, kind: 'domain' }, freeModels: null,
      verification: { multiplierBps: 9600, sameCount: 0, diffCount: 1, change: -2.6 } }))
      .toBe('Usage 14 · Power 44 · Domain 6 · Model checks −3 (1 DIFF, points at 96%)')
  })

  it('ends with the model-check bonus', () => {
    expect(trustBreakdownLabel({ usage: 14, power: 44, identity: null, freeModels: null,
      verification: { multiplierBps: 10_200, sameCount: 9, diffCount: 2, change: 1.2 } }))
      .toBe('Usage 14 · Power 44 · Model checks +1 (9 verified, 2 DIFF, points at 102%)')
  })

  it('is null without a breakdown or any part', () => {
    expect(trustBreakdownLabel(undefined)).toBeNull()
    expect(trustBreakdownLabel({ usage: null, power: null, identity: null, freeModels: null })).toBeNull()
  })
})
