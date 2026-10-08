/**
 * In-memory fake console API for `VITE_MOCK=1 vite` so the UI can be clicked
 * through without a gateway. Never imported by a production build. It
 * enforces the same role checks as the real API (members PATCH and
 * operator-auth are org-admin / owner only, workspace admins manage their
 * workspace, plain members see only their own keys).
 *
 * Who you are: `?as=owner|admin|wsadmin|member|key|out` on any URL (remembered).
 * Authorized-wallet state: `?operator=none|self|yours|member|unknown` (remembered; see mock/operator.ts).
 * `wsadmin` administers the Default workspace only; `member` is a plain
 * member of Default and an admin of Research.
 */
import type {
  AdminToken, ApiKey, AuditEntry, GatewayExposure, GatewayExposureMode, Me, MeResponse, Member, RequestDetail, RequestLogEntry, RoutePreview, RoutingPolicy,
  UsageGroupBy, Workspace, WorkspaceRole,
} from '../api/types'
import { LIMIT_PERIODS } from '../lib/format'
import { MASKED_VALUE } from '../lib/headers'
import { tighterLimits } from '../lib/key-layers'
import { samePeerId } from '../lib/peer-id'
import { combinePolicies, expandLists } from '../lib/policy-match'
import { fakeAddress, seed } from './data'
import { mockOperatorState, OPERATOR_SCENARIOS, scenarioOperator, type OperatorScenario } from './operator'

type Handler = (ctx: { params: Record<string, string>; query: URLSearchParams; body: any }) => unknown

class MockError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) { super(message) }
}

const db = seed()
const SESSION_KEY = 'antseed-console-mock-session'
const roleMembers: Record<string, string> = { owner: 'mem_owner', admin: 'mem_ali', member: 'mem_sam', wsadmin: 'mem_wade' }
/** Sign-ins newer than this count as fresh for operator authorization. */
const FRESH_MS = 5 * 60_000
let lastSignInAt = 0
/** The wallet the last confirmation was signed with (operator-auth refuses confirming with the operator itself). */
let lastReauthWallet: string | null = null
const OPERATOR_MIN_AGE_MS = 24 * 3600_000
const OPERATOR_KEY = 'antseed-console-mock-operator'
/** Authorized wallet per workspace; `?operator=<scenario>` overrides it for every workspace. */
const operators: Record<string, string | null> = { ws_default: fakeAddress(9), ws_research: null }

function operatorScenario(): OperatorScenario | null {
  const fromUrl = new URLSearchParams(window.location.search).get('operator')
  if (fromUrl) { try { localStorage.setItem(OPERATOR_KEY, fromUrl) } catch { /* ignore */ } }
  let value: string | null = fromUrl
  try { value ??= localStorage.getItem(OPERATOR_KEY) } catch { /* ignore */ }
  return OPERATOR_SCENARIOS.includes(value as OperatorScenario) ? value as OperatorScenario : null
}

function currentOperator(workspace: Workspace, viewer: Member): string | null {
  const scenario = operatorScenario()
  return scenario ? scenarioOperator(scenario, workspace, viewer, db.members) : operators[workspace.id] ?? null
}

function operatorState(workspaceId: string) {
  const { member, workspace } = requireWorkspace(workspaceId)
  return mockOperatorState({ operator: currentOperator(workspace, member), workspace, viewer: member, members: db.members, checkedAt: Date.now() })
}

function session(): string {
  const fromUrl = new URLSearchParams(window.location.search).get('as')
  if (fromUrl) { try { localStorage.setItem(SESSION_KEY, fromUrl) } catch { /* ignore */ } }
  try { return fromUrl ?? localStorage.getItem(SESSION_KEY) ?? 'owner' } catch { return 'owner' }
}
function setSession(value: string) {
  lastSignInAt = Date.now()
  try { localStorage.setItem(SESSION_KEY, value) } catch { /* ignore */ }
}

let idCounter = 1000
const newId = (prefix: string) => `${prefix}_${++idCounter}`
const secret = (prefix: string) => `${prefix}${Array.from({ length: 32 }, () => Math.floor(Math.random() * 16).toString(16)).join('')}`

const unauthorized = () => new MockError(401, 'unauthorized', 'Sign in to continue')
const forbidden = (message = 'You do not have access to this') => new MockError(403, 'forbidden', message)
const notFound = (what: string) => new MockError(404, 'not_found', `${what} not found`)

function findMember(id: string | undefined): Member {
  const member = db.members.find((entry) => entry.id === id)
  if (!member) throw notFound('Member')
  return member
}

/** The Sign-In with Ethereum message the gateway asks a wallet to sign. */
function siweMessage(address: string): { message: string } {
  return { message: `gateway.example.com wants you to sign in with your Ethereum account:\n${address}\n\nSign in to the Antseed console.\n\nURI: http://localhost\nVersion: 1\nChain ID: 1\nNonce: mock${Date.now()}\nIssued At: ${new Date().toISOString()}` }
}

// ── Principal and access checks (mirror console-api/access.ts) ─────────────

function keySession(): ApiKey | null {
  return session() === 'key' ? db.keys[2]! : null
}

function currentMember(): Member {
  const state = session()
  if (state === 'out') throw unauthorized()
  if (state === 'key') throw forbidden('API-key sessions are read-only')
  const member = db.members.find((entry) => entry.id === roleMembers[state])
  if (!member || member.status !== 'active') throw unauthorized()
  return member
}

/** Adding a sign-in method needs a sign-in within the last five minutes. */
function requireFreshForCredential(): Member {
  const member = currentMember()
  if (Date.now() - lastSignInAt > FRESH_MS) throw new MockError(403, 'reauth_required', 'Confirm it\'s you (passkey or wallet) before adding a sign-in method, then retry.')
  return member
}

const isOrgAdmin = (member: Member) => member.orgRole === 'owner' || member.orgRole === 'admin'

function requireOrgAdmin(): Member {
  const member = currentMember()
  if (!isOrgAdmin(member)) throw forbidden('Only organization admins can do this')
  return member
}

function requireOwner(): Member {
  const member = currentMember()
  if (member.orgRole !== 'owner') throw forbidden('Only the organization owner can do this')
  return member
}

function workspaceRole(member: Member, workspaceId: string): WorkspaceRole | null {
  if (isOrgAdmin(member)) return 'admin'
  return db.workspaceMembers[workspaceId]?.[member.id] ?? null
}

function findWorkspace(id: string): Workspace {
  const workspace = db.workspaces.find((entry) => entry.id === id)
  if (!workspace) throw notFound('Workspace')
  return workspace
}

function requireWorkspace(id: string, minRole: WorkspaceRole = 'member'): { member: Member; workspace: Workspace } {
  const member = currentMember()
  const workspace = findWorkspace(id)
  const role = workspaceRole(member, id)
  if (!role) throw forbidden('You are not a member of this workspace')
  if (minRole === 'admin' && role !== 'admin') throw forbidden('Only workspace admins can do this')
  return { member, workspace }
}

