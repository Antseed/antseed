import type { ClaimResult } from '../antseed-node-types.js'
import type { Capability, CapabilityVerifyInput } from '../capability.js'
import type { ParsedTdxQuote } from './tee-tdx.js'
import { claimId } from '../shared.js'

/**
 * Capability 'seller-provider-measured-image': proves the inference provider booted a
 * specific, approved software image. It compares the provider TDX quote's authenticated
 * measurements (MRTD + RTMR0-3) to a buyer-supplied allow-list. The approved measurements
 * are pure data passed in via policy — never fetched, never hardcoded — so the SDK stays
 * provider-agnostic. With no policy it returns ok:false; it never passes by default. It
 * derives from the provider quote, so it has no own evidence.
 */

const CAP_ID = 'seller-provider-measured-image'

/** One approved image fingerprint. Hex strings (no 0x); rtmrN optional (checked when present). */
export interface ApprovedMeasurement {
  mrtd: string
  rtmr0?: string
  rtmr1?: string
  rtmr2?: string
  rtmr3?: string
}

export interface MeasuredImagePolicy {
  approvedMeasurements?: ApprovedMeasurement[]
}

function hex(b: Uint8Array): string {
  return Buffer.from(b).toString('hex')
}

/** A measurement matches only if every field it specifies equals the quote's value. */
function matches(m: ApprovedMeasurement, td: ParsedTdxQuote['td']): boolean {
  if (!td) return false
  const eq = (expected: string | undefined, actual: Uint8Array): boolean =>
    expected === undefined || expected.toLowerCase() === hex(actual)
  return (
    m.mrtd.toLowerCase() === hex(td.mrTd) &&
    eq(m.rtmr0, td.rtMr0) &&
    eq(m.rtmr1, td.rtMr1) &&
    eq(m.rtmr2, td.rtMr2) &&
    eq(m.rtmr3, td.rtMr3)
  )
}

export const measuredImageCapability: Capability = {
  id: CAP_ID,

  verify(input: CapabilityVerifyInput): ClaimResult {
    const claim = claimId(CAP_ID)
    const p = input.parsedQuote as ParsedTdxQuote | undefined
    if (!p || !p.td) return { claim, ok: false, detail: 'no TDX measurements available (a verified tee-tdx quote is required)' }
    const policy = input.policy as MeasuredImagePolicy | undefined
    const approved = policy?.approvedMeasurements
    if (!approved || approved.length === 0) {
      return { claim, ok: false, detail: 'no approved measurement set configured' }
    }
    if (!approved.some((m) => matches(m, p.td))) {
      return { claim, ok: false, detail: `MRTD ${hex(p.td.mrTd).slice(0, 16)}… matches no approved measurement` }
    }
    // A matching measurement alone says nothing about freshness. Without a report_data scheme
    // that binds this quote to the round, it could be a genuine but replayed or borrowed quote.
    const caveat = p.binding ? '' : ' (freshness/instance binding NOT verified — no report_data scheme declared)'
    return { claim, ok: true, detail: `measurements match an approved image (MRTD ${hex(p.td.mrTd).slice(0, 16)}…)${caveat}` }
  },
}
