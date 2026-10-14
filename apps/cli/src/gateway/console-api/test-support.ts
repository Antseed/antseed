import { mkdtempSync, rmSync } from 'node:fs'
import * as http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hashApiKey } from '../keys.js'
import { GatewayStore, type MemberRecord, type OrgRole, type WorkspaceRole } from '../store.js'
import type { ConsoleDeps } from './deps.js'
import type { ConsoleAuth, ConsoleRouter, Principal } from './router.js'
import { createConsoleApi, type ConsoleRegistrar } from './server.js'

/**
 * Test-only fake auth: `Authorization: Bearer <name>` or `Cookie: who=<name>`
 * selects a principal registered with `as(name, principal)`.
 */
export class FakeConsoleAuth implements ConsoleAuth {
  readonly principals = new Map<string, Principal>()
  readonly revokedMembers: string[] = []
  readonly revokedKeys: string[] = []

  as(name: string, principal: Principal): void {
    this.principals.set(name, principal)
  }

  async authenticate(req: http.IncomingMessage): Promise<Principal | null> {
    const bearer = req.headers.authorization?.startsWith('Bearer ') ? req.headers.authorization.slice(7) : null
    const cookie = /(?:^|;\s*)who=([^;]+)/.exec(req.headers.cookie ?? '')?.[1] ?? null
    const name = bearer ?? cookie
    return name ? this.principals.get(name) ?? null : null
  }

  registerRoutes(router: ConsoleRouter): void {
    router.add('GET', '/auth/config', async () => ({ ok: true }), { public: true })
  }

  revokeMemberSessions(memberId: string): void {
    this.revokedMembers.push(memberId)
  }

  revokeKeySessions(keyId: string): void {
    this.revokedKeys.push(keyId)
  }

  async me(): Promise<never> {
    throw new Error('not used in tests')
  }
}

export function memberPrincipal(store: GatewayStore, memberId: string): Principal {
  const member = store.getMember(memberId)!
  return { kind: 'member', memberId, orgRole: member.orgRole, workspaceRoles: store.memberWorkspaceRoles(memberId), sessionId: `s-${memberId}` }
}

/** A member who accepted an invite: active, with the invite's role and workspaces. */
export function addActiveMember(
  store: GatewayStore,
  label: string,
  options: { orgRole?: OrgRole; workspaces?: Array<{ workspaceId: string; role: WorkspaceRole }>; email?: string | null; createdBy?: string | null } = {},
): MemberRecord {
  const { token } = store.createInvite({
    label,
    email: options.email ?? null,
    orgRole: options.orgRole ?? 'member',
    workspaces: options.workspaces ?? [],
    expiresAt: Date.now() + 60_000,
    createdBy: options.createdBy ?? null,
  })
  return store.consumeInvite(hashApiKey(token), Date.now())!
}

export function tempDataDir(): { dir: string; store: GatewayStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-console-'))
  const store = new GatewayStore(dir)
  return { dir, store, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }) } }
}

export function testDeps(store: GatewayStore, dir: string, overrides: Partial<ConsoleDeps> = {}): ConsoleDeps {
  return {
    store,
    dataDir: dir,
    configPath: join(dir, 'config.json'),
    buyerPort: 1,
    controlSecret: 'test-secret',
    publicUrl: 'https://gateway.example.test',
    version: '0.0.0-test',
    now: () => Date.now(),
    log: () => {},
    ...overrides,
  }
}

/** A console API on an ephemeral port. */
export async function startConsole(
  deps: ConsoleDeps,
  auth: ConsoleAuth,
  registrars: ConsoleRegistrar[],
  options: { distDir?: string } = {},
): Promise<{ port: number; close: () => Promise<void> }> {
  const api = createConsoleApi(deps, auth, registrars, options)
  const server = http.createServer((req, res) => {
    api.handle(req, res).then((handled) => {
      if (!handled) res.writeHead(404).end()
    }).catch(() => res.writeHead(500).end())
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return {
    port: (server.address() as { port: number }).port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  }
}

export interface CallResult {
  status: number
  body: unknown
  text: string
  headers: http.IncomingHttpHeaders
}

/** `who` picks the fake principal; browser-style (cookie + CSRF header) unless `bearer`. */
export async function call(
  port: number,
  method: string,
  path: string,
  options: { who?: string; body?: unknown; bearer?: boolean; csrf?: boolean; headers?: http.OutgoingHttpHeaders } = {},
): Promise<CallResult> {
  const payload = options.body === undefined ? undefined : JSON.stringify(options.body)
  const headers: http.OutgoingHttpHeaders = { ...(payload ? { 'content-type': 'application/json' } : {}), ...options.headers }
  if (options.who) {
    if (options.bearer) headers.authorization = `Bearer ${options.who}`
    else headers.cookie = `who=${options.who}`
  }
  if (options.csrf !== false && !options.bearer) headers['x-antseed-console'] = '1'
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, method, path, headers }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let body: unknown = null
        try { body = text ? JSON.parse(text) : null } catch { body = null }
        resolve({ status: res.statusCode ?? 0, body, text, headers: res.headers })
      })
    })
    req.on('error', reject)
    req.end(payload)
  })
}