/** Keys whose usage the caller may read; null means all. */
function visibleKeyIds(): Set<string> | null {
  const key = keySession()
  if (key) return new Set([key.id])
  const member = currentMember()
  if (isOrgAdmin(member)) return null
  return new Set(db.keys.filter((entry) => {
    const role = db.workspaceMembers[entry.workspaceId]?.[member.id]
    return role === 'admin' || (role && entry.ownerMemberId === member.id)
  }).map((entry) => entry.id))
}

function keyAccess(id: string): { key: ApiKey; member: Member } {
  const member = currentMember()
  const key = db.keys.find((entry) => entry.id === id)
  if (!key) throw notFound('Key')
  const role = workspaceRole(member, key.workspaceId)
  if (role !== 'admin' && !(role && key.ownerMemberId === member.id)) throw forbidden('You can only manage your own keys')
  return { key, member }
}

function audit(action: string, target: AuditEntry['target'] = null, details: Record<string, unknown> = {}) {
  const member = db.members.find((entry) => entry.id === roleMembers[session()])
  db.audit.unshift({
    id: newId('aud'), at: Date.now(), actor: { kind: 'member', id: member?.id ?? null, label: member?.label ?? null },
    action, target, details, ip: '127.0.0.1',
  })
}

// ── Views ──────────────────────────────────────────────────────────────────

function withCounts(workspace: Workspace): Workspace {
  return {
    ...workspace,
    memberCount: Object.keys(db.workspaceMembers[workspace.id] ?? {}).length,
    keyCount: db.keys.filter((key) => key.workspaceId === workspace.id && key.status === 'active').length,
  }
}

function me(): MeResponse {
  const key = keySession()
  if (key) return { kind: 'key', me: { key } }
  const member = currentMember()
  const admin = isOrgAdmin(member)
  const workspaces: Me['workspaces'] = db.workspaces
    .filter((ws) => admin || db.workspaceMembers[ws.id]?.[member.id])
    .map((ws) => ({ workspace: { id: ws.id, name: ws.name, isDefault: ws.isDefault }, role: admin ? 'admin' : db.workspaceMembers[ws.id]![member.id]! }))
  return { kind: 'member', me: { member, workspaces } }
}

function filterRequests(query: URLSearchParams): RequestDetail[] {
  const from = Number(query.get('from') ?? 0)
  const to = Number(query.get('to') ?? Date.now())
  const visible = visibleKeyIds()
  const q = (query.get('q') ?? '').trim().toLowerCase()
  return db.requests.filter((request) =>
    (!visible || visible.has(request.keyId))
    && (!query.get('workspace') || request.workspaceId === query.get('workspace'))
    && (!query.get('key') || request.keyId === query.get('key'))
    && (!query.get('member') || request.memberId === query.get('member'))
    && (!query.get('model') || (request.model ?? '').includes(query.get('model')!))
    && (!query.get('status') || (query.get('status') === 'error' ? (request.status ?? 0) >= 400 : (request.status ?? 0) < 400))
    && (!q || [request.model, request.keyLabel, request.endUser, request.path, request.errorCode, request.errorMessage].some((field) => (field ?? '').toLowerCase().includes(q)))
    && request.startedAt >= from && request.startedAt <= to)
}

function listEntry({ requestBody: _request, responseBody: _response, ...entry }: RequestDetail): RequestLogEntry {
  return entry
}

/** Opaque cursors, like the real API: clients pass `nextBefore` back unchanged. */
const encodeCursor = (at: number, id: string) => btoa(`${at}:${id}`)
function decodeCursor(value: string | null): { at: number; id: string } | null {
  if (!value) return null
  try {
    const [at, id] = atob(value).split(':')
    return { at: Number(at), id: id ?? '' }
  } catch { throw new MockError(400, 'invalid_cursor', 'Invalid cursor') }
}

/** One page of newest-first rows before the `before` cursor, and the cursor of the next page. */
function cursorPage<T>(rows: T[], query: URLSearchParams, at: (row: T) => number, id: (row: T) => string): { rows: T[]; nextBefore: string | null } {
  const cursor = decodeCursor(query.get('before'))
  const limit = Number(query.get('limit') ?? 50)
  const page = rows.filter((row) => !cursor || at(row) < cursor.at || (at(row) === cursor.at && id(row) < cursor.id)).slice(0, limit)
  const last = page[page.length - 1]
  return { rows: page, nextBefore: page.length === limit && last ? encodeCursor(at(last), id(last)) : null }
}

function totals(rows: RequestLogEntry[]) {
  return {
    requests: rows.length,
    failedRequests: rows.filter((row) => (row.status ?? 0) >= 400).length,
    spent: rows.reduce((sum, row) => sum + Number(row.spent ?? 0), 0).toFixed(6),
    inputTokens: rows.reduce((sum, row) => sum + row.inputTokens, 0),
    cachedInputTokens: rows.reduce((sum, row) => sum + row.cachedInputTokens, 0),
    outputTokens: rows.reduce((sum, row) => sum + row.outputTokens, 0),
  }
}

function groupKey(row: RequestLogEntry, groupBy: UsageGroupBy): [string, string] {
  switch (groupBy) {
    case 'hour': { const hour = new Date(row.startedAt).toISOString().slice(0, 13); return [hour, hour] }
    case 'day': { const day = new Date(row.startedAt).toISOString().slice(0, 10); return [day, day] }
    case 'model': return [row.model ?? 'unknown', row.model ?? 'unknown']
    case 'key': return [row.keyId, row.keyLabel]
    case 'member': return [row.memberId ?? 'none', db.members.find((m) => m.id === row.memberId)?.label ?? 'None']
    case 'peer': return [row.sellerPeerId ?? 'none', db.peers.find((p) => p.peerId === row.sellerPeerId)?.displayName ?? row.sellerPeerId ?? 'No seller']
    case 'workspace': return [row.workspaceId, db.workspaces.find((w) => w.id === row.workspaceId)?.name ?? row.workspaceId]
    case 'user': return [row.endUser ?? 'none', row.endUser ?? 'Not sent']
  }
}

function usage(query: URLSearchParams) {
  const rows = filterRequests(query)
  const [first, second] = (query.get('groupBy') ?? 'day').split(',')
  const groupBy = first as UsageGroupBy
  const splitBy = (second || query.get('splitBy') || null) as UsageGroupBy | null
  const grouped = (list: RequestLogEntry[], by: UsageGroupBy) => {
    const groups = new Map<string, { label: string; rows: RequestLogEntry[] }>()
    for (const row of list) {
      const [group, label] = groupKey(row, by)
      const entry = groups.get(group) ?? { label, rows: [] }
      entry.rows.push(row)
      groups.set(group, entry)
    }
    return [...groups.entries()]
  }
  return {
    from: Number(query.get('from') ?? 0), to: Number(query.get('to') ?? Date.now()), totals: totals(rows),
    groups: grouped(rows, groupBy).map(([group, entry]) => ({
      group, label: entry.label, ...totals(entry.rows),
      ...(splitBy ? { splits: grouped(entry.rows, splitBy).map(([split, part]) => ({ group: split, label: part.label, ...totals(part.rows) })) } : {}),
    })),
  }
}

