import { describe, it, expect, afterEach } from 'vitest'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { generateDstackQuote } from './dstack.js'
import { nodeTeeCapability, decodeTeeTdxEvidence, tdxConfigKey, NODE_TEE_CAP_ID } from '../caps/tee-tdx.js'
import { computeReportData } from '../shared.js'

interface Stub {
  socketPath: string
  /** The report_data hex the stub last received from the client. */
  received: () => string | undefined
  close: () => Promise<void>
}

/**
 * A dstack guest-agent stub over a unix socket, with no mocks. It answers POST /GetQuote by
 * a call to `respond(reportDataHex)`. Return null to emit HTTP 500. This is the exact wire
 * contract generateDstackQuote must speak.
 */
async function startDstackStub(respond: (reportDataHex: string) => unknown): Promise<Stub> {
  const socketPath = join(tmpdir(), `ds-${randomBytes(6).toString('hex')}.sock`)
  let lastHex: string | undefined
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => {
      const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { report_data?: string }
      lastHex = parsed.report_data
      if (req.method === 'POST' && req.url === '/GetQuote') {
        const out = respond(parsed.report_data ?? '')
        if (out === null) { res.writeHead(500); res.end('boom'); return }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(out))
      } else {
        res.writeHead(404); res.end()
      }
    })
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => resolve())
  })
  return {
    socketPath,
    received: () => lastHex,
    close: () => new Promise<void>((resolve) => server.close(() => { try { unlinkSync(socketPath) } catch { /* gone */ } resolve() })),
  }
}

describe('generateDstackQuote', () => {
  let stub: Stub | undefined
  afterEach(async () => { await stub?.close(); stub = undefined })

  it('POSTs the 64-byte report_data as raw hex and returns the decoded quote bytes', async () => {
    const quoteBytes = randomBytes(128)
    stub = await startDstackStub(() => ({ quote: quoteBytes.toString('hex'), event_log: '[]' }))
    const rd = new Uint8Array(randomBytes(64))
    const q = await generateDstackQuote(rd, stub.socketPath)
    expect(Buffer.from(q).equals(quoteBytes)).toBe(true)
    expect(stub.received()).toBe(Buffer.from(rd).toString('hex'))
  })

  it('tolerates a 0x-prefixed quote hex', async () => {
    const quoteBytes = randomBytes(16)
    stub = await startDstackStub(() => ({ quote: '0x' + quoteBytes.toString('hex') }))
    const q = await generateDstackQuote(new Uint8Array(randomBytes(64)), stub.socketPath)
    expect(Buffer.from(q).equals(quoteBytes)).toBe(true)
  })

  it('throws on a non-200 response', async () => {
    stub = await startDstackStub(() => null)
    await expect(generateDstackQuote(new Uint8Array(randomBytes(64)), stub.socketPath)).rejects.toThrow(/HTTP 500/)
  })

  it('throws when the response carries no quote', async () => {
    stub = await startDstackStub(() => ({ event_log: '[]' }))
    await expect(generateDstackQuote(new Uint8Array(randomBytes(64)), stub.socketPath)).rejects.toThrow(/missing "quote"/)
  })

  it('rejects a report_data that is not 64 bytes (before touching the socket)', async () => {
    await expect(generateDstackQuote(new Uint8Array(63))).rejects.toThrow(/64 bytes/)
  })
})

describe('node-tee capability — dstack source', () => {
  let stub: Stub | undefined
  afterEach(async () => { await stub?.close(); stub = undefined })

  it('mints via the dstack socket, binding report_data = antseed-rd-v1{peerId}', async () => {
    // Echo the received report_data back as the quote so a test can assert the exact minted bytes.
    stub = await startDstackStub((rdHex) => ({ quote: rdHex }))
    const nonce = new Uint8Array(randomBytes(32))
    const peerId = 'a'.repeat(40)
    const config = {
      [tdxConfigKey(NODE_TEE_CAP_ID, 'source')]: 'dstack',
      [tdxConfigKey(NODE_TEE_CAP_ID, 'dstack.socket')]: stub.socketPath,
    }
    const evidence = await nodeTeeCapability.collect!({ nonce, peerId, config })
    const { quote } = decodeTeeTdxEvidence(evidence)
    expect(Buffer.from(quote).equals(computeReportData(nonce, peerId))).toBe(true)
  })
})
