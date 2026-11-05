import { describe, expect, it } from 'vitest'
import { diffRoutingNote, hasDiffVerdict, modelCheckLabel, offerTrustLabel } from './model-check'

const diff = { verdict: 'diff' as const, auditUrl: 'https://explorer.test/verification-service/1~0x01' }
const same = { verdict: 'same' as const, auditUrl: null }

describe('model check', () => {
  it('labels each verdict', () => {
    expect(modelCheckLabel(diff)).toBe('Model check: DIFF')
    expect(modelCheckLabel(same)).toBe('Verified model')
  })

  it('shows the routing cut next to trust only for DIFF', () => {
    expect(offerTrustLabel(72.4, diff)).toBe('Trust 7 · cut from 72')
    expect(offerTrustLabel(72.4, same)).toBe('Trust 72')
    expect(offerTrustLabel(null, undefined)).toBe('Trust —')
  })

  it('names the cut models on a seller', () => {
    expect(diffRoutingNote({})).toBeNull()
    expect(diffRoutingNote({ diffServices: ['qwen3-coder-480b'] })).toBe('Counts 10% in routing for qwen3-coder-480b')
    expect(diffRoutingNote({ diffServices: ['a', 'b'] })).toBe('Counts 10% in routing for 2 models')
  })

  it('matches the model case-insensitively', () => {
    expect(hasDiffVerdict({ diffServices: ['m1'] }, ' M1 ')).toBe(true)
    expect(hasDiffVerdict({ diffServices: ['m1'] }, 'm2')).toBe(false)
    expect(hasDiffVerdict(undefined, 'm1')).toBe(false)
  })
})