function preview(query: URLSearchParams): RoutePreview {
  const model = query.get('model') ?? ''
  const key = query.get('key') ? db.keys.find((entry) => entry.id === query.get('key')) ?? null : null
  const member = query.get('member') ? db.members.find((entry) => entry.id === query.get('member')) ?? null : null
  const preset = query.get('preset') ? db.presets.find((entry) => entry.slug === query.get('preset')) ?? null : null
  const workspace = findWorkspace(key?.workspaceId ?? query.get('workspace') ?? 'ws_default')
  const keyOwner = key ? db.members.find((entry) => entry.id === key.ownerMemberId) ?? null : null
  requireWorkspace(workspace.id)
  const sources: RoutePreview['sources'] = [
    { level: 'buyer', id: null, policy: null },
    { level: 'gateway', id: null, policy: db.gatewayPolicy },
    { level: 'workspace-org', id: workspace.id, policy: workspace.orgRoutingPolicy },
    { level: 'workspace', id: workspace.id, policy: workspace.routingPolicy },
    ...(member ?? keyOwner ? [{ level: 'member' as const, id: (member ?? keyOwner)!.id, policy: (member ?? keyOwner)!.routingPolicy }] : []),
    ...(key ? [{ level: 'key' as const, id: key.id, policy: key.routingPolicy }, { level: 'key-owner' as const, id: key.id, policy: key.ownerRoutingPolicy ?? null }] : []),
    ...(preset ? [{ level: 'preset' as const, id: preset.slug, policy: preset.routingPolicy }] : []),
  ]
  const policy = combinePolicies(...sources.map((source) => source.policy && expandLists(source.policy, db.peerLists)))
  const modelAllowed = !policy.allowedModels || policy.allowedModels.some((entry) => entry.toLowerCase() === model.toLowerCase())
  const allowed = policy.allowedPeerIds ? new Set(policy.allowedPeerIds) : null
  const candidates = db.peers.filter((peer) => peer.services.some((service) => service.service === model)).map((peer) => {
    const service = peer.services.find((entry) => entry.service === model)!
    const reasons: string[] = []
    if (policy.blockedPeerIds?.includes(peer.peerId)) reasons.push('blocked')
    if (allowed && !allowed.has(peer.peerId)) {
      const lacking = sources.filter((source) => source.policy?.allowedPeerIds && !expand(source.policy)!.allowedPeerIds!.includes(peer.peerId)).map((source) => source.level.replace('workspace-org', 'organization').replace('key-owner', 'key owner'))
      reasons.push(lacking.length ? `not in the ${lacking.join(' and ')} allow list` : 'not in the allow list')
    }
    if (policy.minTrustScore !== undefined && (peer.trustScore ?? 0) < policy.minTrustScore) reasons.push(`trust below ${policy.minTrustScore}`)
    if (policy.requireTee && !peer.tee) reasons.push('no TEE')
    if (policy.requireVerified && !peer.verified) reasons.push('not verified')
    if (policy.maxInputUsdPerMillion !== undefined && (service.inputUsdPerMillion ?? 0) > policy.maxInputUsdPerMillion) reasons.push('over input price cap')
    return { peerId: peer.peerId, displayName: peer.displayName, rank: null as number | null, eligible: reasons.length === 0, reasons, inputUsdPerMillion: service.inputUsdPerMillion, outputUsdPerMillion: service.outputUsdPerMillion, trustScore: peer.trustScore }
  })
  candidates.filter((c) => c.eligible).sort((a, b) => (a.inputUsdPerMillion ?? 0) - (b.inputUsdPerMillion ?? 0)).forEach((c, index) => { c.rank = index + 1; c.reasons.push(index === 0 ? 'lowest price' : 'balanced score') })
  return { model, policy, sources, modelAllowed, candidates }
}


// ── Policy input checks (mirror policy-resolver's policyInputProblem) ─────

const NO_LIMITS: ApiKey['limits'] = { daily: null, weekly: null, monthly: null, total: null }
const expand = (policy: RoutingPolicy | null | undefined) => (policy ? expandLists(policy, db.peerLists) : null)

/** What a sent policy loses under the levels above, and whether it leaves no seller. */
function checkPolicy(above: Array<RoutingPolicy | null | undefined>, sent: RoutingPolicy | null | undefined) {
  if (!sent) return { empty: false, narrowed: [] as string[], effective: combinePolicies(...above.map(expand)) }
  const parent = combinePolicies(...above.map(expand))
  const own = expand(sent)!
  const effective = combinePolicies(parent, own)
  const narrowed: string[] = []
  if (own.allowedPeerIds && parent.allowedPeerIds && own.allowedPeerIds.some((id) => !parent.allowedPeerIds!.some((other) => samePeerId(other, id)))) narrowed.push('allowedPeerIds')
  if (own.allowedPeerIds && parent.blockedPeerIds && own.allowedPeerIds.some((id) => parent.blockedPeerIds!.some((other) => samePeerId(other, id)))) narrowed.push('allowedPeerIds')
  if (own.allowedModels && parent.allowedModels && own.allowedModels.some((model) => !parent.allowedModels!.includes(model))) narrowed.push('allowedModels')
  for (const cap of ['maxInputUsdPerMillion', 'maxOutputUsdPerMillion', 'maxCachedInputUsdPerMillion', 'maxImageUsdPerImage'] as const) {
    if (own[cap] !== undefined && parent[cap] !== undefined && own[cap]! > parent[cap]!) narrowed.push(cap)
  }
  const empty = own.allowedPeerIds !== undefined && (effective.allowedPeerIds ?? []).length === 0
  return { empty, narrowed: [...new Set(narrowed)], effective }
}

/** 400 empty_allow_list / 409 narrowed unless the request confirmed it, like the gateway. */
function guardPolicies(body: any, checks: Array<{ field: string; above: Array<RoutingPolicy | null | undefined>; sent: RoutingPolicy | null | undefined }>, limits?: { fields: string[]; effective: unknown }) {
  const results = checks.map((check) => ({ field: check.field, ...checkPolicy(check.above, check.sent) }))
  const empty = results.filter((result) => result.empty)
  if (empty.length && !body?.confirmEmpty) {
    throw new MockError(400, 'empty_allow_list', `${empty.map((r) => r.field).join(', ')} would let no seller serve; send confirmEmpty: true to save it anyway`, { fields: empty.map((r) => r.field) })
  }
  const narrowed = results.filter((result) => result.narrowed.length)
  const fields = [...narrowed.flatMap((r) => r.narrowed.map((name) => `${r.field}.${name}`)), ...(limits?.fields ?? [])]
  if (fields.length && !body?.acceptNarrowed) {
    throw new MockError(409, 'narrowed', `The levels above allow less than this asks for (${fields.join(', ')}); send acceptNarrowed: true to save it anyway`, {
      fields,
      ...(narrowed.length ? { effectiveRoutingPolicy: narrowed[narrowed.length - 1]!.effective } : {}),
      ...(limits?.fields.length ? { effectiveLimits: limits.effective } : {}),
    })
  }
}

