import { randomBytes, timingSafeEqual } from 'node:crypto'
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { teeControlFileName, type TeeSnapshot } from '@antseed/node/tee-status'

export class TeeControl {
  private readonly token = randomBytes(32).toString('hex')
  private file: string | undefined
  private ready = false
  private lastCheck = 0

  constructor(private readonly sessionId: string) {}

  async publish(directory: string, port: number): Promise<void> {
    await mkdir(directory, { recursive: true })
    this.file = join(directory, teeControlFileName(port))
    const temporary = `${this.file}.${this.sessionId}.tmp`
    try {
      await writeFile(temporary, JSON.stringify({ token: this.token, sessionId: this.sessionId, port }), { mode: 0o600, flag: 'wx' })
      await chmod(temporary, 0o600)
      await rename(temporary, this.file)
      this.ready = true
    } finally {
      await unlink(temporary).catch(() => {})
    }
  }

  async close(): Promise<void> {
    this.ready = false
    if (!this.file) return
    try {
      const current = JSON.parse(await readFile(this.file, 'utf8')) as { sessionId?: string }
      if (current.sessionId === this.sessionId) await unlink(this.file)
    } catch {}
  }

  async handle(req: IncomingMessage, res: ServerResponse, method: string, path: string,
    snapshot: () => TeeSnapshot, check: (peerId: string) => Promise<void>): Promise<void> {
    const reply = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    const supplied = req.headers.authorization ?? ''
    const expected = `Bearer ${this.token}`
    const remote = req.socket.remoteAddress
    if (!this.ready || req.headers.origin !== undefined
      || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(remote ?? '')
      || Buffer.byteLength(supplied) !== Buffer.byteLength(expected)
      || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
      reply(403, { error: 'Local verification authorization required' })
      return
    }
    if (method === 'GET' && path === '/_antseed/verification') {
      reply(200, snapshot())
      return
    }
    if (method !== 'POST' || path !== '/_antseed/verification/check') {
      reply(404, { error: 'Unknown verification endpoint' })
      return
    }
    if (Date.now() - this.lastCheck < 1000) {
      reply(429, { error: 'Wait before checking another seller' })
      return
    }
    this.lastCheck = Date.now()
    try {
      const chunks: Buffer[] = []
      let size = 0
      const timer = setTimeout(() => req.destroy(), 5000)
      try {
        for await (const chunk of req) {
          const bytes = Buffer.from(chunk as Uint8Array)
          size += bytes.length
          if (size > 1024) { reply(413, { error: 'Request too large' }); return }
          chunks.push(bytes)
        }
      } finally { clearTimeout(timer) }
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).length !== 1 || !('peerId' in body)
        || typeof body.peerId !== 'string' || !/^(?:0x)?[a-f0-9]{40}$/i.test(body.peerId)) {
        reply(400, { error: 'A known seller peerId is required' })
        return
      }
      await check(body.peerId)
      reply(200, snapshot())
    } catch (error) {
      reply(400, { error: error instanceof Error ? error.message : 'Verification unavailable' })
    }
  }
}
