import { describe, expect, it } from 'vitest'
import { computeScoreBps, SERVICE_MODEL_MATCH, SERVICE_PRICE_MATCH, SERVICE_UNDETERMINED } from '../src/score.js'

const PASS = SERVICE_MODEL_MATCH | SERVICE_PRICE_MATCH

// Values match packages/contracts/test/verification/AntseedVerification.t.sol.
describe('computeScoreBps', () => {
  it('rewards distinct verified models with diminishing returns', () => {
    expect(computeScoreBps([{ modelHash: 'a', flags: PASS }, { modelHash: 'b', flags: PASS }])).toBe(5_000)
    expect(computeScoreBps([{ modelHash: 'a', flags: PASS }, { modelHash: 'a', flags: PASS }])).toBe(3_154)
  })

  it('makes every failed or undetermined service expensive', () => {
    expect(computeScoreBps([{ modelHash: 'a', flags: PASS }, { modelHash: 'b', flags: SERVICE_MODEL_MATCH }])).toBe(197)
    expect(computeScoreBps([{ modelHash: 'a', flags: PASS }, { modelHash: 'b', flags: PASS | SERVICE_UNDETERMINED }])).toBe(197)
    expect(computeScoreBps([{ modelHash: 'a', flags: SERVICE_MODEL_MATCH }])).toBe(0)
  })

  it('saturates breadth at maxBreadth', () => {
    const results = ['a', 'b', 'c'].map((modelHash) => ({ modelHash, flags: PASS }))
    expect(computeScoreBps(results, 2)).toBe(10_000)
  })
})