function keyLevelsAbove(key: Pick<ApiKey, 'workspaceId' | 'ownerMemberId'>): Array<RoutingPolicy | null> {
  const ws = findWorkspace(key.workspaceId)
  const owner = db.members.find((m) => m.id === key.ownerMemberId)
  return [db.gatewayPolicy, ws.orgRoutingPolicy, ws.routingPolicy, owner?.routingPolicy ?? null]
}

/** Owner limit periods asking for more than the admin layer allows. */
function narrowedLimits(admin: ApiKey['limits'], owner: ApiKey['limits'] | undefined): string[] {
  if (!owner) return []
  return LIMIT_PERIODS
    .filter((period) => admin[period] !== null && (owner[period] === null || Number(owner[period]) > Number(admin[period])))
    .map((period) => `ownerLimits.${period}`)
}

function patchMember(id: string, body: any): Member {
  const caller = requireOrgAdmin()
  const target = findMember(id)
  if ((target.orgRole === 'owner' || body.orgRole === 'owner') && caller.orgRole !== 'owner') {
    throw forbidden('Only an owner can change an owner or make someone owner')
  }
  if (target.orgRole === 'owner' && body.orgRole && body.orgRole !== 'owner' && db.members.filter((m) => m.orgRole === 'owner' && m.status === 'active').length <= 1) {
    throw new MockError(409, 'last_owner', 'The organization needs at least one owner')
  }
  if (body.routingPolicy !== undefined) guardPolicies(body, [{ field: 'routingPolicy', above: [db.gatewayPolicy], sent: body.routingPolicy }])
  const { label, email, orgRole, limits, routingPolicy, maxKeys } = body as Partial<Member>
  Object.assign(target, Object.fromEntries(Object.entries({ label, email, orgRole, limits, routingPolicy, maxKeys }).filter(([, value]) => value !== undefined)))
  audit('member.update', { kind: 'member', id: target.id, label: target.label })
  return target
}

function setMemberStatus(id: string, status: 'active' | 'disabled'): Member {
  const caller = requireOrgAdmin()
  const target = findMember(id)
  if (target.orgRole === 'owner' && caller.orgRole !== 'owner') throw forbidden('Only an owner can change an owner')
  if (status === 'disabled' && target.id === caller.id) throw new MockError(409, 'cannot_disable_self', 'You cannot disable yourself')
  if (status === 'active' && target.status === 'invited') throw new MockError(409, 'invite_pending', 'This member has not accepted their invite yet')
  target.status = status
  if (status === 'disabled') db.keys.filter((k) => k.ownerMemberId === target.id).forEach((k) => { k.status = 'revoked' })
  audit(status === 'disabled' ? 'member.disable' : 'member.enable', { kind: 'member', id: target.id, label: target.label })
  return target
}

function createInvite(body: any) {
  const caller = currentMember()
  const workspaces: Array<{ workspaceId: string; role: WorkspaceRole }> = body.workspaces ?? []
  if (!isOrgAdmin(caller)) {
    if (body.orgRole !== 'member') throw forbidden('Only organization admins can invite admins')
    if (workspaces.length === 0) throw forbidden('Invite them into a workspace you administer')
    if (workspaces.some((entry) => workspaceRole(caller, entry.workspaceId) !== 'admin')) throw forbidden('You can only invite into workspaces you administer')
  } else if (body.orgRole === 'owner' && caller.orgRole !== 'owner') {
    throw forbidden('Only an owner can invite an owner')
  }
  if (body.email && db.members.some((member) => member.email?.toLowerCase() === String(body.email).toLowerCase())) {
    throw new MockError(409, 'member_exists', 'A member with this email already exists')
  }
  const invite = { id: newId('inv'), label: body.label, email: body.email ?? null, orgRole: body.orgRole, expiresAt: Date.now() + (body.expiresInHours ?? 72) * 3600_000, createdAt: Date.now(), createdBy: caller.id }
  db.invites.push(invite)
  audit('invite.create', { kind: 'invite', id: invite.id, label: invite.label })
  const { createdBy: _createdBy, ...dto } = invite
  return { ...dto, url: `${window.location.origin}/console/invite#${secret('inv_')}` }
}

function createKey(body: any) {
  const { member } = requireWorkspace(body.workspaceId)
  const admin = workspaceRole(member, body.workspaceId) === 'admin'
  let owner = member.id
  if (body.ownerMemberId !== undefined && body.ownerMemberId !== member.id) {
    if (!admin) throw forbidden('Only workspace admins can create keys for others')
    owner = body.ownerMemberId
  }
  if (!admin && member.maxKeys !== null && db.keys.filter((k) => k.ownerMemberId === member.id && k.status === 'active').length >= member.maxKeys) {
    throw new MockError(409, 'max_keys_reached', `You can have at most ${member.maxKeys} active key(s)`)
  }
  if (body.topupEnabled && !admin) throw forbidden('Only workspace admins can enable top-ups')
  // A non-admin's limits and policy become the owner layer of their key.
  const adminLimits = admin ? body.limits ?? NO_LIMITS : NO_LIMITS
  const adminPolicy = admin ? body.routingPolicy ?? null : null
  const ownerLimits = (admin ? body.ownerLimits : body.ownerLimits ?? body.limits) ?? NO_LIMITS
  const ownerPolicy = (admin ? body.ownerRoutingPolicy : body.ownerRoutingPolicy ?? body.routingPolicy) ?? null
  const above = keyLevelsAbove({ workspaceId: body.workspaceId, ownerMemberId: owner })
  guardPolicies(body, [
    { field: 'routingPolicy', above, sent: adminPolicy },
    { field: 'ownerRoutingPolicy', above: [...above, adminPolicy], sent: ownerPolicy },
  ], { fields: narrowedLimits(adminLimits, ownerLimits), effective: tighterLimits(adminLimits, ownerLimits) })
  const s = secret('antseed_')
  const key: ApiKey = { id: newId('key'), label: body.label, hint: `antseed_…${s.slice(-4)}`, workspaceId: body.workspaceId, ownerMemberId: owner, buyerIdentity: findWorkspace(body.workspaceId).buyerIdentity, status: 'active', limits: adminLimits, routingPolicy: adminPolicy, ownerLimits, ownerRoutingPolicy: ownerPolicy, topupEnabled: !!body.topupEnabled, expiresAt: body.expiresAt, createdAt: Date.now(), lastUsedAt: null, usage: { requests: 0, spent: '0.000000', spentThisMonth: '0.000000' } }
  db.keys.push(key)
  audit('key.create', { kind: 'key', id: key.id, label: key.label })
  return { key, secret: s }
}

