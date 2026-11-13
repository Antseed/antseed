import { describe, it, expect, afterEach } from 'vitest'
import { createServer, type Server } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { unlinkSync } from 'node:fs'
import { NODE_TEE_CAP_ID, nodeTeeCapability, tdxConfigKey } from '../caps/tee-tdx.js'
import { computeReportData } from '../shared.js'
import { CS_AUDIENCE, confidentialSpaceNonce } from '../confidential-space.js'

/** A container-launcher stub over a unix socket: answers POST /v1/token with a fixed JWT. */
async function startLauncher(): Promise<{ socketPath: string; requests: unknown[]; server: Server }> {
  const socketPath = join(tmpdir(), `cs-${randomBytes(6).toString('hex')}.sock`)
  const requests: unknown[] = []
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c) => chunks.push(c as Buffer))
    req.on('end', () => {
      if (req.method !== 'POST' || req.url !== '/v1/token') { res.writeHead(404); res.end(); return }
      requests.push(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      res.writeHead(200, { 'content-type': 'text/plain' })
      res.end('aGVhZGVy.cGF5bG9hZA.c2ln')
    })
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  return { socketPath, requests, server }
}

describe('Confidential Space collector', () => {
  let close: (() => Promise<void>) | undefined
  afterEach(async () => { await close?.(); close = undefined })

  it('asks the launcher for a token carrying the round and connection nonce', async () => {
    const { socketPath, requests, server } = await startLauncher()
    close = () => new Promise((resolve) => server.close(() => { try { unlinkSync(socketPath) } catch { /* gone */ } resolve() }))
    const nonce = new Uint8Array(randomBytes(32))
    const peerId = 'a'.repeat(40)
    const binding = 'c'.repeat(64)
    const evidence = await nodeTeeCapability.collect!({
      nonce,
      peerId,
      config: {
        [tdxConfigKey(NODE_TEE_CAP_ID, 'source')]: 'confidential-space',
        [tdxConfigKey(NODE_TEE_CAP_ID, 'confidentialSpace.socket')]: socketPath,
        [tdxConfigKey(NODE_TEE_CAP_ID, 'channelBinding')]: binding,
      },
    })
    expect(JSON.parse(new TextDecoder().decode(evidence))).toEqual({ confidentialSpaceToken: 'aGVhZGVy.cGF5bG9hZA.c2ln' })
    expect(requests).toEqual([{ audience: CS_AUDIENCE, token_type: 'OIDC', nonces: [confidentialSpaceNonce(computeReportData(nonce, peerId, binding))] }])
  })
})
