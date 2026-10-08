/** Test support for the console auth tests: a fake gateway store, an HTTP harness and a software passkey. */
import assert from 'node:assert/strict'
import Database from 'better-sqlite3'
import type { HDNodeWallet } from 'ethers'
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto'
import * as http from 'node:http'
import type { AddressInfo } from 'node:net'
import { ConsoleError, ConsoleRouter, type ConsoleResponse, type Principal } from '../console-api/router.js'
import type { WorkspaceRole, WorkspaceSummary } from '../console-api/types.js'
import { createConsoleAuth, type ConsoleAuthService } from './index.js'
import type { AuthKey, AuthMember, AuthStore, ConsoleAuthOptions, NewAuthMember } from './types.js'

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

export class FakeStore implements AuthStore {
  readonly database: Database.Database = new Database(':memory:')
  readonly members = new Map<string, AuthMember>()
  readonly roles = new Map<string, Map<string, WorkspaceRole>>()
  readonly invites = new Map<string, { memberId: string; expiresAt: number; used: boolean }>()
  readonly keys = new Map<string, AuthKey & { secret: string }>()
  readonly workspaces: WorkspaceSummary[] = [
    { id: 'ws_default', name: 'Default', isDefault: true },
    { id: 'ws_research', name: 'Research', isDefault: false },
  ]
  readonly audits: Array<{ actor: { kind: string; id: string | null; label?: string | null }; action: string; details?: Record<string, unknown> }> = []
  private _seq = 0

  constructor(private readonly _now: () => number) {}

  recordAudit(input: { actor: { kind: string; id: string | null; label?: string | null }; action: string; details?: Record<string, unknown> }): void {
    this.audits.push({ actor: input.actor, action: input.action, ...(input.details ? { details: input.details } : {}) })
  }

  private _id(prefix: string): string {
    this._seq += 1
    return `${prefix}_${this._seq}`
  }

  addMember(input: Partial<AuthMember> & { label: string }, workspaces: Array<[string, WorkspaceRole]> = []): AuthMember {
    const member: AuthMember = {
      id: this._id('mem'), email: null, orgRole: 'member', status: 'active', createdAt: this._now(),
      limits: { daily: 5_000_000, monthly: null, total: null }, routingPolicy: null, maxKeys: null, ...input,
    }
    this.members.set(member.id, member)
    this.roles.set(member.id, new Map(workspaces))
    return member
  }

  invite(input: Partial<AuthMember> & { label: string }, workspaces: Array<[string, WorkspaceRole]> = []): { member: AuthMember; token: string } {
    const member = this.addMember({ ...input, status: 'invited' }, workspaces)
    const token = randomBytes(24).toString('base64url')
    this.invites.set(sha256(token), { memberId: member.id, expiresAt: this._now() + 72 * 3600_000, used: false })
    return { member, token }
  }

  addKey(input: Partial<AuthKey> = {}): AuthKey & { secret: string } {
    const secret = `antseed_${randomBytes(24).toString('base64url')}`
    const key = {
      id: this._id('key'), label: 'CI key', hint: `${secret.slice(0, 12)}…`, buyerIdentity: 'default', status: 'active' as const,
      limits: { daily: null, monthly: 10_000_000, total: null }, topupEnabled: false, expiresAt: null, createdAt: this._now(), lastUsedAt: null,
      workspaceId: 'ws_default', ownerMemberId: null, secret, ...input,
    }
    this.keys.set(key.id, key)
    return key
  }

  setStatus(id: string, status: AuthMember['status']): void {
    this.members.set(id, { ...this.members.get(id)!, status })
  }

  getMember(id: string): AuthMember | null {
    return this.members.get(id) ?? null
  }

  findMemberByEmail(email: string): AuthMember | null {
    return [...this.members.values()].find((member) => member.email?.toLowerCase() === email.toLowerCase()) ?? null
  }