function patchKey(id: string, body: any): ApiKey {
  const { key, member } = keyAccess(id)
  const admin = workspaceRole(member, key.workspaceId) === 'admin'
  if (!admin) {
    if (body.limits !== undefined || body.routingPolicy !== undefined) throw forbidden('Only workspace admins can change a key\'s limits; set ownerLimits instead')
    if (body.topupEnabled !== undefined) throw forbidden('Only workspace admins can change top-ups')
    if (body.ownerMemberId !== undefined) throw forbidden('Only workspace admins can change a key\'s owner')
    if (body.expiresAt !== undefined && (body.expiresAt === null || (key.expiresAt !== null && body.expiresAt > key.expiresAt))) {
      throw forbidden('Only workspace admins can extend or remove an expiry')
    }
  }
  const nextLimits = body.limits ?? key.limits
  const nextPolicy = body.routingPolicy !== undefined ? body.routingPolicy : key.routingPolicy
  const nextOwnerLimits = body.ownerLimits ? { ...key.ownerLimits, ...body.ownerLimits } : key.ownerLimits
  const above = keyLevelsAbove(key)
  guardPolicies(body, [
    ...(body.routingPolicy !== undefined ? [{ field: 'routingPolicy', above, sent: body.routingPolicy }] : []),
    ...(body.ownerRoutingPolicy !== undefined ? [{ field: 'ownerRoutingPolicy', above: [...above, nextPolicy], sent: body.ownerRoutingPolicy }] : []),
  ], { fields: body.ownerLimits ? narrowedLimits(nextLimits, body.ownerLimits) : [], effective: tighterLimits(nextLimits, nextOwnerLimits) })
  for (const field of ['label', 'limits', 'routingPolicy', 'ownerLimits', 'ownerRoutingPolicy', 'topupEnabled', 'expiresAt', 'ownerMemberId'] as const) {
    if (body[field] !== undefined) (key as any)[field] = field === 'ownerLimits' ? nextOwnerLimits : body[field]
  }
  audit('key.update', { kind: 'key', id: key.id, label: key.label })
  return key
}

function createAdminToken(body: any) {
  const caller = requireOrgAdmin()
  const days = body.expiresInDays === undefined ? 90 : body.expiresInDays
  if (days === null && caller.orgRole !== 'owner') throw forbidden('Only owners can create tokens that never expire')
  if (days !== null && (typeof days !== 'number' || days < 1 || days > 365)) throw new MockError(400, 'invalid_request', 'expiresInDays must be between 1 and 365')
  const s = secret('antseed_admin_')
  const token: AdminToken = { id: newId('tok'), label: body.label, hint: `antseed_admin_…${s.slice(-4)}`, scope: body.scope, createdByMemberId: caller.id, expiresAt: days === null ? null : Date.now() + days * 86_400_000, createdAt: Date.now(), lastUsedAt: null }
  db.adminTokens.push(token)
  audit('token.create', { kind: 'admin_token', id: token.id, label: token.label })
  return { token, secret: s }
}

function operatorAuth(params: Record<string, string>, body: any) {
  const caller = requireOwner()
  const workspace = findWorkspace(params['id']!)
  const current = currentOperator(workspace, caller)
  if (current) throw new MockError(409, 'operator_already_set', `This wallet already has an authorized wallet (${current}). Only that wallet can transfer or clear the authorization.`)
  const operator = String(body?.operator ?? '').trim()
  if (!/^0x[0-9a-fA-F]{40}$/.test(operator)) throw new MockError(400, 'invalid_operator', 'operator must be a wallet address.')
  const credential = caller.credentials.find((entry) => entry.kind === 'wallet' && entry.label.toLowerCase() === operator.toLowerCase())
  if (!credential) {
    throw new MockError(403, 'operator_not_yours', 'The operator must be a wallet you sign in with. Add it under your sign-in methods first.')
  }
  const age = Date.now() - credential.createdAt
  if (age < OPERATOR_MIN_AGE_MS) {
    const hours = Math.max(1, Math.ceil((OPERATOR_MIN_AGE_MS - age) / 3_600_000))
    throw new MockError(403, 'operator_too_new', `This wallet was added as a sign-in method less than 24 hours ago. For your safety it can become an operator only after that; try again in about ${hours} hour${hours === 1 ? '' : 's'}.`)
  }
  if (Date.now() - lastSignInAt > FRESH_MS) throw new MockError(403, 'reauth_required', 'Sign in again (passkey or wallet) to confirm, then retry.')
  if (caller.credentials.length > 1 && lastReauthWallet?.toLowerCase() === operator.toLowerCase()) {
    throw new MockError(403, 'reauth_other_credential', 'Confirm with a sign-in method other than the wallet you are making the operator (another passkey or wallet), then retry.')
  }
  audit('wallet.operator_auth', { kind: 'workspace', id: workspace.id, label: workspace.name }, { operator })
  return { buyer: workspace.walletAddress, operator, nonce: '0', signature: `0x${'ab'.repeat(65)}`, depositsContract: db.chain.contracts['deposits'], chainId: db.chain.chainId }
}

/** A workspace preset needs that workspace's admin; a gateway-wide one an org admin. */
function requirePresetAdmin(workspaceId: string | null | undefined) {
  if (workspaceId) requireWorkspace(workspaceId, 'admin')
  else requireOrgAdmin()
}

function editablePreset(id: string | undefined) {
  const preset = db.presets.find((entry) => entry.id === id)
  if (!preset) throw notFound('Preset')
  requirePresetAdmin(preset.workspaceId)
  return preset
}

/** The body without the confirmEmpty / acceptNarrowed flags, which are not stored. */
function withoutSaveFlags(body: any) {
  const { confirmEmpty: _confirmEmpty, acceptNarrowed: _acceptNarrowed, ...input } = body
  return input
}

function maskedSettings() {
  const headers = Object.fromEntries(Object.keys(db.settings.observability.otlpHeaders).map((name) => [name, MASKED_VALUE]))
  return { ...db.settings, observability: { ...db.settings.observability, otlpHeaders: headers } }
}

/** Saved header values are kept for "••••" only while the endpoint keeps its origin. */
function observability(body: any) {
  const current = db.settings.observability
  const origin = (url: string | null) => { try { return url ? new URL(url).origin : null } catch { return url } }
  const sameOrigin = origin(current.otlpEndpoint) === origin(body.otlpEndpoint) || current.otlpEndpoint === null
  const headers: Record<string, string> = {}
  for (const [name, value] of Object.entries(body.otlpHeaders ?? {}) as Array<[string, string]>) {
    if (value === MASKED_VALUE) {
      if (!sameOrigin) throw new MockError(400, 'otlp_headers_required', `The export endpoint changed: enter the value of header "${name}" again (saved header values are not sent to a new endpoint)`)
      if (current.otlpHeaders[name] === undefined) throw new MockError(400, 'invalid_request', `Header "${name}" needs a value`)
      headers[name] = current.otlpHeaders[name]!
    } else headers[name] = value
  }
  return { ...body, otlpHeaders: headers }
}

