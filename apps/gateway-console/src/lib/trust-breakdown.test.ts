import { describe, expect, it } from 'vitest'
import { modelChecksEffect, trustBreakdownLabel } from './trust-breakdown'

describe('trustBreakdownLabel', () => {
  it('lists the parts that have data', () => {
    expect(trustBreakdownLabel({ usage: 12, power: null, identity: { score: 18, kind: 'github' }, freeModels: 5 }))
      .toBe('Usage 12 · GitHub 18 · Free models 5')
  })

  it('ends with the model-check penalty', () => {
    expect(trustBreakdownLabel({ usage: 14, power: 44, identity: { score: 6, kind: 'domain' }, freeModels: null,
      verification: { multiplierBps: 9600, sameCount: 0, diffCount: 1, change: -2.6 } }))
      .toBe('Usage 14 · Power 44 · Domain 6 · Model checks −3')
  })

  it('ends with the model-check bonus', () => {
    expect(trustBreakdownLabel({ usage: 14, power: 44, identity: null, freeModels: null,
      verification: { multiplierBps: 10_200, sameCount: 9, diffCount: 2, change: 1.2 } }))
      .toBe('Usage 14 · Power 44 · Model checks +1')
  })

  it('shows the history an older buyer daemon still scores', () => {
    expect(trustBreakdownLabel({ history: 50, usage: 12, power: null, identity: null, freeModels: null }))
      .toBe('History 50 · Usage 12')
  })

  it('is null without a breakdown or any part', () => {
    expect(trustBreakdownLabel(undefined)).toBeNull()
    expect(trustBreakdownLabel({ usage: null, power: null, identity: null, freeModels: null })).toBeNull()
  })
})

describe('modelChecksEffect', () => {
  it('explains a penalty', () => {
    expect(modelChecksEffect({ multiplierBps: 9600, sameCount: 0, diffCount: 1, change: -2.5 }, 60))
      .toBe('Model checks found 1 DIFF: it earns 96% of normal points, so the score moved from 62.5 to 60.')
  })

  it('explains a bonus', () => {
    expect(modelChecksEffect({ multiplierBps: 10_200, sameCount: 9, diffCount: 2, change: 1.2 }, 61.2))
      .toBe('Model checks found 9 verified, 2 DIFF: it earns 102% of normal points, so the score moved from 60 to 61.2.')
  })
})
