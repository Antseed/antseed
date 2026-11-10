import { afterEach, describe, expect, it } from 'vitest'
import {
  DSTACK_LITE_OS_UNAVAILABLE,
  injectVerifyTdxLiteOs,
  loadVerifyTdxLiteOs,
  verifyTdxLiteOs,
  type TdxLiteOsInput,
  type TdxLiteOsResult,
} from './dstack-lite-os.js'

const input: TdxLiteOsInput = {
  mrtd: 'aa'.repeat(48),
  rtmr0: '00'.repeat(48),
  rtmr1: '00'.repeat(48),
  rtmr2: '00'.repeat(48),
  eventLog: '[]',
  vmConfig: '{"cpu_count":1}',
}

afterEach(() => injectVerifyTdxLiteOs(undefined))

describe('dstack lite OS verifier loader', () => {
  it('is unavailable until the WASM package is wired in loadVerifyTdxLiteOs', () => {
    expect(loadVerifyTdxLiteOs()).toBeNull()
    expect(verifyTdxLiteOs(input)).toEqual({
      ok: false,
      osImageHash: null,
      acpiTablesVerified: false,
      reason: DSTACK_LITE_OS_UNAVAILABLE,
    })
  })

  it('uses an injected contract implementation', () => {
    const seen: TdxLiteOsInput[] = []
    const result: TdxLiteOsResult = { ok: true, osImageHash: 'ab'.repeat(32), acpiTablesVerified: true, reason: null }
    injectVerifyTdxLiteOs((got) => {
      seen.push(got)
      return result
    })
    expect(verifyTdxLiteOs(input)).toEqual(result)
    expect(seen).toEqual([input])
  })

  it('propagates a not-ok reason and never throws', () => {
    injectVerifyTdxLiteOs(() => ({ ok: false, osImageHash: null, acpiTablesVerified: false, reason: 'acpi mismatch' }))
    expect(verifyTdxLiteOs(input)).toMatchObject({ ok: false, reason: 'acpi mismatch' })
    injectVerifyTdxLiteOs(() => {
      throw new Error('boom')
    })
    expect(verifyTdxLiteOs(input)).toMatchObject({ ok: false, reason: 'boom' })
  })
})