const routes: Array<[string, string, Handler]> = [
  ['GET', '/auth/config', () => db.authConfig],
  ['GET', '/auth/me', () => me()],
  ['POST', '/auth/logout', () => { setSession('out') }],
  ['POST', '/auth/setup', ({ body }) => { if (body.token === 'bad') throw new MockError(400, 'invalid_token', 'Invalid token'); return { enrollment: 'enr_1', label: 'Dana Owner', orgRole: 'owner' } }],
  ['POST', '/auth/recover', ({ body }) => { if (body.token === 'bad') throw new MockError(400, 'invalid_token', 'This recovery link is invalid, used or expired.'); return { enrollment: 'enr_3', label: 'Dana Owner', orgRole: 'owner' } }],
  ['POST', '/auth/invite', ({ body }) => { if (body.token === 'expired') throw new MockError(410, 'invite_expired', 'Expired'); return { enrollment: 'enr_2', label: 'Robin Contractor', orgRole: 'member' } }],
  ['POST', '/auth/passkey/register/options', ({ body }) => {
    if (!body?.enrollment) requireFreshForCredential()
    throw new MockError(501, 'mock', 'Passkeys need a real gateway. Add a wallet instead in mock mode.')
  }],
  ['POST', '/auth/passkey/login/options', () => { throw new MockError(501, 'mock', 'Passkeys need a real gateway. Use ?as=owner to skip sign-in in mock mode.') }],
  ['POST', '/auth/wallet/nonce', ({ body }) => siweMessage(body.address)],
  ['POST', '/auth/wallet/verify', ({ body }) => {
    const state = session()
    if (state === 'out' || state === 'key' || body?.enrollment) { setSession(state === 'out' || state === 'key' ? 'owner' : state); return me() }
    // Signed in already: this links the wallet to the member, after a fresh sign-in.
    const member = requireFreshForCredential()
    const address = /0x[0-9a-fA-F]{40}/.exec(String(body?.message ?? ''))?.[0] ?? fakeAddress(idCounter)
    if (db.members.some((m) => m.credentials.some((c) => c.label.toLowerCase() === address.toLowerCase()))) throw new MockError(409, 'credential_exists', 'This wallet is already linked to a member.')
    member.credentials.push({ id: newId('cred'), kind: 'wallet', label: address, createdAt: Date.now(), lastUsedAt: null })
    audit('auth.credential_add', { kind: 'member', id: member.id, label: member.label })
    return me()
  }],
  ['POST', '/auth/reauth/passkey/options', () => { throw new MockError(501, 'mock', 'Passkeys need a real gateway. Confirm with a wallet in mock mode.') }],
  ['POST', '/auth/reauth/wallet/nonce', ({ body }) => siweMessage(body.address)],
  ['POST', '/auth/reauth/wallet/verify', ({ body }) => {
    const member = currentMember()
    const address = /0x[0-9a-fA-F]{40}/.exec(String(body?.message ?? ''))?.[0] ?? ''
    if (!member.credentials.some((c) => c.kind === 'wallet' && c.label.toLowerCase() === address.toLowerCase())) {
      throw new MockError(403, 'reauth_wrong_member', 'That wallet is not one of your sign-in methods.')
    }
    lastSignInAt = Date.now()
    lastReauthWallet = address
    return me()
  }],
  ['POST', '/auth/api-key', ({ body }) => { if (!String(body.key).startsWith('antseed_') || String(body.key).startsWith('antseed_admin_')) throw new MockError(401, 'invalid_key', 'Invalid key'); setSession('key'); return me() }],

  ['GET', '/members', () => { requireOrgAdmin(); return db.members }],
  ['PATCH', '/members/:id', ({ params, body }) => patchMember(params['id']!, body)],
  ['POST', '/members/:id/disable', ({ params }) => setMemberStatus(params['id']!, 'disabled')],
  ['POST', '/members/:id/enable', ({ params }) => setMemberStatus(params['id']!, 'active')],
  ['DELETE', '/members/:id/credentials/:cred', ({ params }) => {
    const caller = currentMember()
    const m = findMember(params['id'])
    if (caller.id === m.id) {
      if (!m.credentials.some((c) => c.id === params['cred'])) throw notFound('Sign-in method')
      if (m.credentials.length <= 1) throw new MockError(409, 'last_credential', 'Add another sign-in method before removing this one')
    } else {
      requireOrgAdmin()
      if (m.orgRole === 'owner' && caller.orgRole !== 'owner') throw forbidden('Only an owner can change an owner\'s sign-in methods')
    }
    m.credentials = m.credentials.filter((c) => c.id !== params['cred'])
  }],
  ['GET', '/invites', () => {
    const caller = currentMember()
    return db.invites.filter((invite) => isOrgAdmin(caller) || (invite as { createdBy?: string }).createdBy === caller.id)
      .map(({ createdBy: _createdBy, ...invite }: typeof db.invites[number] & { createdBy?: string }) => invite)
  }],
  ['POST', '/invites', ({ body }) => createInvite(body)],
  ['DELETE', '/invites/:id', ({ params }) => {
    const caller = currentMember()
    const invite = db.invites.find((x) => x.id === params['id']) as (typeof db.invites[number] & { createdBy?: string }) | undefined
    if (!invite) throw notFound('Invite')
    if (!isOrgAdmin(caller) && invite.createdBy !== caller.id) throw forbidden()
    db.invites = db.invites.filter((x) => x.id !== params['id'])
  }],

  ['GET', '/workspaces', () => { const member = currentMember(); return db.workspaces.filter((ws) => workspaceRole(member, ws.id)).map(withCounts) }],
  ['POST', '/workspaces', ({ body }) => {
    const member = requireOrgAdmin()
    const ws: Workspace = { id: newId('ws'), name: body.name, isDefault: false, buyerIdentity: body.buyerIdentity ?? body.name.toLowerCase(), walletAddress: fakeAddress(idCounter), limits: body.limits, routingPolicy: body.routingPolicy, orgRoutingPolicy: null, memberCount: 0, keyCount: 0, createdAt: Date.now() }
    db.workspaces.push(ws)
    db.workspaceMembers[ws.id] = { [member.id]: 'admin' }
    audit('workspace.create', { kind: 'workspace', id: ws.id, label: ws.name })
    return withCounts(ws)
  }],
  ['GET', '/workspaces/:id', ({ params }) => withCounts(requireWorkspace(params['id']!).workspace)],
  ['PATCH', '/workspaces/:id', ({ params, body }) => {
    const { member, workspace } = requireWorkspace(params['id']!, 'admin')
    if (body.buyerIdentity !== undefined) throw new MockError(400, 'invalid_request', 'A workspace\'s wallet cannot be changed')
    if ((body.limits !== undefined || body.orgRoutingPolicy !== undefined) && !isOrgAdmin(member)) throw forbidden('Only organization admins can do this')
    const org = body.orgRoutingPolicy !== undefined ? body.orgRoutingPolicy : workspace.orgRoutingPolicy
    guardPolicies(body, [
      ...(body.orgRoutingPolicy !== undefined ? [{ field: 'orgRoutingPolicy', above: [db.gatewayPolicy], sent: body.orgRoutingPolicy }] : []),
      ...(body.routingPolicy !== undefined ? [{ field: 'routingPolicy', above: [db.gatewayPolicy, org], sent: body.routingPolicy }] : []),
    ])
    for (const field of ['name', 'limits', 'routingPolicy', 'orgRoutingPolicy'] as const) if (body[field] !== undefined) (workspace as any)[field] = body[field]
    audit(body.routingPolicy !== undefined || body.orgRoutingPolicy !== undefined ? 'workspace.policy.update' : 'workspace.update', { kind: 'workspace', id: workspace.id, label: workspace.name })
    return withCounts(workspace)
  }],
  ['DELETE', '/workspaces/:id', ({ params }) => {
    requireOrgAdmin()
    const ws = findWorkspace(params['id']!)
    if (ws.isDefault) throw new MockError(409, 'default_workspace', 'The Default workspace cannot be deleted')
    if (db.keys.some((k) => k.workspaceId === ws.id && k.status === 'active')) throw new MockError(409, 'workspace_has_keys', 'Revoke this workspace\'s keys first')
    db.workspaces = db.workspaces.filter((x) => x.id !== ws.id)
  }],
  ['GET', '/workspaces/:id/members', ({ params }) => {
    const { member } = requireWorkspace(params['id']!)
    const admin = workspaceRole(member, params['id']!) === 'admin'
    return Object.entries(db.workspaceMembers[params['id']!] ?? {}).map(([memberId, role]) => {
      const entry = db.members.find((m) => m.id === memberId)!
      return { member: admin ? entry : { ...entry, credentials: [] }, role }
    })
  }],
  ['PUT', '/workspaces/:id/members/:memberId', ({ params, body }) => { requireWorkspace(params['id']!, 'admin'); (db.workspaceMembers[params['id']!] ??= {})[params['memberId']!] = body.role }],
  ['DELETE', '/workspaces/:id/members/:memberId', ({ params }) => {
    requireWorkspace(params['id']!, 'admin')
    delete db.workspaceMembers[params['id']!]?.[params['memberId']!]
    db.keys.filter((k) => k.workspaceId === params['id'] && k.ownerMemberId === params['memberId']).forEach((k) => { k.status = 'revoked' })
  }],

  ['GET', '/keys', ({ query }) => {
    const visible = visibleKeyIds()
    return db.keys.filter((k) => (!visible || visible.has(k.id)) && (!query.get('workspace') || k.workspaceId === query.get('workspace')) && (!query.get('member') || k.ownerMemberId === query.get('member')))
  }],
  ['POST', '/keys', ({ body }) => createKey(body)],
  ['PATCH', '/keys/:id', ({ params, body }) => patchKey(params['id']!, body)],
  ['POST', '/keys/:id/rotate', ({ params }) => { const { key } = keyAccess(params['id']!); const s = secret('antseed_'); key.hint = `antseed_…${s.slice(-4)}`; audit('key.rotate', { kind: 'key', id: key.id, label: key.label }); return { key, secret: s } }],
  ['POST', '/keys/:id/revoke', ({ params }) => { const { key } = keyAccess(params['id']!); key.status = 'revoked'; audit('key.revoke', { kind: 'key', id: key.id, label: key.label }); return key }],

  ['GET', '/admin-tokens', () => { requireOrgAdmin(); return db.adminTokens }],
  ['POST', '/admin-tokens', ({ body }) => createAdminToken(body)],
  ['DELETE', '/admin-tokens/:id', ({ params }) => { requireOrgAdmin(); db.adminTokens = db.adminTokens.filter((x) => x.id !== params['id']) }],

  ['GET', '/usage', ({ query }) => usage(query)],
  ['GET', '/requests', ({ query }) => {
    const page = cursorPage(filterRequests(query), query, (row) => row.startedAt, (row) => row.tag)
    return { requests: page.rows.map(listEntry), nextBefore: page.nextBefore }
  }],
  ['GET', '/requests/:tag', ({ params }) => {
    const visible = visibleKeyIds()
    const row = db.requests.find((entry) => entry.tag === params['tag'])
    if (!row || (visible && !visible.has(row.keyId))) throw notFound('Request')
    return row
  }],
  ['GET', '/audit', ({ query }) => {
    requireOrgAdmin()
    const actor = query.get('actor') ?? ''
    const action = query.get('action') ?? ''
    const matching = db.audit.filter((entry) => (!actor || entry.actor.id === actor)
      && (!action || entry.action === action || entry.action.startsWith(`${action}.`)))
    const page = cursorPage(matching, query, (entry) => entry.at, (entry) => entry.id)
    return { entries: page.rows, nextBefore: page.nextBefore }
  }],

  ['GET', '/workspaces/:id/wallet', ({ params }) => {
    const { workspace: ws } = requireWorkspace(params['id']!, 'admin')
    return { buyerIdentity: ws.buyerIdentity, address: ws.walletAddress, available: ws.isDefault ? '231.540000' : '0.120000', reserved: ws.isDefault ? '15.000000' : '0.000000', walletUsdc: '0.000000', creditLimit: '5000.000000', operator: currentOperator(ws, currentMember()), deposit: { mode: 'background', status: 'idle', lastTxHash: null } }
  }],
  ['POST', '/workspaces/:id/wallet/card-link', ({ params }) => { requireWorkspace(params['id']!, 'admin'); return { url: 'https://example.com/mock-card-checkout' } }],
  ['POST', '/workspaces/:id/wallet/watch', ({ params, body }) => { requireWorkspace(params['id']!, 'admin'); return { mode: body.mode, status: body.mode === 'active' ? 'watching' : 'idle', lastTxHash: null } }],
  ['POST', '/workspaces/:id/wallet/operator-auth', ({ params, body }) => operatorAuth(params, body)],
  ['GET', '/workspaces/:id/wallet/operator', ({ params }) => operatorState(params['id']!)],
  ['POST', '/workspaces/:id/wallet/operator/sync', ({ params }) => operatorState(params['id']!)],
  ['GET', '/workspaces/:id/channels', ({ params }) => { requireWorkspace(params['id']!, 'admin'); return db.channels[params['id']!] ?? [] }],
  ['POST', '/workspaces/:id/channels/close', ({ params, body }) => { requireOrgAdmin(); const list = db.channels[params['id']!] ?? []; const ch = list.find((c) => c.peerId === body.peerId); if (ch) { ch.status = 'closing'; ch.canCooperativeClose = false } return { ok: true } }],
  ['GET', '/workspaces/:id/rewards', ({ params }) => { const { workspace, member } = requireWorkspace(params['id']!, 'admin'); return { address: workspace.walletAddress, pendingAnts: '41.25', claimedAnts: '120.5', epochs: [{ epoch: 12, pendingAnts: '0', claimed: true }, { epoch: 13, pendingAnts: '21.25', claimed: false }, { epoch: 14, pendingAnts: '20', claimed: false }], operator: currentOperator(workspace, member) } }],
  ['GET', '/chain', () => db.chain],

  ['GET', '/peers', () => db.peers],
  ['GET', '/route-preview', ({ query }) => preview(query)],
  ['GET', '/routing', () => { currentMember(); return db.gatewayPolicy }],
  ['PUT', '/routing', ({ body, query }) => {
    requireOrgAdmin()
    guardPolicies({ confirmEmpty: query.get('confirmEmpty') === '1' }, [{ field: 'routing policy', above: [], sent: body }])
    db.gatewayPolicy = body as RoutingPolicy
    audit('routing.default.update')
    return body
  }],
  ['GET', '/peer-lists', () => db.peerLists],
  ['POST', '/peer-lists', ({ body }) => { requireOrgAdmin(); const list = { id: newId('pl'), createdAt: Date.now(), ...body }; db.peerLists.push(list); return list }],
  ['PATCH', '/peer-lists/:id', ({ params, body }) => { requireOrgAdmin(); return Object.assign(db.peerLists.find((x) => x.id === params['id'])!, body) }],
  ['DELETE', '/peer-lists/:id', ({ params }) => { requireOrgAdmin(); db.peerLists = db.peerLists.filter((x) => x.id !== params['id']) }],

  ['GET', '/presets', ({ query }) => db.presets.filter((p) => !query.get('workspace') || p.workspaceId === null || p.workspaceId === query.get('workspace'))],
  ['POST', '/presets', ({ body }) => {
    requirePresetAdmin(body.workspaceId)
    const preset = { id: newId('pre'), createdAt: Date.now(), ...withoutSaveFlags(body) }
    db.presets.push(preset)
    return preset
  }],
  ['PATCH', '/presets/:id', ({ params, body }) => Object.assign(editablePreset(params['id']), withoutSaveFlags(body))],
  ['DELETE', '/presets/:id', ({ params }) => { editablePreset(params['id']); db.presets = db.presets.filter((x) => x.id !== params['id']) }],

  ['GET', '/status', () => ({ version: '0.1.0-mock', publicUrl: mockExposure === 'public' ? db.settings.publicUrl : null, buyer: { reachable: true, peers: db.peers.length, dhtNodes: 42, uptimeMs: 26 * 3600_000 }, spendFeed: 'local', x402: true, exposure: exposureFor(mockExposure) })],
  ['GET', '/settings', () => { requireOrgAdmin(); return maskedSettings() }],
  ['PATCH', '/settings/buyer', ({ body }) => {
    requireOrgAdmin()
    Object.assign(db.settings.buyer.maxPricing, body.maxPricing ?? {})
    if (body.minPeerReputation !== undefined) db.settings.buyer.minPeerReputation = body.minPeerReputation
    audit('settings.buyer.update')
    // The mock cannot restart anything, like a buyer started by hand without a supervisor.
    return { ...db.settings, restartRequired: true }
  }],
  ['PUT', '/settings/observability', ({ body }) => { requireOrgAdmin(); db.settings.observability = observability(body); return maskedSettings() }],
]

