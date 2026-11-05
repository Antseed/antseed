import { describe, expect, it } from 'vitest'
import { trustBreakdownLabel } from './trust-breakdown'

describe('trustBreakdownLabel', () => {
  it('lists the parts that have data', () => {
    expect(trustBreakdownLabel({ history: 31.4, usage: 12, power: null, identity: { score: 18, kind: 'github' }, freeModels: 5 }))
      .toBe('History 31 · Usage 12 · GitHub 18 · Free models 5')
  })

  it('ends with the model-check penalty', () => {
    expect(trustBreakdownLabel({ history: 38, usage: 14, power: 7, identity: { score: 6, kind: 'domain' }, freeModels: null,
      verification: { multiplierBps: 9600, diffCount: 1, penalty: 2.6 } }))
      .toBe('History 38 · Usage 14 · Power 7 · Domain 6 · Model checks −3 (1 DIFF, points at 96%)')
  })

  it('is null without a breakdown or any part', () => {
    expect(trustBreakdownLabel(undefined)).toBeNull()
    expect(trustBreakdownLabel({ history: null, usage: null, power: null, identity: null, freeModels: null })).toBeNull()
  })
})
