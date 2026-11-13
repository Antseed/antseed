/** Test doubles shared by the wallet and network handler tests: a fake buyer daemon and a request runner. */
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { encodePolicyHeader, GATEWAY_CONTROL_HEADER, ROUTING_POLICY_HEADER } from '../../../routing-policy/policy.js'
import type { ConsoleDeps } from '../deps.js'
import { ConsoleError, type ConsoleRouter, type Principal } from '../router.js'
import type { BuyerClient } from './network-buyer.js'

export interface RecordedBuyerRequest {
  method: string
  url: string
  headers: http.IncomingHttpHeaders
  body: unknown
}

export type FakeBuyerRoute = (request: RecordedBuyerRequest) => { status?: number; body: unknown } | undefined

export interface FakeBuyer {
  port: number
  requests: RecordedBuyerRequest[]
  client: BuyerClient
  close(): Promise<void>
}

export const TEST_SECRET = 'test-control-secret'

/** A node:http server on an ephemeral port answering `/_antseed/*` from `routes` (keyed by "METHOD /path"). */
export async function startFakeBuyer(routes: Record<string, FakeBuyerRoute>): Promise<FakeBuyer> {
  const requests: RecordedBuyerRequest[] = []
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => chunks.push(chunk))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8')
      const recorded: RecordedBuyerRequest = { method: req.method ?? 'GET', url: req.url ?? '/', headers: req.headers, body: text ? JSON.parse(text) : undefined }
      requests.push(recorded)
      const path = recorded.url.split('?')[0]
      const reply = routes[`${recorded.method} ${path}`]?.(recorded) ?? { status: 404, body: { ok: false, error: 'not found' } }
      res.writeHead(reply.status ?? 200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(reply.body))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  const client: BuyerClient = (path, init = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      [GATEWAY_CONTROL_HEADER]: TEST_SECRET,
      ...(init.body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(init.policy ? { [ROUTING_POLICY_HEADER]: encodePolicyHeader(init.policy) } : {}),
    },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
  return {
    port,
    requests,
    client,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

export function fakeDeps(store: object, now: () => number = () => 1_700_000_000_000): ConsoleDeps {
  return {
    store: store as ConsoleDeps['store'],
    dataDir: '/nonexistent/antseed-test',
    configPath: '/nonexistent/antseed-test/config.json',
    buyerPort: 1,
    controlSecret: TEST_SECRET,
    publicUrl: null,
    version: 'test',
    now,
    log: () => {},
  }
}

export function memberPrincipal(memberId: string, roles: Record<string, 'admin' | 'member'>, orgRole: 'owner' | 'admin' | 'member' = 'member'): Principal {
  return { kind: 'member', memberId, orgRole, workspaceRoles: new Map(Object.entries(roles)), sessionId: `session-${memberId}` }
}

/** Spec semantics of `requireWorkspaceAccess`, for handler tests. */
export function fakeRequireWorkspaceAccess(_store: unknown, principal: Principal | null, workspaceId: string, minRole: 'member' | 'admin' = 'member'): void {
  if (!principal) throw new ConsoleError(401, 'unauthenticated', 'Sign in.')
  if (principal.kind === 'token' && principal.scope === 'admin') return
  if (principal.kind === 'member' && principal.orgRole !== 'member') return
  const role = principal.kind === 'member' ? principal.workspaceRoles.get(workspaceId) : undefined
  if (!role || (minRole === 'admin' && role !== 'admin')) throw new ConsoleError(403, 'forbidden', 'No access.')
}

export function fakeCanSeeWorkspace(_store: unknown, principal: Principal | null, workspaceId: string): boolean {
  try {
    fakeRequireWorkspaceAccess(_store, principal, workspaceId)
    return true
  } catch {
    return false
  }
}

export function fakeRequireOrgAdmin(principal: Principal | null): void {
  if (!principal) throw new ConsoleError(401, 'unauthenticated', 'Sign in.')
  if (principal.kind === 'token' && principal.scope === 'admin') return
  if (principal.kind === 'member' && principal.orgRole !== 'member') return
  throw new ConsoleError(403, 'forbidden', 'Organization admins only.')
}

/** Runs a registered route the way the console server would, minus auth. */
export async function call(router: ConsoleRouter, method: string, pathWithQuery: string, principal: Principal | null, body?: unknown): Promise<unknown> {
  const [path, query = ''] = pathWithQuery.split('?')
  const matched = router.match(method, path!)
  if (!matched) throw new Error(`no route for ${method} ${path}`)
  return matched.route.handler({
    method,
    path: path!,
    params: matched.params,
    query: new URLSearchParams(query),
    body,
    headers: {},
    principal,
    raw: {} as http.IncomingMessage,
    res: {} as http.ServerResponse,
  })
}

export async function rejectsWith(promise: Promise<unknown>, status: number, code?: string): Promise<void> {
  try {
    await promise
  } catch (err) {
    if (!(err instanceof ConsoleError)) throw err
    if (err.status !== status || (code !== undefined && err.code !== code)) {
      throw new Error(`expected ${status}${code ? ` ${code}` : ''}, got ${err.status} ${err.code}: ${err.message}`)
    }
    return
  }
  throw new Error(`expected ConsoleError ${status}, but it resolved`)
}

export function lastRequest(buyer: FakeBuyer, match: (url: string) => boolean): RecordedBuyerRequest | undefined {
  return [...buyer.requests].reverse().find((request) => match(request.url))
}