/** `?exposure=local|lan|public` on the first load picks what `/status` reports (default public). */
let mockExposure: GatewayExposureMode = 'public'
function exposureFor(mode: GatewayExposureMode): GatewayExposure {
  let admin = false
  try { admin = isOrgAdmin(currentMember()) } catch { admin = false }
  const exposure: GatewayExposure = mode === 'public'
    ? { mode, publicUrl: db.settings.publicUrl, listenHost: '127.0.0.1', reachableFromInternet: true, personalComputer: false, reasons: [`The console is served at ${db.settings.publicUrl}.`] }
    : mode === 'lan'
      ? { mode, publicUrl: null, listenHost: '0.0.0.0', reachableFromInternet: null, personalComputer: true, reasons: ['The gateway listens on every network interface: other machines on your network can reach it over plain HTTP.', 'No public URL is set (--public-url, a domain or a tunnel).', 'It runs on macOS: keys work only while this computer is on, awake and online.'] }
      : { mode, publicUrl: null, listenHost: '127.0.0.1', reachableFromInternet: false, personalComputer: true, reasons: ['The gateway listens on 127.0.0.1, so only this computer can reach it.', 'It runs on macOS: keys work only while this computer is on, awake and online.'] }
  return admin ? exposure : { ...exposure, listenHost: null, reasons: [] }
}

