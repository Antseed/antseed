import { randomBytes } from 'node:crypto'
import { linkSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  GATEWAY_CONTROL_HEADER,
  GATEWAY_CONTROL_SECRET_ENV,
  GATEWAY_CONTROL_SECRET_FILE,
  ROUTING_POLICY_HEADER,
  encodePolicyHeader,
  type RoutingPolicy,
} from '../routing-policy/policy.js'

const BUYER_FETCH_TIMEOUT_MS = 5_000

function readSecret(path: string): string | null {
  try {
    const value = readFileSync(path, 'utf8').trim()
    return value.length > 0 ? value : null
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * The secret proving to the buyer that a routing policy came from this
 * gateway. `ANTSEED_GATEWAY_CONTROL_SECRET` wins; otherwise it lives in
 * `<dataDir>/gateway/buyer-control.secret` (0600), created by whichever
 * process needs it first. The file appears atomically (written aside, then
 * hard-linked into place), so a concurrent reader never sees half of it and
 * two creators agree on one value.
 */
export function loadOrCreateControlSecret(dataDir: string): string {
  const fromEnv = process.env[GATEWAY_CONTROL_SECRET_ENV]?.trim()
  if (fromEnv) return fromEnv
  const path = join(dataDir, GATEWAY_CONTROL_SECRET_FILE)
  const existing = readSecret(path)
  if (existing) return existing
  mkdirSync(dirname(path), { recursive: true })
  const secret = randomBytes(32).toString('hex')
  const temp = `${path}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  writeFileSync(temp, `${secret}\n`, { mode: 0o600, flag: 'wx' })
  try {
    linkSync(temp, path)
    return secret
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    const winner = readSecret(path)
    if (!winner) throw new Error(`${path} exists but is empty`)
    return winner
  } finally {
    try { unlinkSync(temp) } catch { /* already gone */ }
  }
}

/**
 * Calls a buyer control endpoint with the gateway's secret, optionally
 * scoped to a routing policy and a buyer identity (`?identity=`).
 */
export async function buyerFetch(
  opts: { buyerPort: number; secret: string; timeoutMs?: number },
  path: string,
  init: { method?: string; body?: unknown; policy?: RoutingPolicy; identity?: string } = {},
): Promise<Response> {
  const url = new URL(path, `http://127.0.0.1:${opts.buyerPort}`)
  if (init.identity) url.searchParams.set('identity', init.identity)
  const headers: Record<string, string> = { [GATEWAY_CONTROL_HEADER]: opts.secret }
  if (init.policy) headers[ROUTING_POLICY_HEADER] = encodePolicyHeader(init.policy)
  if (init.body !== undefined) headers['content-type'] = 'application/json'
  return fetch(url, {
    method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
    headers,
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    signal: AbortSignal.timeout(opts.timeoutMs ?? BUYER_FETCH_TIMEOUT_MS),
  })
}
