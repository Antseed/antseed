import { request } from 'node:http'

/**
 * dstack collector: it mints a TDX quote via the dstack guest-agent unix socket. This is the
 * canonical quoting path inside dstack CVMs (e.g. Phala), where the Linux configfs-tsm
 * interface is not exposed. It POSTs the 64-byte report_data (hex) to GetQuote, which uses it
 * raw (no hashing, max 64 bytes). The quote's report_data is then byte-identical to the configfs
 * path, and the buyer verifies it unchanged.
 *
 * Wire contract (POST http://dstack/GetQuote over the socket):
 *   request  { "report_data": "<hex, <=64 bytes>" }
 *   response { "quote": "<hex>", "event_log": ..., ... }
 */

/** Default guest-agent socket locations, tried in order (mirrors @phala/dstack-sdk). */
const DEFAULT_DSTACK_SOCKETS = ['/var/run/dstack.sock', '/run/dstack.sock']
const DSTACK_TIMEOUT_MS = 20_000

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Connection-level failure (socket absent or refused) — try the next candidate, do not abort. */
function isConnError(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code
  return code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'EACCES'
}

/** POST JSON to a unix-socket HTTP server and read the whole response body. */
function postUnix(socketPath: string, path: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        socketPath,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) },
        timeout: DSTACK_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c as Buffer))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', reject)
    req.on('timeout', () => req.destroy(new Error('dstack request timed out')))
    req.end(body)
  })
}

/**
 * Generate a raw Intel TDX quote bound to `reportData` (64 bytes) via the dstack guest agent.
 * `socketPath` overrides the default locations (e.g. a custom mount or the dstack simulator).
 * It throws when no socket answers or the agent errors. The prover treats that as "cannot offer
 * this source" and omits the capability, like configfs off-TEE.
 */
export async function generateDstackQuote(reportData: Uint8Array, socketPath?: string): Promise<Uint8Array> {
  if (reportData.length !== 64) {
    throw new Error(`reportData must be 64 bytes, got ${reportData.length}`)
  }
  const body = JSON.stringify({ report_data: Buffer.from(reportData).toString('hex') })
  const candidates = socketPath ? [socketPath] : DEFAULT_DSTACK_SOCKETS
  let lastErr: unknown
  for (const sock of candidates) {
    try {
      const { status, body: resp } = await postUnix(sock, '/GetQuote', body)
      if (status !== 200) throw new Error(`dstack GetQuote returned HTTP ${status}`)
      const parsed = JSON.parse(resp) as { quote?: string }
      if (typeof parsed.quote !== 'string' || parsed.quote.length === 0) {
        throw new Error('dstack GetQuote response missing "quote"')
      }
      const quote = Buffer.from(parsed.quote.replace(/^0x/, ''), 'hex')
      if (quote.length === 0) throw new Error('dstack GetQuote "quote" is not valid hex')
      return new Uint8Array(quote)
    } catch (err) {
      lastErr = err
      if (isConnError(err)) continue // this socket is not there — try the next candidate
      throw new Error(`dstack quote generation failed: ${msg(err)}`)
    }
  }
  throw new Error(`dstack guest agent not reachable at ${candidates.join(', ')}: ${msg(lastErr)}`)
}