  memberWorkspaceRoles(memberId: string): ReadonlyMap<string, WorkspaceRole> {
    return this.roles.get(memberId) ?? new Map()
  }

  isSetupComplete(): boolean {
    return [...this.members.values()].some((member) => member.orgRole === 'owner' && member.status === 'active')
  }

  createOwner(input: { label: string; email: string | null }): AuthMember {
    return this.addMember({ label: input.label, email: input.email, orgRole: 'owner' }, [['ws_default', 'admin']])
  }

  liveInviteHash(memberId: string, now: number): string | null {
    for (const [hash, invite] of this.invites) {
      if (invite.memberId === memberId && !invite.used && invite.expiresAt > now) return hash
    }
    return null
  }

  consumeInvite(tokenHash: string, now: number): AuthMember | null {
    const invite = this.invites.get(tokenHash)
    if (!invite || invite.used || invite.expiresAt <= now) return null
    invite.used = true
    this.setStatus(invite.memberId, 'active')
    return this.getMember(invite.memberId)
  }

  findKeyBySecret(secret: string): AuthKey | null {
    return [...this.keys.values()].find((key) => key.secret === secret) ?? null
  }

  getKey(id: string): AuthKey | null {
    return this.keys.get(id) ?? null
  }

  getWorkspace(id: string): WorkspaceSummary | null {
    return this.workspaces.find((workspace) => workspace.id === id) ?? null
  }

  listWorkspaces(): WorkspaceSummary[] {
    return this.workspaces
  }

  usageStats(): { requests: number; spentUsdc: number } {
    return { requests: 3, spentUsdc: 1_250_000 }
  }

  createMember(input: NewAuthMember): AuthMember {
    return this.addMember({ label: input.label, email: input.email, orgRole: input.orgRole, status: input.status }, input.workspaces.map((entry) => [entry.workspaceId, entry.role]))
  }
}

export interface Clock {
  now: number
}

export interface HarnessResponse {
  status: number
  headers: http.IncomingHttpHeaders
  body: any
}

/** A cookie jar per "browser". */
export class Browser {
  readonly cookies = new Map<string, string>()
  lastSetCookies: string[] = []

  constructor(readonly harness: Harness, readonly host: string, readonly extraHeaders: Record<string, string> = {}) {}

  async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<HarnessResponse> {
    const cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join('; ')
    const response = await this.harness.raw(method, path, body, {
      host: this.host,
      'x-antseed-console': '1',
      ...(cookie ? { cookie } : {}),
      ...this.extraHeaders,
      ...headers,
    })
    const setCookies = response.headers['set-cookie'] ?? []
    this.lastSetCookies = setCookies
    for (const line of setCookies) {
      const [pair, ...attributes] = line.split(';').map((part) => part.trim())
      const index = pair!.indexOf('=')
      const name = pair!.slice(0, index)
      const value = pair!.slice(index + 1)
      if (attributes.some((attribute) => attribute.toLowerCase() === 'max-age=0') || value === '') this.cookies.delete(name)
      else this.cookies.set(name, value)
    }
    return response
  }
}

/** The id of the console session a browser holds (the hash of its cookie). */
export function sessionId(browser: Browser): string {
  return sha256(browser.cookies.get('antseed_console')!)
}

/** Invites a member and enrolls `wallet` as their sign-in method; returns the signed-in browser. */
export async function enrollWallet(h: Harness, label: string, wallet: HDNodeWallet, orgRole: 'owner' | 'member' = 'member') {
  const { member, token } = h.store.invite({ label, orgRole }, [['ws_default', 'admin']])
  const browser = h.browser()
  const enrollment = (await browser.request('POST', '/auth/invite', { token })).body.enrollment
  const message = (await browser.request('POST', '/auth/wallet/nonce', { address: wallet.address })).body.message
  const verified = await browser.request('POST', '/auth/wallet/verify', { message, signature: await wallet.signMessage(message), enrollment })
  assert.equal(verified.status, 200, JSON.stringify(verified.body))
  return { member, browser }
}

