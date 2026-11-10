import { afterEach, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { verifyTdxLiteOs as dstackVerifyTdxLiteOs } from '@phala/dstack-verifier-wasm'
import {
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
  it('loads the packaged verifyTdxLiteOs', () => {
    expect(loadVerifyTdxLiteOs()).toBe(dstackVerifyTdxLiteOs)
  })

  it('uses an injected contract implementation', () => {
    const seen: TdxLiteOsInput[] = []
    const result: TdxLiteOsResult = { ok: true, osImageHash: 'ab'.repeat(32), reason: null }
    injectVerifyTdxLiteOs((got) => {
      seen.push(got)
      return result
    })
    expect(verifyTdxLiteOs(input)).toEqual(result)
    expect(seen).toEqual([input])
  })

  it('propagates a not-ok reason and never throws', () => {
    injectVerifyTdxLiteOs(() => ({ ok: false, osImageHash: null, reason: 'acpi mismatch' }))
    expect(verifyTdxLiteOs(input)).toMatchObject({ ok: false, reason: 'acpi mismatch' })
    injectVerifyTdxLiteOs(() => {
      throw new Error('boom')
    })
    expect(verifyTdxLiteOs(input)).toMatchObject({ ok: false, reason: 'boom' })
  })
})

/**
 * Copied from Dstack-TEE/dstack `dstack/verifier/fixtures/tdx-lite-getquote.json`
 * (Apache-2.0; dstack test data, not Antseed's).
 */
const fixture = JSON.parse(readFileSync(new URL('./tdx-lite-getquote.fixture.json', import.meta.url), 'utf8')) as {
  quote: string
  event_log: string
  vm_config: string
}

async function mrsFromQuoteHex(quoteHex: string): Promise<{ mrtd: string; rtmr0: string; rtmr1: string; rtmr2: string }> {
  const mod = (await import('@phala/dcap-qvl')) as typeof import('@phala/dcap-qvl') & { default?: typeof import('@phala/dcap-qvl') }
  const dcap = mod.default ?? mod
  const td = dcap.Quote.parse(Buffer.from(quoteHex, 'hex')).report.asTd10()
  if (!td) throw new Error('fixture quote is not a TDX report')
  const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
  return { mrtd: hex(td.mrTd), rtmr0: hex(td.rtMr0), rtmr1: hex(td.rtMr1), rtmr2: hex(td.rtMr2) }
}

describe('dstack lite OS verifier (real wasm)', () => {
  it('accepts the public TDX lite getquote fixture and returns its os_image_hash', async () => {
    const mrs = await mrsFromQuoteHex(fixture.quote)
    const result = verifyTdxLiteOs({ ...mrs, eventLog: fixture.event_log, vmConfig: fixture.vm_config })
    expect(result).toMatchObject({ ok: true, reason: null })
    expect(result.osImageHash).toBe((JSON.parse(fixture.vm_config) as { os_image_hash: string }).os_image_hash)
  })

  it('rejects a tampered vm_config memory_size with a reason naming the register or table', async () => {
    const mrs = await mrsFromQuoteHex(fixture.quote)
    const vm = JSON.parse(fixture.vm_config) as Record<string, unknown>
    const result = verifyTdxLiteOs({ ...mrs, eventLog: fixture.event_log, vmConfig: JSON.stringify({ ...vm, memory_size: 4 * 1024 ** 3 }) })
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/RTMR|acpi|ACPI|table/i)
  })

  it('rejects a tampered RTMR2 with a reason naming the register', async () => {
    const mrs = await mrsFromQuoteHex(fixture.quote)
    const result = verifyTdxLiteOs({ ...mrs, rtmr2: '00'.repeat(48), eventLog: fixture.event_log, vmConfig: fixture.vm_config })
    expect(result.ok).toBe(false)
    expect(result.reason).toMatch(/RTMR2/i)
  })
})
