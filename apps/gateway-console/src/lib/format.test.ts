import { describe, expect, it } from 'vitest'
import { describeLimits, formatDuration, formatPricePerMillion, formatUsd, parseUsdInput, periodStart, shortId, usdcForInput, usdcToNumber } from './format'
import { draftToLimits, limitsToDraft } from './limits'
import { formatAnts } from './ants'

describe('money formatting', () => {
  it('formats dollars with cents', () => {
    expect(formatUsd('12.345678')).toBe('$12.35')
    expect(formatUsd('1234.5')).toBe('$1,234.50')
    expect(formatUsd(0)).toBe('$0.00')
    expect(formatUsd('-2.5')).toBe('-$2.50')
    expect(formatUsd(null)).toBe('—')
  })
  it('shows sub-cent amounts with more precision', () => {
    expect(formatUsd('0.004200')).toBe('$0.0042')
    expect(formatUsd('0.000010')).toBe('<$0.0001')
    expect(formatUsd('0.0005')).toBe('$0.0005')
  })
  it('compacts large values on request', () => {
    expect(formatUsd(125_000, { compact: true })).toBe('$125K')
  })
  it('treats bad wire values as zero', () => {
    expect(usdcToNumber('abc')).toBe(0)
    expect(usdcToNumber(undefined)).toBe(0)
  })
  it('parses user input into wire decimals', () => {
    expect(parseUsdInput('5')).toBe('5.000000')
    expect(parseUsdInput('$12.5')).toBe('12.500000')
    expect(parseUsdInput('1,000.25')).toBe('1000.250000')
    expect(parseUsdInput('007')).toBe('7.000000')
    expect(parseUsdInput('  ')).toBeNull()
    expect(() => parseUsdInput('1.1234567')).toThrow()
    expect(() => parseUsdInput('-1')).toThrow()
  })
  it('trims wire decimals for inputs', () => {
    expect(usdcForInput('5.500000')).toBe('5.5')
    expect(usdcForInput('5.000000')).toBe('5')
    expect(usdcForInput(null)).toBe('')
  })
  it('formats per-million prices', () => {
    expect(formatPricePerMillion(0)).toBe('Free')
    expect(formatPricePerMillion(0.125)).toBe('$0.125')
    expect(formatPricePerMillion(3)).toBe('$3.00')
    expect(formatPricePerMillion(0.2)).toBe('$0.20')
    expect(formatPricePerMillion(null)).toBe('—')
  })
  it('formats ANTS amounts', () => {
    expect(formatAnts('41.25')).toBe('41.25 ANTS')
    expect(formatAnts('1500000000000000000')).toBe('1.5 ANTS')
    expect(formatAnts('0')).toBe('0 ANTS')
    expect(formatAnts(null)).toBe('0 ANTS')
  })
})

describe('limits', () => {
  it('describes limits', () => {
    expect(describeLimits({ daily: '5.000000', weekly: null, monthly: '100.000000', total: null })).toBe('$5.00/day · $100.00/month')
    expect(describeLimits({ daily: null, weekly: null, monthly: null, total: null })).toBe('No limits')
  })
  it('round-trips through the editor draft', () => {
    const limits = { daily: '5.000000', weekly: '20.500000', monthly: null, total: '1000.000000' }
    expect(draftToLimits(limitsToDraft(limits))).toEqual(limits)
  })
  it('names the period on invalid input', () => {
    expect(() => draftToLimits({ daily: 'x', weekly: '', monthly: '', total: '' })).toThrow(/^Daily limit/)
  })
})

describe('time helpers', () => {
  const wednesday = Date.UTC(2026, 9, 7, 15, 30)
  it('computes UTC period starts with Monday weeks', () => {
    expect(periodStart('daily', wednesday)).toBe(Date.UTC(2026, 9, 7))
    expect(periodStart('weekly', wednesday)).toBe(Date.UTC(2026, 9, 5))
    expect(periodStart('monthly', wednesday)).toBe(Date.UTC(2026, 9, 1))
    expect(periodStart('weekly', Date.UTC(2026, 9, 11, 23))).toBe(Date.UTC(2026, 9, 5))
  })
  it('formats durations and ids', () => {
    expect(formatDuration(90 * 60_000)).toBe('1 h 30 min')
    expect(formatDuration(30_000)).toBe('<1 min')
    expect(shortId('0x1234567890abcdef')).toBe('0x1234…cdef')
    expect(shortId('short')).toBe('short')
  })
})