/** Confirms the browser's session with a wallet signature; resolves to the verify answer. */
export async function reauthWallet(browser: Browser, wallet: HDNodeWallet): Promise<HarnessResponse> {
  const nonce = await browser.request('POST', '/auth/reauth/wallet/nonce', { address: wallet.address })
  assert.equal(nonce.status, 200, JSON.stringify(nonce.body))
  return browser.request('POST', '/auth/reauth/wallet/verify', { message: nonce.body.message, signature: await wallet.signMessage(nonce.body.message) })
}

export interface Harness {
  url: string
  port: number
  store: FakeStore
  auth: ConsoleAuthService
  clock: Clock
  logs: string[]
  raw(method: string, path: string, body: unknown, headers: Record<string, string>): Promise<HarnessResponse>
  browser(host?: string, extraHeaders?: Record<string, string>): Browser
  close(): Promise<void>
}

/** Mirrors the console API server: principal resolution, public/allow checks, JSON bodies, ConsoleResponse/ConsoleError. */
export async function startHarness(options: {
  publicUrl?: string | null
  env?: Record<string, string>
  authOptions?: Partial<ConsoleAuthOptions>
  clock?: Clock
  /** Run against another store (e.g. the real GatewayStore); `harness.store` is then that store, typed loosely. */
  makeStore?: (now: () => number) => AuthStore
} = {}): Promise<Harness> {
  const clock = options.clock ?? { now: Date.now() }
  const store = (options.makeStore?.(() => clock.now) ?? new FakeStore(() => clock.now)) as FakeStore
  const logs: string[] = []
  const auth = createConsoleAuth(
    { store, publicUrl: options.publicUrl ?? null, now: () => clock.now, log: (message) => logs.push(message) },
    { env: options.env ?? {}, ...options.authOptions },
  )
  const router = new ConsoleRouter()
  auth.registerRoutes(router)

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://internal')
      const path = url.pathname.replace(/^\/console\/api/, '')
      const match = router.match(req.method ?? 'GET', path)
      if (!match) throw new ConsoleError(404, 'not_found', 'not found')
      const chunks: Buffer[] = []
      for await (const chunk of req) chunks.push(chunk as Buffer)
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined
      const principal: Principal | null = await auth.authenticate(req)
      if (!match.route.options.public) {
        if (!principal) throw new ConsoleError(401, 'unauthenticated', 'Sign in.')
        const allow = match.route.options.allow ?? ['member', 'token']
        if (!allow.includes(principal.kind)) throw new ConsoleError(403, 'forbidden', 'Not allowed.')
      }
      const result = await match.route.handler({ method: req.method!, path, params: match.params, query: url.searchParams, body, headers: req.headers, principal, raw: req, res })
      if (result === undefined) return
      const response = result as ConsoleResponse
      if (response && response.__consoleResponse) {
        res.writeHead(response.status, { 'content-type': 'application/json', ...response.headers })
        res.end(response.body === undefined ? undefined : JSON.stringify(response.body))
        return
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(result))
    } catch (error) {
      if (error instanceof ConsoleError) {
        res.writeHead(error.status, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: error.code, message: error.message } }))
      } else {
        res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: { code: 'internal', message: String(error) } }))
      }
    }
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port
  auth.setGatewayPort(port)

  const harness: Harness = {
    url: `http://127.0.0.1:${port}`,
    port,
    store,
    auth,
    clock,
    logs,
    raw(method, path, body, headers) {
      return new Promise((resolve, reject) => {
        const payload = body === undefined ? undefined : JSON.stringify(body)
        const req = http.request({
          host: '127.0.0.1', port, method, path: `/console/api${path}`,
          headers: { ...(payload ? { 'content-type': 'application/json' } : {}), ...headers },
        }, (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk) => chunks.push(chunk))
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            let parsed: unknown = text
            try { parsed = text ? JSON.parse(text) : undefined } catch { /* not json */ }
            resolve({ status: res.statusCode ?? 0, headers: res.headers, body: parsed })
          })
        })
        req.on('error', reject)
        req.end(payload)
      })
    },
    browser(host = `localhost:${port}`, extraHeaders = {}) {
      return new Browser(harness, host, extraHeaders)
    },
    close() {
      store.database.close()
      return new Promise((resolve) => server.close(() => resolve()))
    },
  }
  return harness
}

