import { postUnix } from './unix-http.js'

/**
 * dstack collector: it mints a TDX quote via the dstack guest-agent unix socket. This is the
 * canonical quoting path inside dstack CVMs (e.g. Phala), where the Linux configfs-tsm
 * interface is not exposed. It POSTs the 64-byte report_data (hex) to GetQuote, which uses it
 * raw (no hashing, max 64 bytes). The quote's report_data is then byte-identical to the configfs
 * path, and the buyer verifies it unchanged.
 *
 * Wire contract (POST over the socket):
 *   /GetQuote  request { "report_data": "<hex, <=64 bytes>" }  response { "quote": "<hex>", "event_log": "<json>", ... }
 *   /Info      request {}  response { "tcb_info": "<json with app_compose>", ... }
 */

/** Default guest-agent socket locations, tried in order (mirrors @phala/dstack-sdk). */
const DEFAULT_DSTACK_SOCKETS = ['/var/run/dstack.sock', '/run/dstack.sock']
const DSTACK_REQUEST = { timeoutMs: 20_000, timeoutMessage: 'dstack request timed out' }

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Connection-level failure (socket absent or refused) — try the next candidate, do not abort. */
function isConnError(err: unknown): boolean {
  const code = (err as { code?: string } | undefined)?.code
  return code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'EACCES'
}

/**
 * Generate a raw Intel TDX quote bound to `reportData` (64 bytes) via the dstack guest agent.
 * `socketPath` overrides the default locations (e.g. a custom mount or the dstack simulator).
 * It throws when no socket answers or the agent errors. The prover treats that as "cannot offer
 * this source" and omits the capability, like configfs off-TEE.
 */
export async function generateDstackQuote(reportData: Uint8Array, socketPath?: string): Promise<Uint8Array> {
  return (await generateDstackAttestation(reportData, socketPath)).quote
}

/** The app-compose.json the CVM was measured with (tcb_info.app_compose of the agent's Info), if available. */
async function readAppCompose(socketPath: string): Promise<string | undefined> {
  try {
    const { status, body } = await postUnix(socketPath, '/Info', '{}', DSTACK_REQUEST)
    if (status !== 200) return undefined
    const info = JSON.parse(body) as { tcb_info?: unknown }
    const tcb = (typeof info.tcb_info === 'string' ? JSON.parse(info.tcb_info) : info.tcb_info) as { app_compose?: unknown } | undefined
    return typeof tcb?.app_compose === 'string' && tcb.app_compose.length > 0 ? tcb.app_compose : undefined
  } catch {
    return undefined
  }
}

/**
 * The quote plus what a buyer needs to check the app it measured: the agent's event log (a JSON
 * string), which replays RTMR3 to the app's compose hash, and the app-compose.json that hash
 * covers. Either is undefined when the agent does not return it.
 */
export async function generateDstackAttestation(
  reportData: Uint8Array,
  socketPath?: string,
): Promise<{ quote: Uint8Array; eventLog?: string; appCompose?: string }> {
  if (reportData.length !== 64) {
    throw new Error(`reportData must be 64 bytes, got ${reportData.length}`)
  }
  const body = JSON.stringify({ report_data: Buffer.from(reportData).toString('hex') })
  const candidates = socketPath ? [socketPath] : DEFAULT_DSTACK_SOCKETS
  let lastErr: unknown
  for (const sock of candidates) {
    try {
      const { status, body: resp } = await postUnix(sock, '/GetQuote', body, DSTACK_REQUEST)
      if (status !== 200) throw new Error(`dstack GetQuote returned HTTP ${status}`)
      const parsed = JSON.parse(resp) as { quote?: string; event_log?: unknown }
      if (typeof parsed.quote !== 'string' || parsed.quote.length === 0) {
        throw new Error('dstack GetQuote response missing "quote"')
      }
      const quote = Buffer.from(parsed.quote.replace(/^0x/, ''), 'hex')
      if (quote.length === 0) throw new Error('dstack GetQuote "quote" is not valid hex')
      const eventLog = typeof parsed.event_log === 'string' && parsed.event_log.length > 0 ? parsed.event_log : undefined
      const appCompose = await readAppCompose(sock)
      return { quote: new Uint8Array(quote), ...(eventLog ? { eventLog } : {}), ...(appCompose ? { appCompose } : {}) }
    } catch (err) {
      lastErr = err
      if (isConnError(err)) continue // this socket is not there — try the next candidate
      throw new Error(`dstack quote generation failed: ${msg(err)}`)
    }
  }
  throw new Error(`dstack guest agent not reachable at ${candidates.join(', ')}: ${msg(lastErr)}`)
}
