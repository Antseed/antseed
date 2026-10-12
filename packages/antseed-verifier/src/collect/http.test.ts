import { describe, it, expect, vi, afterEach } from 'vitest'
import { randomBytes } from 'node:crypto'
import { collectViaHttp, collectJsonFieldViaHttp } from './http.js'

const NONCE = randomBytes(32)
const HEX = Buffer.from(NONCE).toString('hex')

/** Stub fetch: capture the URL and return a JSON body. */
function stubFetch(body: unknown, ok = true, status = 200): { seenUrl: () => string } {
  let url = ''
  vi.stubGlobal('fetch', vi.fn(async (u: string) => {
    url = u
    return { ok, status, json: async () => body }
  }))
  return { seenUrl: () => url }
}

afterEach(() => vi.unstubAllGlobals())

describe('collectViaHttp', () => {
  it('substitutes {nonce} with the hex nonce and extracts a flat FIELD', async () => {
    const quote = randomBytes(96)
    const f = stubFetch({ quote: Buffer.from(quote).toString('base64') })
    const out = await collectViaHttp('https://x.example/att/{nonce}', NONCE, 'quote')
    expect(f.seenUrl()).toBe(`https://x.example/att/${HEX}`)
    expect(Buffer.from(out).equals(quote)).toBe(true)
  })

  it('extracts a nested dot-path FIELD', async () => {
    const quote = randomBytes(64)
    stubFetch({ data: { quote: Buffer.from(quote).toString('base64') } })
    const out = await collectViaHttp('https://x.example/att', NONCE, 'data.quote')
    expect(Buffer.from(out).equals(quote)).toBe(true)
  })

  it('throws on a non-2xx response', async () => {
    stubFetch({}, false, 503)
    await expect(collectViaHttp('https://x.example/att', NONCE, 'quote')).rejects.toThrow(/HTTP 503/)
  })

  it('throws when the FIELD is absent', async () => {
    stubFetch({ nope: 'x' })
    await expect(collectViaHttp('https://x.example/att', NONCE, 'quote')).rejects.toThrow(/no base64 quote at "quote"/)
  })
})

describe('collectJsonFieldViaHttp', () => {
  it('extracts a structured field and preserves it as JSON bytes', async () => {
    const gpu = { arch: 'HOPPER', evidence_list: [{ evidence: 'e', certificate: 'c' }] }
    const f = stubFetch({ gpu_evidence: gpu })
    const out = await collectJsonFieldViaHttp('https://x.example/att/{nonce}', NONCE, 'gpu_evidence')
    expect(f.seenUrl()).toBe(`https://x.example/att/${HEX}`)
    expect(JSON.parse(new TextDecoder().decode(out))).toEqual(gpu)
  })

  it('throws when the field is absent', async () => {
    stubFetch({ nope: 'x' })
    await expect(collectJsonFieldViaHttp('https://x.example/att', NONCE, 'gpu_evidence')).rejects.toThrow(/no value at "gpu_evidence"/)
  })
})