// ── Software passkey ("none" attestation, P-256) ────────────────────────────

function cborHead(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length])
  if (length < 256) return Buffer.from([(major << 5) | 24, length])
  const out = Buffer.alloc(3)
  out[0] = (major << 5) | 25
  out.writeUInt16BE(length, 1)
  return out
}

type CborValue = number | string | Buffer | Map<number | string, CborValue>

function cbor(value: CborValue): Buffer {
  if (typeof value === 'number') return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value)
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8')
    return Buffer.concat([cborHead(3, bytes.length), bytes])
  }
  if (Buffer.isBuffer(value)) return Buffer.concat([cborHead(2, value.length), value])
  const parts = [cborHead(5, value.size)]
  for (const [key, item] of value) parts.push(cbor(key), cbor(item))
  return Buffer.concat(parts)
}

export class SoftwarePasskey {
  readonly credentialId = randomBytes(16)
  private readonly _privateKey: KeyObject
  private readonly _publicJwk: { x: string; y: string }
  counter = 0
  userHandle: string | null = null

  constructor() {
    const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
    this._privateKey = privateKey
    const jwk = publicKey.export({ format: 'jwk' }) as { x: string; y: string }
    this._publicJwk = jwk
  }

  get id(): string {
    return this.credentialId.toString('base64url')
  }

  register(options: { challenge: string; rp: { id?: string }; user: { id: string } }, origin: string): unknown {
    this.userHandle = options.user.id
    const rpId = options.rp.id!
    const cose = cbor(new Map<number, CborValue>([
      [1, 2], [3, -7], [-1, 1],
      [-2, Buffer.from(this._publicJwk.x, 'base64url')],
      [-3, Buffer.from(this._publicJwk.y, 'base64url')],
    ]))
    const idLength = Buffer.alloc(2)
    idLength.writeUInt16BE(this.credentialId.length)
    const authData = Buffer.concat([
      createHash('sha256').update(rpId).digest(), Buffer.from([0x45]), Buffer.alloc(4), Buffer.alloc(16), idLength, this.credentialId, cose,
    ])
    const attestationObject = cbor(new Map<string, CborValue>([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]))
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin, crossOrigin: false }))
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: { clientDataJSON: clientDataJSON.toString('base64url'), attestationObject: attestationObject.toString('base64url'), transports: ['internal'] },
      clientExtensionResults: {},
      authenticatorAttachment: 'platform',
    }
  }

  login(options: { challenge: string; rpId?: string }, origin: string, overrides: { counter?: number } = {}): unknown {
    this.counter = overrides.counter ?? this.counter + 1
    const counter = Buffer.alloc(4)
    counter.writeUInt32BE(this.counter)
    const authData = Buffer.concat([createHash('sha256').update(options.rpId!).digest(), Buffer.from([0x05]), counter])
    const clientDataJSON = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin, crossOrigin: false }))
    const signature = sign('sha256', Buffer.concat([authData, createHash('sha256').update(clientDataJSON).digest()]), this._privateKey)
    return {
      id: this.id,
      rawId: this.id,
      type: 'public-key',
      response: {
        clientDataJSON: clientDataJSON.toString('base64url'),
        authenticatorData: authData.toString('base64url'),
        signature: signature.toString('base64url'),
        userHandle: this.userHandle,
      },
      clientExtensionResults: {},
    }
  }
}