function match(method: string, path: string): { handler: Handler; params: Record<string, string> } | null {
  const segments = path.split('/').filter(Boolean)
  for (const [routeMethod, pattern, handler] of routes) {
    if (routeMethod !== method) continue
    const parts = pattern.split('/').filter(Boolean)
    if (parts.length !== segments.length) continue
    const params: Record<string, string> = {}
    if (parts.every((part, index) => (part.startsWith(':') ? ((params[part.slice(1)] = decodeURIComponent(segments[index]!)), true) : part === segments[index]))) return { handler, params }
  }
  return null
}

function json(status: number, body: unknown): Response {
  if (status === 204) return new Response(null, { status })
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.href
  return input.url
}

export function installMockApi(): void {
  const realFetch = window.fetch.bind(window)
  const exposureParam = new URLSearchParams(window.location.search).get('exposure')
  if (exposureParam === 'local' || exposureParam === 'lan' || exposureParam === 'public') mockExposure = exposureParam
  session()
  lastSignInAt = Date.now() - FRESH_MS - 1
  window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(requestUrl(input), window.location.origin)
    if (!url.pathname.startsWith('/console/api/')) return realFetch(input, init)
    const method = (init?.method ?? 'GET').toUpperCase()
    const path = url.pathname.slice('/console/api'.length)
    await new Promise((resolve) => setTimeout(resolve, 150 + Math.random() * 200))
    if (method !== 'GET' && new Headers(init?.headers).get('x-antseed-console') !== '1') return json(403, { error: { code: 'csrf', message: 'Missing CSRF header.' } })
    if (method !== 'GET' && keySession() && !path.startsWith('/auth/')) return json(403, { error: { code: 'forbidden', message: 'API-key sessions are read-only' } })
    const route = match(method, path)
    if (!route) return json(404, { error: { code: 'not_found', message: `Mock has no ${method} ${path}` } })
    try {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      const result = route.handler({ params: route.params, query: url.searchParams, body })
      return result === undefined ? json(204, null) : json(200, result)
    } catch (error) {
      if (error instanceof MockError) return json(error.status, { error: { code: error.code, message: error.message, ...error.extra } })
      return json(500, { error: { code: 'mock_error', message: String(error) } })
    }
  }
  console.info('[antseed console] Mock API active. Switch identity with ?as=owner|admin|wsadmin|member|key|out, reachability with ?exposure=local|lan|public')
}
