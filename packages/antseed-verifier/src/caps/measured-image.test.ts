import { describe, it, expect } from 'vitest'
import { randomBytes } from 'node:crypto'
import { measuredImageCapability, type MeasuredImagePolicy } from './measured-image.js'
import type { ParsedTdxQuote, TdMeasurements } from './tee-tdx.js'
import { claimId } from '../shared.js'

const CLAIM = claimId('seller-provider-measured-image')
const NONCE = randomBytes(32)
const PEER = 'f'.repeat(40)

const MRTD = randomBytes(48)
const RTMR0 = randomBytes(48)

function td(over: Partial<TdMeasurements> = {}): TdMeasurements {
  return {
    mrTd: MRTD,
    rtMr0: RTMR0,
    rtMr1: new Uint8Array(48),
    rtMr2: new Uint8Array(48),
    rtMr3: new Uint8Array(48),
    reportData: new Uint8Array(64),
    debug: false,
    ...over,
  }
}

function parsed(t: TdMeasurements | null, bound = false): ParsedTdxQuote {
  return { quoteEvidence: randomBytes(10), status: 'UpToDate', td: t, ...(bound ? { binding: { scheme: 'antseed-rd-v1', ingredients: {} } } : {}) }
}

function verify(t: TdMeasurements | null, policy?: MeasuredImagePolicy, bound = false) {
  return measuredImageCapability.verify({ nonce: NONCE, peerId: PEER, parsedQuote: parsed(t, bound), policy })
}

const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

describe('measured-image capability', () => {
  it('never passes by default: no policy → ok:false', () => {
    const r = verify(td())
    expect(r).toMatchObject({ claim: CLAIM, ok: false })
    expect(r.detail).toMatch(/no approved measurement set configured/)
  })

  it('passes when MRTD matches an approved measurement (mrtd only), with a freshness caveat when unbound', () => {
    const r = verify(td(), { approvedMeasurements: [{ mrtd: hex(MRTD) }] })
    expect(r.ok).toBe(true)
    expect(r.detail).toMatch(/match an approved image/)
    expect(r.detail).toMatch(/freshness\/instance binding NOT verified/)
  })

  it('drops the freshness caveat when the provider quote declares a report_data scheme', () => {
    const r = verify(td(), { approvedMeasurements: [{ mrtd: hex(MRTD) }] }, true)
    expect(r.ok).toBe(true)
    expect(r.detail).not.toMatch(/freshness/)
  })

  it('matches case-insensitively and also checks provided RTMRs', () => {
    const r = verify(td(), { approvedMeasurements: [{ mrtd: hex(MRTD).toUpperCase(), rtmr0: hex(RTMR0) }] })
    expect(r.ok).toBe(true)
  })

  it('fails when a specified RTMR does not match', () => {
    const r = verify(td(), { approvedMeasurements: [{ mrtd: hex(MRTD), rtmr0: hex(randomBytes(48)) }] })
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/matches no approved measurement/)
  })

  it('fails when MRTD is not in the allow-list', () => {
    const r = verify(td(), { approvedMeasurements: [{ mrtd: hex(randomBytes(48)) }] })
    expect(r.ok).toBe(false)
  })

  it('fails when there is no TDX quote to measure', () => {
    const r = verify(null, { approvedMeasurements: [{ mrtd: hex(MRTD) }] })
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/no TDX measurements available/)
  })
})
