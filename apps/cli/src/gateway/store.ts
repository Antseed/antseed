import { DEFAULT_BUYER_IDENTITY } from '@antseed/node'
import Database from 'better-sqlite3'
import { randomBytes } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { isRoutingPolicy, normalizePolicy, type RoutingPolicy } from '../routing-policy/policy.js'
import { ADMIN_TOKEN_PREFIX, apiKeyHint, generateApiKey, hashApiKey, newKeyId } from './keys.js'
import {
  BUDGET_PERIODS,
  LIMIT_PERIODS,
  NO_BUDGET_LIMITS,
  fullLimits,
  periodStart,
  type BudgetLimits,
  type BudgetPeriod,
  type BudgetSpend,
  type LimitPeriod,
  type SpendLimits,
} from './limits.js'
import { MIGRATIONS } from './store-migrations.js'

export type ApiKeySource = 'created' | 'tunnel-env'
export type ApiKeyStatus = 'active' | 'revoked'
export type OrgRole = 'owner' | 'admin' | 'member'
export type WorkspaceRole = 'admin' | 'member'
export type MemberStatus = 'active' | 'invited' | 'disabled'

export const DEFAULT_WORKSPACE_ID = 'ws_default'

export interface ApiKeyRecord {
  id: string
  label: string
  hint: string
  /** Buyer identity (wallet) that pays for this key's requests: its workspace's. */
  buyerIdentity: string
  workspaceId: string
  /** Member the key belongs to; null for keys created by the CLI or a management token. */
  ownerMemberId: string | null
  source: ApiKeySource
  status: ApiKeyStatus
  /** Set by workspace admins (the admin layer). */
  limits: BudgetLimits
  routingPolicy: RoutingPolicy | null
  /**
   * Set by the key's owner on top of the admin layer (the owner layer): they
   * may change these freely, but each only narrows the admin layer, so the
   * owner can never get more than the admins allow.
   */
  ownerLimits: BudgetLimits
  ownerRoutingPolicy: RoutingPolicy | null
  /** Whether the key holder may fund the key's wallet with x402 top-ups. */
  topupEnabled: boolean
  expiresAt: number | null
  createdAt: number
  revokedAt: number | null
  lastUsedAt: number | null
}

export interface WorkspaceRecord {
  id: string
  name: string
  buyerIdentity: string
  isDefault: boolean
  /** Cached address of the buyer identity's wallet; null until known. */
  walletAddress: string | null
  limits: BudgetLimits
  /** Set by workspace admins. */
  routingPolicy: RoutingPolicy | null
  /** Set by org admins; applied before `routingPolicy`. */
  orgRoutingPolicy: RoutingPolicy | null
  createdAt: number
}

export interface MemberRecord {
  id: string
  label: string
  email: string | null
  orgRole: OrgRole
  status: MemberStatus
  limits: BudgetLimits
  routingPolicy: RoutingPolicy | null
  maxKeys: number | null
  createdAt: number
}

export interface InviteRecord {
  id: string
  memberId: string
  label: string
  email: string | null
  orgRole: OrgRole
  workspaces: Array<{ workspaceId: string; role: WorkspaceRole }>
  createdBy: string | null
  expiresAt: number
  usedAt: number | null
  createdAt: number
}

export interface PeerListRecord {
  id: string
  name: string
  description: string | null
  peerIds: string[]
  createdAt: number
}

export interface PresetRecord {
  id: string
  slug: string
  name: string
  workspaceId: string | null
  model: string
  routingPolicy: RoutingPolicy | null
  systemPrompt: string | null
  params: Record<string, unknown>
  createdAt: number
}

export interface AdminTokenRecord {
  id: string
  label: string
  hint: string
  scope: 'admin' | 'read'
  createdBy: string | null
  /** Null never expires (owners only). */
  expiresAt: number | null
  createdAt: number
  lastUsedAt: number | null
  revokedAt: number | null
}

export type AuditActorKind = 'member' | 'token' | 'key' | 'system' | 'cli'

/** One audit-log row; same shape as the console's `AuditEntry`. */
export interface AuditRecord {
  id: string
  at: number
  actor: { kind: AuditActorKind; id: string | null; label: string | null }
  action: string
  target: { kind: string; id: string | null; label: string | null } | null
  details: Record<string, unknown>
  ip: string | null
}

/** Input of `GatewayStore.recordAudit`. Never put secrets in `details`. */
export interface AuditInput {
  actor: { kind: AuditActorKind; id: string | null; label?: string | null }
  /** Dotted verb, e.g. "key.create", "workspace.policy.update". */
  action: string
  target?: { kind: string; id: string | null; label?: string | null } | null
  details?: Record<string, unknown>
  ip?: string | null
}

/**
 * Balance movements per key, as signed deltas in USDC base units: spend is
 * negative, credit (a top-up or payment received for the key) is positive.
 * `externalRef` makes every write idempotent against its source event.
 */
export type LedgerEntryKind = 'spend' | 'credit'

export interface LedgerEntryInput {
  kind: LedgerEntryKind
  keyId: string
  buyerIdentity: string
  amountUsdc: number
  externalRef: string
  requestTag?: string | null
  sellerPeerId?: string | null
  inputTokens?: number
  cachedInputTokens?: number
  outputTokens?: number
  note?: string | null
  createdAt: number
  /**
   * Who the spend counts against, fixed when it is recorded. Missing fields
   * come from the request (`requestTag`), else from the key as it is now.
   */
  workspaceId?: string | null
  memberId?: string | null
  model?: string | null
  endUser?: string | null
}

export interface GatewayRequestStart {
  tag: string
  keyId: string
  buyerIdentity: string
  method: string
  path: string
  model: string | null
  startedAt: number
  /** Default to the key's workspace and owner. */
  workspaceId?: string | null
  memberId?: string | null
  endUser?: string | null
}

export interface RequestOutcome {
  sellerPeerId?: string | null
  latencyMs?: number | null
  endUser?: string | null
}

export interface KeyUsageStats {
  requests: number
  failedRequests: number
  spentUsdc: number
  creditedUsdc: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
}

/** Narrows request-log and usage queries. `keyIds` is the caller's visibility scope (null = everything). */
export interface UsageFilter {
  keyIds?: readonly string[] | null
  workspaceId?: string | null
  keyId?: string | null
  memberId?: string | null
  model?: string | null
  from?: number | null
  to?: number | null
}

/** Request-log filters on top of `UsageFilter`. */
export interface RequestLogFilter extends UsageFilter {
  /** 'error' = finished with status >= 400; requests still in flight are neither. */
  status?: 'ok' | 'error' | number | null
  /** Substring (case-insensitive) of the model, key label, end user, tag, seller, path, or error code/message. */
  q?: string | null
  /** Rows strictly older than this position (newest first). */
  before?: RequestCursor | null
  limit?: number
}

/** Position in the request log, ordered by (startedAt, tag) descending. */
export interface RequestCursor {
  startedAt: number
  tag: string
}

/** Why a request failed, from the gateway's own error or the buyer's/seller's error body. */
export interface RequestError {
  code: string | null
  message: string | null
}

export type UsageGroupBy = 'hour' | 'day' | 'model' | 'key' | 'member' | 'peer' | 'workspace' | 'user'

/** A usage group, split further by a second grouping when one was asked for. */
export type UsageGroupRow = { group: string | null; splits?: Array<{ group: string | null } & UsageTotalsRow> } & UsageTotalsRow

/** Token counts a response reported about itself (`inputTokens` includes cached input). */
export interface ResponseTokenCounts {
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
}

export interface UsageTotalsRow {
  requests: number
  failedRequests: number
  spentUsdc: number
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
}

export interface RequestLogRow {
  tag: string
  startedAt: number
  finishedAt: number | null
  keyId: string
  keyLabel: string
  workspaceId: string
  memberId: string | null
  endUser: string | null
  method: string
  path: string
  model: string | null
  status: number | null
  sellerPeerId: string | null
  latencyMs: number | null
  spentUsdc: number | null
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  errorCode: string | null
  errorMessage: string | null
  /**
   * A model request that did not fail but has no spend recorded yet (the
   * buyer reports it a moment after the response, or never for a free seller).
   */
  costPending: boolean
}

/** One request with its bodies (null unless content logging was on for it). */
export interface RequestDetailRow extends RequestLogRow {
  requestBody: string | null
  responseBody: string | null
}

export type BudgetScope = { keyId: string } | { memberId: string } | { workspaceId: string }

type KeyRow = {
  id: string
  label: string
  key_hint: string
  buyer_identity: string
  workspace_id: string | null
  owner_member_id: string | null
  source: ApiKeySource
  status: ApiKeyStatus
  daily_limit_usdc: number | null
  weekly_limit_usdc: number | null
  monthly_limit_usdc: number | null
  total_limit_usdc: number | null
  routing_policy: string | null
  owner_routing_policy: string | null
  owner_daily_limit_usdc: number | null
  owner_weekly_limit_usdc: number | null
  owner_monthly_limit_usdc: number | null
  owner_total_limit_usdc: number | null
  topup_enabled: number
  expires_at: number | null
  created_at: number
  revoked_at: number | null
  last_used_at: number | null
}

type LimitColumns = {
  daily_limit_usdc: number | null
  weekly_limit_usdc: number | null
  monthly_limit_usdc: number | null
  total_limit_usdc: number | null
}

type WorkspaceRow = LimitColumns & {
  id: string
  name: string
  buyer_identity: string
  is_default: number
  routing_policy: string | null
  org_routing_policy: string | null
  wallet_address: string | null
  created_at: number
}

type MemberRow = LimitColumns & {
  id: string
  label: string
  email: string | null
  org_role: OrgRole
  status: MemberStatus
  routing_policy: string | null
  max_keys: number | null
  created_at: number
}

type InviteRow = {
  id: string
  member_id: string
  label: string
  email: string | null
  org_role: OrgRole
  workspace_roles: string
  created_by: string | null
  expires_at: number
  used_at: number | null
  created_at: number
}

/** Best effort: a file we do not own (or a filesystem without modes) keeps its mode. */
function restrictMode(path: string, mode: number): void {
  try {
    if (existsSync(path)) chmodSync(path, mode)
  } catch {
    // not ours to change
  }
}

export function gatewayDir(dataDir: string): string {
  return join(dataDir, 'gateway')
}

function newId(prefix: string): string {
  return `${prefix}_${randomBytes(6).toString('hex')}`
}

function parsePolicy(raw: string | null): RoutingPolicy | null {
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw) as unknown
    return isRoutingPolicy(parsed) ? normalizePolicy(parsed) : null
  } catch {
    return null
  }
}

function policyJson(policy: RoutingPolicy | null | undefined): string | null {
  return policy ? JSON.stringify(normalizePolicy(policy)) : null
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function rowLimits(row: LimitColumns): BudgetLimits {
  return {
    daily: row.daily_limit_usdc,
    weekly: row.weekly_limit_usdc,
    monthly: row.monthly_limit_usdc,
    total: row.total_limit_usdc,
  }
}

/**
 * Durable state for the API-key gateway and its console: keys, request log,
 * the per-key ledger, and the organization around them (workspaces, members,
 * invites, presets, peer lists, management tokens, settings). SQLite in WAL
 * mode so `antseed gateway key …` commands can change keys while a gateway
 * process is serving them.
 */
export class GatewayStore {
  private readonly _db: Database.Database
  private readonly _statements = new Map<string, Database.Statement>()
  private readonly _settings = new Map<string, { raw: string | null; at: number }>()
  private readonly _touched = new Map<string, number>()

  constructor(dataDir: string, private readonly _now: () => number = () => Date.now()) {
    const dir = gatewayDir(dataDir)
    mkdirSync(dir, { recursive: true, mode: 0o700 })
    // Key hashes, sessions and request bodies live here: owner-only.
    restrictMode(dir, 0o700)
    const file = join(dir, 'gateway.db')
    this._db = new Database(file, { timeout: 5000 })
    this._db.pragma('busy_timeout = 5000')
    this._enableWal()
    this._db.pragma('foreign_keys = ON')
    for (const path of [file, `${file}-wal`, `${file}-shm`]) restrictMode(path, 0o600)
    this._migrate()
    this._repairDraftSchema()
  }

  /**
   * Databases that ran an earlier draft of the unshipped v3 migration lack
   * the columns added to it since; add them. Drop once v3 ships.
   */
  private _repairDraftSchema(): void {
    const columns = new Set((this._db.prepare('PRAGMA table_info(gateway_requests)').all() as Array<{ name: string }>).map((column) => column.name))
    const missing = ['usage_input_tokens', 'usage_cached_input_tokens', 'usage_output_tokens'].filter((column) => !columns.has(column))
    if (missing.length === 0) return
    this._db.transaction(() => {
      // Re-read under the write lock: another process may have added them.
      const now = new Set((this._db.prepare('PRAGMA table_info(gateway_requests)').all() as Array<{ name: string }>).map((column) => column.name))
      for (const column of missing) if (!now.has(column)) this._db.exec(`ALTER TABLE gateway_requests ADD COLUMN ${column} INTEGER`)
    }).immediate()
  }

  /**
   * Switching a database to WAL needs it to itself, and SQLite answers
   * SQLITE_BUSY at once (no busy handler) while other processes have it
   * open, e.g. several opening an old database together: retry for a while.
   */
  private _enableWal(): void {
    const deadline = Date.now() + 5_000
    for (;;) {
      try {
        this._db.pragma('journal_mode = WAL')
        return
      } catch (error) {
        if ((error as { code?: string }).code !== 'SQLITE_BUSY' || Date.now() > deadline) throw error
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10 + Math.floor(Math.random() * 20))
      }
    }
  }

  /** The underlying database; the console's auth module keeps its own tables in it. */
  get database(): Database.Database {
    return this._db
  }

  close(): void {
    this._statements.clear()
    this._db.close()
  }

  private _count(sql: string, ...params: unknown[]): number {
    return (this._stmt(sql).get(...params) as { count: number }).count
  }

  /** A prepared statement, cached by its SQL (hot paths run the same few statements on every request). */
  private _stmt(sql: string): Database.Statement {
    let statement = this._statements.get(sql)
    if (!statement) {
      if (this._statements.size >= MAX_CACHED_STATEMENTS) this._statements.clear()
      statement = this._db.prepare(sql)
      this._statements.set(sql, statement)
    }
    return statement
  }

  /**
   * Several processes (the gateway, `antseed gateway key …`) may open an old
   * database at once: the version is re-read inside an IMMEDIATE transaction,
   * which holds the write lock, so only the first one applies a migration.
   */
  private _migrate(): void {
    if ((this._db.pragma('user_version', { simple: true }) as number) >= MIGRATIONS.length) return
    this._db.transaction(() => {
      const version = this._db.pragma('user_version', { simple: true }) as number
      for (let index = version; index < MIGRATIONS.length; index += 1) {
        this._db.exec(MIGRATIONS[index]!)
        this._db.pragma(`user_version = ${index + 1}`)
      }
    }).immediate()
  }

  // ── Workspaces ──────────────────────────────────────────────────────────

  getWorkspace(id: string): WorkspaceRecord | null {
    const row = this._stmt('SELECT * FROM workspaces WHERE id = ? AND deleted_at IS NULL').get(id) as WorkspaceRow | undefined
    return row ? toWorkspace(row) : null
  }

  listWorkspaces(): WorkspaceRecord[] {
    const rows = this._stmt('SELECT * FROM workspaces WHERE deleted_at IS NULL ORDER BY is_default DESC, created_at, id').all() as WorkspaceRow[]
    return rows.map(toWorkspace)
  }

  defaultWorkspace(): WorkspaceRecord {
    return this.getWorkspace(DEFAULT_WORKSPACE_ID)!
  }

  workspaceForKey(keyId: string): WorkspaceRecord | null {
    const row = this._stmt('SELECT workspace_id FROM api_keys WHERE id = ?').get(keyId) as { workspace_id: string | null } | undefined
    return row?.workspace_id ? this.getWorkspace(row.workspace_id) : null
  }

  createWorkspace(input: {
    name: string
    buyerIdentity: string
    walletAddress?: string | null
    limits?: BudgetLimits
    routingPolicy?: RoutingPolicy | null
    orgRoutingPolicy?: RoutingPolicy | null
  }): WorkspaceRecord {
    const id = newId('ws')
    const limits = input.limits ?? NO_BUDGET_LIMITS
    this._stmt(`
      INSERT INTO workspaces (id, name, buyer_identity, is_default, wallet_address, daily_limit_usdc, weekly_limit_usdc, monthly_limit_usdc, total_limit_usdc, routing_policy, org_routing_policy, created_at)
      VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.name, input.buyerIdentity, input.walletAddress ?? null, limits.daily, limits.weekly, limits.monthly, limits.total,
      policyJson(input.routingPolicy), policyJson(input.orgRoutingPolicy), this._now())
    return this.getWorkspace(id)!
  }

  /** Caches the wallet address of every workspace paying with this identity. */
  setWalletAddress(buyerIdentity: string, address: string | null): void {
    this._stmt('UPDATE workspaces SET wallet_address = ? WHERE buyer_identity = ?').run(address, buyerIdentity)
  }

  updateWorkspace(id: string, patch: {
    name?: string
    limits?: Partial<BudgetLimits>
    routingPolicy?: RoutingPolicy | null
    orgRoutingPolicy?: RoutingPolicy | null
  }): WorkspaceRecord {
    const current = this.getWorkspace(id)
    if (!current) throw new Error(`Unknown workspace "${id}".`)
    const limits = { ...current.limits, ...(patch.limits ?? {}) }
    const policy = patch.routingPolicy === undefined ? current.routingPolicy : patch.routingPolicy
    const orgPolicy = patch.orgRoutingPolicy === undefined ? current.orgRoutingPolicy : patch.orgRoutingPolicy
    this._stmt(`
      UPDATE workspaces SET name = ?, daily_limit_usdc = ?, weekly_limit_usdc = ?, monthly_limit_usdc = ?, total_limit_usdc = ?, routing_policy = ?,
        org_routing_policy = ?
      WHERE id = ?
    `).run(patch.name ?? current.name, limits.daily, limits.weekly, limits.monthly, limits.total, policyJson(policy), policyJson(orgPolicy), id)
    return this.getWorkspace(id)!
  }

  /** Soft delete: history keeps pointing at it. The default workspace cannot be deleted. */
  deleteWorkspace(id: string): void {
    if (id === DEFAULT_WORKSPACE_ID) throw new Error('The Default workspace cannot be deleted.')
    this._db.transaction(() => {
      this._stmt('UPDATE workspaces SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL').run(this._now(), id)
      this._stmt('DELETE FROM workspace_members WHERE workspace_id = ?').run(id)
    })()
  }

  /**
   * The workspace that pays with this identity, created (named after the
   * identity) when there is none. Keeps `antseed gateway key create
   * --identity/--new-identity` working.
   */
  ensureWorkspaceForIdentity(buyerIdentity: string): WorkspaceRecord {
    if (buyerIdentity === DEFAULT_BUYER_IDENTITY) return this.defaultWorkspace()
    const row = this._stmt('SELECT * FROM workspaces WHERE buyer_identity = ? AND deleted_at IS NULL ORDER BY created_at, id LIMIT 1')
      .get(buyerIdentity) as WorkspaceRow | undefined
    return row ? toWorkspace(row) : this.createWorkspace({ name: buyerIdentity, buyerIdentity })
  }

  countWorkspaceKeys(workspaceId: string, activeOnly = true): number {
    return this._count(`SELECT COUNT(*) AS count FROM api_keys WHERE workspace_id = ?${activeOnly ? " AND status = 'active'" : ''}`, workspaceId)
  }

  countWorkspaceMembers(workspaceId: string): number {
    return this._count('SELECT COUNT(*) AS count FROM workspace_members WHERE workspace_id = ?', workspaceId)
  }

  workspaceMembers(workspaceId: string): Array<{ member: MemberRecord; role: WorkspaceRole }> {
    const rows = this._stmt(`
      SELECT m.*, wm.role AS ws_role FROM workspace_members wm JOIN members m ON m.id = wm.member_id
      WHERE wm.workspace_id = ? ORDER BY m.created_at, m.id
    `).all(workspaceId) as Array<MemberRow & { ws_role: WorkspaceRole }>
    return rows.map((row) => ({ member: toMember(row), role: row.ws_role }))
  }

  setWorkspaceMember(workspaceId: string, memberId: string, role: WorkspaceRole): void {
    this._stmt(`
      INSERT INTO workspace_members (workspace_id, member_id, role) VALUES (?, ?, ?)
      ON CONFLICT (workspace_id, member_id) DO UPDATE SET role = excluded.role
    `).run(workspaceId, memberId, role)
  }

  removeWorkspaceMember(workspaceId: string, memberId: string): boolean {
    return this._stmt('DELETE FROM workspace_members WHERE workspace_id = ? AND member_id = ?').run(workspaceId, memberId).changes > 0
  }

  // ── Members ─────────────────────────────────────────────────────────────

  getMember(id: string): MemberRecord | null {
    const row = this._stmt('SELECT * FROM members WHERE id = ?').get(id) as MemberRow | undefined
    return row ? toMember(row) : null
  }

  findMemberByEmail(email: string): MemberRecord | null {
    const row = this._stmt('SELECT * FROM members WHERE lower(email) = lower(?)').get(email.trim()) as MemberRow | undefined
    return row ? toMember(row) : null
  }

  listMembers(): MemberRecord[] {
    return (this._stmt('SELECT * FROM members ORDER BY created_at, id').all() as MemberRow[]).map(toMember)
  }

  /** Workspaces (not deleted) the member belongs to, with their role. */
  memberWorkspaceRoles(memberId: string): Map<string, WorkspaceRole> {
    const rows = this._stmt(`
      SELECT wm.workspace_id, wm.role FROM workspace_members wm JOIN workspaces w ON w.id = wm.workspace_id
      WHERE wm.member_id = ? AND w.deleted_at IS NULL
    `).all(memberId) as Array<{ workspace_id: string; role: WorkspaceRole }>
    return new Map(rows.map((row) => [row.workspace_id, row.role]))
  }

  /** True once an active owner exists. */
  isSetupComplete(): boolean {
    return this._stmt("SELECT 1 FROM members WHERE org_role = 'owner' AND status = 'active' LIMIT 1").get() !== undefined
  }

  countActiveOwners(): number {
    return this._count("SELECT COUNT(*) AS count FROM members WHERE org_role = 'owner' AND status = 'active'")
  }

  /** The first owner, created when the console is claimed; admin of the Default workspace. */
  createOwner(input: { label: string; email: string | null }): MemberRecord {
    return this._db.transaction(() => {
      if (this.isSetupComplete()) throw new Error('The console already has an owner.')
      const member = this._insertMember({ label: input.label, email: input.email, orgRole: 'owner', status: 'active' })
      this.setWorkspaceMember(DEFAULT_WORKSPACE_ID, member.id, 'admin')
      return member
    })()
  }

  private _insertMember(input: { label: string; email: string | null; orgRole: OrgRole; status: MemberStatus }): MemberRecord {
    const id = newId('mem')
    this._stmt('INSERT INTO members (id, label, email, org_role, status, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, input.label, input.email?.trim() || null, input.orgRole, input.status, this._now())
    return this.getMember(id)!
  }

  updateMember(id: string, patch: {
    label?: string
    email?: string | null
    orgRole?: OrgRole
    limits?: Partial<BudgetLimits>
    routingPolicy?: RoutingPolicy | null
    maxKeys?: number | null
  }): MemberRecord {
    const current = this.getMember(id)
    if (!current) throw new Error(`Unknown member "${id}".`)
    const limits = { ...current.limits, ...(patch.limits ?? {}) }
    this._stmt(`
      UPDATE members SET label = ?, email = ?, org_role = ?, daily_limit_usdc = ?, weekly_limit_usdc = ?, monthly_limit_usdc = ?,
        total_limit_usdc = ?, routing_policy = ?, max_keys = ? WHERE id = ?
    `).run(
      patch.label ?? current.label,
      patch.email === undefined ? current.email : (patch.email?.trim() || null),
      patch.orgRole ?? current.orgRole,
      limits.daily, limits.weekly, limits.monthly, limits.total,
      policyJson(patch.routingPolicy === undefined ? current.routingPolicy : patch.routingPolicy),
      patch.maxKeys === undefined ? current.maxKeys : patch.maxKeys,
      id,
    )
    return this.getMember(id)!
  }

  setMemberStatus(id: string, status: MemberStatus): MemberRecord {
    const result = this._stmt('UPDATE members SET status = ? WHERE id = ?').run(status, id)
    if (result.changes === 0) throw new Error(`Unknown member "${id}".`)
    return this.getMember(id)!
  }

  // ── Invites ─────────────────────────────────────────────────────────────

  /**
   * Creates the invited member (status 'invited', already in its workspaces)
   * and a single-use link token, of which only the SHA-256 is stored.
   */
  createInvite(input: {
    label: string
    email: string | null
    orgRole: OrgRole
    workspaces: Array<{ workspaceId: string; role: WorkspaceRole }>
    expiresAt: number
    createdBy: string | null
  }): { invite: InviteRecord; token: string } {
    const token = randomBytes(32).toString('base64url')
    const invite = this._db.transaction(() => {
      const member = this._insertMember({ label: input.label, email: input.email, orgRole: input.orgRole, status: 'invited' })
      for (const entry of input.workspaces) this.setWorkspaceMember(entry.workspaceId, member.id, entry.role)
      const id = newId('inv')
      this._stmt(`
        INSERT INTO invites (id, token_hash, member_id, label, email, org_role, workspace_roles, created_by, expires_at, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(id, hashApiKey(token), member.id, input.label, member.email, input.orgRole, JSON.stringify(input.workspaces), input.createdBy, input.expiresAt, this._now())
      return this.getInvite(id)!
    })()
    return { invite, token }
  }

  getInvite(id: string): InviteRecord | null {
    const row = this._stmt('SELECT * FROM invites WHERE id = ?').get(id) as InviteRow | undefined
    return row ? toInvite(row) : null
  }

  /** Invites not yet used (expired ones included, so they can be cleaned up). */
  listInvites(): InviteRecord[] {
    return (this._stmt('SELECT * FROM invites WHERE used_at IS NULL ORDER BY created_at DESC').all() as InviteRow[]).map(toInvite)
  }

  /** Deletes an unused invite and the member it created, if that member never joined. */
  deleteInvite(id: string): boolean {
    return this._db.transaction(() => {
      const invite = this.getInvite(id)
      if (!invite || invite.usedAt !== null) return false
      this._stmt('DELETE FROM invites WHERE id = ?').run(id)
      const member = this.getMember(invite.memberId)
      if (member?.status === 'invited') {
        this._stmt('DELETE FROM workspace_members WHERE member_id = ?').run(member.id)
        this._stmt('DELETE FROM members WHERE id = ?').run(member.id)
      }
      return true
    })()
  }

  /** The invite behind a token hash while it is usable, without consuming it. */
  peekInvite(tokenHash: string, now: number): { invite: InviteRecord; member: MemberRecord } | null {
    const row = this._stmt('SELECT * FROM invites WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?').get(tokenHash, now) as InviteRow | undefined
    if (!row) return null
    const member = this.getMember(row.member_id)
    return member && member.status === 'invited' ? { invite: toInvite(row), member } : null
  }

  /** Token hash of a member's newest live (unused, unexpired) invite, for SSO activation by email. */
  liveInviteHash(memberId: string, now: number): string | null {
    const row = this._stmt('SELECT token_hash FROM invites WHERE member_id = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1')
      .get(memberId, now) as { token_hash: string } | undefined
    return row?.token_hash ?? null
  }

  /** Marks the invite used and its member active; null when the token is unknown, used or expired. */
  consumeInvite(tokenHash: string, now: number): MemberRecord | null {
    return this._db.transaction(() => {
      const found = this.peekInvite(tokenHash, now)
      if (!found) return null
      this._stmt('UPDATE invites SET used_at = ? WHERE id = ?').run(now, found.invite.id)
      return this.setMemberStatus(found.member.id, 'active')
    })()
  }

  // ── Keys ────────────────────────────────────────────────────────────────

  /**
   * Creates a key in `workspaceId`, or, for callers that only name an
   * identity (the CLI), in the workspace paying with that identity.
   */
  createKey(input: {
    label: string
    buyerIdentity?: string
    workspaceId?: string
    ownerMemberId?: string | null
    limits: SpendLimits
    routingPolicy?: RoutingPolicy | null
    ownerLimits?: BudgetLimits
    ownerRoutingPolicy?: RoutingPolicy | null
    expiresAt: number | null
    topupEnabled?: boolean
  }): { key: ApiKeyRecord; secret: string } {
    let workspace: WorkspaceRecord
    if (input.workspaceId) {
      const found = this.getWorkspace(input.workspaceId)
      if (!found) throw new Error(`Unknown workspace "${input.workspaceId}".`)
      if (input.buyerIdentity && input.buyerIdentity !== found.buyerIdentity) {
        throw new Error(`Workspace "${found.name}" pays with identity "${found.buyerIdentity}", not "${input.buyerIdentity}".`)
      }
      workspace = found
    } else {
      workspace = this.ensureWorkspaceForIdentity(input.buyerIdentity ?? DEFAULT_BUYER_IDENTITY)
    }
    const generated = generateApiKey()
    const id = newKeyId()
    const limits = fullLimits(input.limits)
    const ownerLimits = input.ownerLimits ?? NO_BUDGET_LIMITS
    this._stmt(`
      INSERT INTO api_keys (id, label, key_hash, key_hint, buyer_identity, workspace_id, owner_member_id, source,
        daily_limit_usdc, weekly_limit_usdc, monthly_limit_usdc, total_limit_usdc, routing_policy,
        owner_daily_limit_usdc, owner_weekly_limit_usdc, owner_monthly_limit_usdc, owner_total_limit_usdc, owner_routing_policy,
        topup_enabled, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.label, generated.hash, generated.hint, workspace.buyerIdentity, workspace.id, input.ownerMemberId ?? null,
      limits.daily, limits.weekly, limits.monthly, limits.total, policyJson(input.routingPolicy),
      ownerLimits.daily, ownerLimits.weekly, ownerLimits.monthly, ownerLimits.total, policyJson(input.ownerRoutingPolicy),
      input.topupEnabled ? 1 : 0, input.expiresAt, this._now(),
    )
    return { key: this.getKey(id)!, secret: generated.secret }
  }

  /**
   * The single key `antseed tunnel start` used to take from
   * ANTSEED_TUNNEL_API_KEY becomes an unlimited key on the default identity,
   * so existing tunnel clients keep working. A changed env key replaces it.
   */
  syncEnvironmentKey(secret: string): ApiKeyRecord {
    const hash = hashApiKey(secret)
    const existing = this._stmt("SELECT id FROM api_keys WHERE source = 'tunnel-env'").get() as { id: string } | undefined
    if (existing) {
      this._stmt("UPDATE api_keys SET key_hash = ?, key_hint = ?, status = 'active', revoked_at = NULL WHERE id = ?")
        .run(hash, apiKeyHint(secret), existing.id)
      return this.getKey(existing.id)!
    }
    const id = newKeyId()
    this._stmt(`
      INSERT INTO api_keys (id, label, key_hash, key_hint, buyer_identity, workspace_id, source, created_at)
      VALUES (?, 'Tunnel key', ?, ?, ?, ?, 'tunnel-env', ?)
    `).run(id, hash, apiKeyHint(secret), DEFAULT_BUYER_IDENTITY, DEFAULT_WORKSPACE_ID, this._now())
    return this.getKey(id)!
  }

  /**
   * Revokes the ANTSEED_TUNNEL_API_KEY key once the tunnel starts without the
   * env var, so unsetting it retires the shared unlimited key. Returns the
   * revoked key, or null when there was no active one.
   */
  retireEnvironmentKey(): ApiKeyRecord | null {
    const existing = this._stmt("SELECT id FROM api_keys WHERE source = 'tunnel-env' AND status = 'active'").get() as { id: string } | undefined
    return existing ? this.revokeKey(existing.id) : null
  }

  findKeyBySecret(secret: string): ApiKeyRecord | null {
    const row = this._stmt('SELECT * FROM api_keys WHERE key_hash = ?').get(hashApiKey(secret)) as KeyRow | undefined
    return row ? toKey(row) : null
  }

  getKey(id: string): ApiKeyRecord | null {
    const row = this._stmt('SELECT * FROM api_keys WHERE id = ?').get(id) as KeyRow | undefined
    return row ? toKey(row) : null
  }

  listKeys(filter: { workspaceId?: string; ownerMemberId?: string } = {}): ApiKeyRecord[] {
    const where: string[] = []
    const params: unknown[] = []
    if (filter.workspaceId) { where.push('workspace_id = ?'); params.push(filter.workspaceId) }
    if (filter.ownerMemberId) { where.push('owner_member_id = ?'); params.push(filter.ownerMemberId) }
    const sql = `SELECT * FROM api_keys ${whereClause(where)} ORDER BY created_at, id`
    return (this._stmt(sql).all(...params) as KeyRow[]).map(toKey)
  }

  countActiveKeys(): number {
    return this._count("SELECT COUNT(*) AS count FROM api_keys WHERE status = 'active'")
  }

  countActiveKeysForMember(memberId: string): number {
    return this._count("SELECT COUNT(*) AS count FROM api_keys WHERE status = 'active' AND owner_member_id = ?", memberId)
  }

  setLimits(id: string, limits: Partial<SpendLimits>): ApiKeyRecord {
    const key = this.getKey(id)
    if (!key) throw new Error(`Unknown key "${id}".`)
    const next = { ...key.limits, ...limits }
    this._stmt('UPDATE api_keys SET daily_limit_usdc = ?, weekly_limit_usdc = ?, monthly_limit_usdc = ?, total_limit_usdc = ? WHERE id = ?')
      .run(next.daily, next.weekly ?? null, next.monthly, next.total, id)
    return this.getKey(id)!
  }

  setTopupEnabled(id: string, enabled: boolean): ApiKeyRecord {
    const result = this._stmt('UPDATE api_keys SET topup_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
    if (result.changes === 0) throw new Error(`Unknown key "${id}".`)
    return this.getKey(id)!
  }

  updateKey(id: string, patch: {
    label?: string
    limits?: Partial<BudgetLimits>
    routingPolicy?: RoutingPolicy | null
    ownerLimits?: Partial<BudgetLimits>
    ownerRoutingPolicy?: RoutingPolicy | null
    topupEnabled?: boolean
    expiresAt?: number | null
    ownerMemberId?: string | null
  }): ApiKeyRecord {
    const key = this.getKey(id)
    if (!key) throw new Error(`Unknown key "${id}".`)
    const limits = { ...key.limits, ...(patch.limits ?? {}) }
    const ownerLimits = { ...key.ownerLimits, ...(patch.ownerLimits ?? {}) }
    this._stmt(`
      UPDATE api_keys SET label = ?, daily_limit_usdc = ?, weekly_limit_usdc = ?, monthly_limit_usdc = ?, total_limit_usdc = ?,
        routing_policy = ?, owner_daily_limit_usdc = ?, owner_weekly_limit_usdc = ?, owner_monthly_limit_usdc = ?, owner_total_limit_usdc = ?,
        owner_routing_policy = ?, topup_enabled = ?, expires_at = ?, owner_member_id = ? WHERE id = ?
    `).run(
      patch.label ?? key.label,
      limits.daily, limits.weekly, limits.monthly, limits.total,
      policyJson(patch.routingPolicy === undefined ? key.routingPolicy : patch.routingPolicy),
      ownerLimits.daily, ownerLimits.weekly, ownerLimits.monthly, ownerLimits.total,
      policyJson(patch.ownerRoutingPolicy === undefined ? key.ownerRoutingPolicy : patch.ownerRoutingPolicy),
      (patch.topupEnabled ?? key.topupEnabled) ? 1 : 0,
      patch.expiresAt === undefined ? key.expiresAt : patch.expiresAt,
      patch.ownerMemberId === undefined ? key.ownerMemberId : patch.ownerMemberId,
      id,
    )
    return this.getKey(id)!
  }

  /** New secret for the same key id; usage history, limits and policy stay. */
  rotateKey(id: string): { key: ApiKeyRecord; secret: string } {
    const generated = generateApiKey()
    const result = this._stmt("UPDATE api_keys SET key_hash = ?, key_hint = ? WHERE id = ? AND status = 'active'")
      .run(generated.hash, generated.hint, id)
    if (result.changes === 0) throw new Error(this.getKey(id) ? `Key "${id}" is revoked.` : `Unknown key "${id}".`)
    return { key: this.getKey(id)!, secret: generated.secret }
  }

  revokeKey(id: string): ApiKeyRecord {
    const result = this._stmt("UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE id = ? AND status = 'active'")
      .run(this._now(), id)
    if (result.changes === 0 && !this.getKey(id)) throw new Error(`Unknown key "${id}".`)
    return this.getKey(id)!
  }

  /** Revokes every active key a member owns; returns their ids. */
  revokeMemberKeys(memberId: string): string[] {
    const ids = (this._stmt("SELECT id FROM api_keys WHERE owner_member_id = ? AND status = 'active'").all(memberId) as Array<{ id: string }>)
      .map((row) => row.id)
    for (const id of ids) this.revokeKey(id)
    return ids
  }

  /** Records use at most once a minute per key (per process), so requests do not each write. */
  touchKey(id: string): void {
    const now = this._now()
    if (!this._shouldTouch(`key:${id}`, now)) return
    this._stmt('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(now, id)
  }

  private _shouldTouch(id: string, now: number): boolean {
    const last = this._touched.get(id)
    if (last !== undefined && now - last < TOUCH_INTERVAL_MS && now >= last) return false
    if (this._touched.size >= MAX_TRACKED_TOUCHES) this._touched.clear()
    this._touched.set(id, now)
    return true
  }

  // ── Requests ────────────────────────────────────────────────────────────

  startRequest(input: GatewayRequestStart): void {
    this._stmt(`
      INSERT INTO gateway_requests (tag, key_id, buyer_identity, method, path, model, started_at, workspace_id, member_id, end_user)
      VALUES (?, ?, ?, ?, ?, ?, ?,
        COALESCE(?, (SELECT workspace_id FROM api_keys WHERE id = ?)),
        COALESCE(?, (SELECT owner_member_id FROM api_keys WHERE id = ?)),
        ?)
    `).run(
      input.tag, input.keyId, input.buyerIdentity, input.method, input.path, input.model, input.startedAt,
      input.workspaceId ?? null, input.keyId, input.memberId ?? null, input.keyId, input.endUser ?? null,
    )
  }

  /** `error` is kept for failed requests (code ≤ 100, message ≤ 500 characters). */
  finishRequest(tag: string, result: { status: number; buyerRequestId: string | null; error?: RequestError | null }): void {
    this._stmt(`
      UPDATE gateway_requests SET status = ?, buyer_request_id = ?, finished_at = ?, error_code = ?, error_message = ? WHERE tag = ?
    `).run(
      result.status, result.buyerRequestId, this._now(),
      result.error?.code?.slice(0, MAX_ERROR_CODE) || null, result.error?.message?.slice(0, MAX_ERROR_MESSAGE) || null, tag,
    )
  }

  /** Seller, latency and end user of a request; null fields leave what is stored. */
  recordRequestOutcome(tag: string, outcome: RequestOutcome): void {
    this._stmt(`
      UPDATE gateway_requests SET seller_peer_id = COALESCE(?, seller_peer_id), latency_ms = COALESCE(?, latency_ms),
        end_user = COALESCE(?, end_user) WHERE tag = ?
    `).run(outcome.sellerPeerId ?? null, outcome.latencyMs ?? null, outcome.endUser ?? null, tag)
  }

  /**
   * The token counts the response itself reported, read by the gateway as it
   * streamed past. Usage falls back to them while (or if ever) the request
   * has no spend with token counts in the ledger, so they never add up twice.
   */
  recordResponseUsage(tag: string, usage: ResponseTokenCounts): void {
    this._stmt(`
      UPDATE gateway_requests SET usage_input_tokens = ?, usage_cached_input_tokens = ?, usage_output_tokens = ? WHERE tag = ?
    `).run(usage.inputTokens, usage.cachedInputTokens, usage.outputTokens, tag)
  }

  /** Only called while content logging is on. */
  recordRequestContent(tag: string, content: { requestBody?: string | null; responseBody?: string | null }): void {
    this._stmt(`
      UPDATE gateway_requests SET request_body = COALESCE(?, request_body), response_body = COALESCE(?, response_body) WHERE tag = ?
    `).run(content.requestBody ?? null, content.responseBody ?? null, tag)
  }

  /**
   * Drops request-log rows started before `before`, `chunkSize` rows per
   * transaction so a large backlog never holds the write lock for long. Their
   * request counts move into `request_rollups` (per hour, key, workspace,
   * member, model, seller and end user) so usage reports keep counting them;
   * spend and tokens live in the ledger, which is never pruned. Pruned
   * periods are therefore counted at hour granularity. Yields to the event
   * loop between chunks, so requests keep flowing while a backlog drains.
   */
  async pruneRequests(before: number, chunkSize = 5_000): Promise<number> {
    const select = this._stmt('SELECT rowid FROM gateway_requests WHERE started_at < ? ORDER BY started_at LIMIT ?').pluck()
    const rollup = this._stmt(`
      INSERT INTO request_rollups (hour_start, key_id, workspace_id, member_id, model, seller_peer_id, end_user, requests, failed_requests)
      SELECT (r.started_at / ${HOUR_MS}) * ${HOUR_MS}, r.key_id, r.workspace_id, r.member_id, r.model, r.seller_peer_id, r.end_user,
        COUNT(*), SUM(${FAILED_SQL})
      FROM gateway_requests r WHERE r.rowid IN (SELECT value FROM json_each(?))
      GROUP BY 1, 2, 3, 4, 5, 6, 7
    `)
    const remove = this._stmt('DELETE FROM gateway_requests WHERE rowid IN (SELECT value FROM json_each(?))')
    const pruneChunk = this._db.transaction(() => {
      const ids = select.all(before, chunkSize) as number[]
      if (ids.length === 0) return 0
      const json = JSON.stringify(ids)
      rollup.run(json)
      remove.run(json)
      return ids.length
    })
    let removed = 0
    for (;;) {
      const count = pruneChunk.immediate()
      removed += count
      if (count < chunkSize) return removed
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
  }

  /** Who a request was attributed to when it started. */
  findRequest(tag: string): {
    keyId: string
    buyerIdentity: string
    workspaceId: string | null
    memberId: string | null
    model: string | null
    endUser: string | null
  } | null {
    const row = this._stmt('SELECT key_id, buyer_identity, workspace_id, member_id, model, end_user FROM gateway_requests WHERE tag = ?').get(tag) as
      { key_id: string; buyer_identity: string; workspace_id: string | null; member_id: string | null; model: string | null; end_user: string | null } | undefined
    return row
      ? { keyId: row.key_id, buyerIdentity: row.buyer_identity, workspaceId: row.workspace_id, memberId: row.member_id, model: row.model, endUser: row.end_user }
      : null
  }

  /** Requests per seller since a time, with the median latency this gateway measured. */
  peerStats(sinceMs: number): Array<{ peerId: string; requests: number; latencyMsP50: number | null }> {
    const rows = this._stmt(`
      SELECT seller_peer_id AS peer, latency_ms AS latency FROM gateway_requests
      WHERE started_at >= ? AND seller_peer_id IS NOT NULL
    `).all(sinceMs) as Array<{ peer: string; latency: number | null }>
    const byPeer = new Map<string, { requests: number; latencies: number[] }>()
    for (const row of rows) {
      const entry = byPeer.get(row.peer) ?? { requests: 0, latencies: [] }
      entry.requests += 1
      if (row.latency !== null) entry.latencies.push(row.latency)
      byPeer.set(row.peer, entry)
    }
    return [...byPeer].map(([peerId, entry]) => {
      const sorted = entry.latencies.sort((a, b) => a - b)
      return { peerId, requests: entry.requests, latencyMsP50: sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)]! : null }
    })
  }

  /** Newest first, ordered by (startedAt, tag); pass the last row as `before` for the next page. Bodies are not read. */
  listRequests(filter: RequestLogFilter): RequestLogRow[] {
    const { where, params } = scopeSql(filter, REQUEST_COLUMNS)
    if (filter.status === 'ok') where.push('r.status IS NOT NULL AND r.status < 400')
    else if (filter.status === 'error') where.push(FAILED_SQL)
    else if (typeof filter.status === 'number') { where.push('r.status = ?'); params.push(filter.status) }
    const q = filter.q?.trim()
    if (q) {
      const pattern = `%${escapeLike(q)}%`
      const columns = ['r.model', 'k.label', 'r.end_user', 'r.tag', 'r.seller_peer_id', 'r.path', 'r.error_code', 'r.error_message']
      where.push(`(${columns.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ')})`)
      params.push(...columns.map(() => pattern))
    }
    if (filter.before) {
      where.push('(r.started_at < ? OR (r.started_at = ? AND r.tag < ?))')
      params.push(filter.before.startedAt, filter.before.startedAt, filter.before.tag)
    }
    const limit = Math.max(1, Math.min(filter.limit ?? 50, 100_000))
    return this._requestRows(where, params, limit, false)
  }

  /** One request with its bodies; `keyIds` limits it to what the caller may see. */
  getRequest(tag: string, keyIds: readonly string[] | null = null): RequestDetailRow | null {
    const { where, params } = scopeSql({ keyIds }, REQUEST_COLUMNS)
    where.push('r.tag = ?')
    params.push(tag)
    return (this._requestRows(where, params, 1, true)[0] as RequestDetailRow | undefined) ?? null
  }

  /** The page of requests first, then one grouped ledger read for just those tags. */
  private _requestRows(where: string[], params: unknown[], limit: number, withBodies: boolean): Array<RequestLogRow | RequestDetailRow> {
    const rows = this._stmt(`
      WITH page AS (
        SELECT r.tag, r.started_at, r.finished_at, r.key_id, k.label AS key_label, COALESCE(r.workspace_id, k.workspace_id) AS ws_id,
          r.member_id, r.end_user, r.method, r.path, r.model, r.status, r.seller_peer_id, r.latency_ms, r.error_code, r.error_message,
          r.usage_input_tokens, r.usage_cached_input_tokens, r.usage_output_tokens
          ${withBodies ? ', r.request_body, r.response_body' : ''}
        FROM gateway_requests r LEFT JOIN api_keys k ON k.id = r.key_id
        ${whereClause(where)}
        ORDER BY r.started_at DESC, r.tag DESC LIMIT ?
      ),
      spend AS (
        SELECT l.request_tag AS tag, -SUM(l.amount_usdc) AS spent, SUM(l.input_tokens) AS in_tokens,
          SUM(l.cached_input_tokens) AS cached_tokens, SUM(l.output_tokens) AS out_tokens
        FROM ledger_entries l WHERE l.kind = 'spend' AND l.request_tag IN (SELECT tag FROM page) GROUP BY l.request_tag
      )
      SELECT page.*, spend.spent, COALESCE(spend.in_tokens, 0) AS in_tokens, COALESCE(spend.cached_tokens, 0) AS cached_tokens,
        COALESCE(spend.out_tokens, 0) AS out_tokens
      FROM page LEFT JOIN spend ON spend.tag = page.tag
      ORDER BY page.started_at DESC, page.tag DESC
    `).all(...params, limit) as Array<Record<string, unknown>>
    return rows.map((row) => {
      // Ledger tokens when the spend reported any, else what the response said.
      const ledgerTokens = (row['in_tokens'] as number) + (row['cached_tokens'] as number) + (row['out_tokens'] as number) > 0
      const status = row['status'] as number | null
      return {
      tag: row['tag'] as string,
      startedAt: row['started_at'] as number,
      finishedAt: row['finished_at'] as number | null,
      keyId: row['key_id'] as string,
      keyLabel: (row['key_label'] as string | null) ?? row['key_id'] as string,
      workspaceId: (row['ws_id'] as string | null) ?? DEFAULT_WORKSPACE_ID,
      memberId: row['member_id'] as string | null,
      endUser: row['end_user'] as string | null,
      method: row['method'] as string,
      path: row['path'] as string,
      model: row['model'] as string | null,
      status: row['status'] as number | null,
      sellerPeerId: row['seller_peer_id'] as string | null,
      latencyMs: row['latency_ms'] as number | null,
      spentUsdc: row['spent'] as number | null,
      inputTokens: ledgerTokens ? row['in_tokens'] as number : (row['usage_input_tokens'] as number | null) ?? 0,
      cachedInputTokens: ledgerTokens ? row['cached_tokens'] as number : (row['usage_cached_input_tokens'] as number | null) ?? 0,
      outputTokens: ledgerTokens ? row['out_tokens'] as number : (row['usage_output_tokens'] as number | null) ?? 0,
      errorCode: row['error_code'] as string | null,
      errorMessage: row['error_message'] as string | null,
      costPending: row['spent'] === null && row['model'] !== null && (status === null || status < 400),
      ...(withBodies ? { requestBody: row['request_body'] as string | null, responseBody: row['response_body'] as string | null } : {}),
      }
    })
  }

  /**
   * Totals plus one row per group (each split by `splitBy` when given),
   * attributed as at request time. Request counts come from the request log
   * plus the rollups of pruned rows; spend and tokens from the ledger, and
   * the tokens of requests whose spend carries none (not reported yet, or
   * never) from the usage their responses reported.
   */
  usageReport(filter: UsageFilter, groupBy: UsageGroupBy | null, splitBy: UsageGroupBy | null = null): { totals: UsageTotalsRow; groups: UsageGroupRow[] } {
    const select = (columns: ScopeColumns): string =>
      `${groupExpression(groupBy, columns)} AS g, ${splitBy ? groupExpression(splitBy, columns) : 'NULL'} AS s`
    const req = scopeSql(filter, REQUEST_COLUMNS)
    const requestRows = this._stmt(`
      SELECT ${select(REQUEST_COLUMNS)}, COUNT(*) AS requests, COALESCE(SUM(${FAILED_SQL}), 0) AS failed
      FROM gateway_requests r ${whereClause(req.where)} GROUP BY g, s
    `).all(...req.params) as Array<{ g: string | null; s: string | null; requests: number; failed: number }>
    const roll = scopeSql(filter, ROLLUP_COLUMNS)
    const rollupRows = this._stmt(`
      SELECT ${select(ROLLUP_COLUMNS)}, SUM(u.requests) AS requests, SUM(u.failed_requests) AS failed
      FROM request_rollups u ${whereClause(roll.where)} GROUP BY g, s
    `).all(...roll.params) as Array<{ g: string | null; s: string | null; requests: number; failed: number }>
    const led = scopeSql(filter, LEDGER_COLUMNS)
    led.where.push("l.kind = 'spend'")
    const ledgerRows = this._stmt(`
      SELECT ${select(LEDGER_COLUMNS)}, COALESCE(-SUM(l.amount_usdc), 0) AS spent, COALESCE(SUM(l.input_tokens), 0) AS input_tokens,
        COALESCE(SUM(l.cached_input_tokens), 0) AS cached_input_tokens, COALESCE(SUM(l.output_tokens), 0) AS output_tokens
      FROM ledger_entries l ${whereClause(led.where)} GROUP BY g, s
    `).all(...led.params) as Array<{ g: string | null; s: string | null; spent: number; input_tokens: number; cached_input_tokens: number; output_tokens: number }>
    const fallback = scopeSql(filter, REQUEST_COLUMNS)
    fallback.where.push('r.usage_input_tokens IS NOT NULL', `NOT EXISTS (
      SELECT 1 FROM ledger_entries t WHERE t.request_tag = r.tag AND t.kind = 'spend' AND t.input_tokens + t.cached_input_tokens + t.output_tokens > 0
    )`)
    const responseRows = this._stmt(`
      SELECT ${select(REQUEST_COLUMNS)}, SUM(r.usage_input_tokens) AS input_tokens, COALESCE(SUM(r.usage_cached_input_tokens), 0) AS cached_input_tokens,
        COALESCE(SUM(r.usage_output_tokens), 0) AS output_tokens
      FROM gateway_requests r ${whereClause(fallback.where)} GROUP BY g, s
    `).all(...fallback.params) as Array<{ g: string | null; s: string | null; input_tokens: number; cached_input_tokens: number; output_tokens: number }>

    const groups = new Map<string | null, { totals: UsageTotalsRow; splits: Map<string | null, UsageTotalsRow> }>()
    const entries = (group: string | null, split: string | null): UsageTotalsRow[] => {
      let found = groups.get(group)
      if (!found) {
        found = { totals: emptyUsageTotals(), splits: new Map() }
        groups.set(group, found)
      }
      if (!splitBy) return [found.totals]
      let part = found.splits.get(split)
      if (!part) {
        part = emptyUsageTotals()
        found.splits.set(split, part)
      }
      return [found.totals, part]
    }
    for (const row of [...requestRows, ...rollupRows]) {
      for (const target of entries(row.g, row.s)) {
        target.requests += row.requests
        target.failedRequests += row.failed
      }
    }
    const tokenRows: Array<(typeof responseRows)[number] & { spent?: number }> = [...ledgerRows, ...responseRows]
    for (const row of tokenRows) {
      for (const target of entries(row.g, row.s)) {
        target.spentUsdc += row.spent ?? 0
        target.inputTokens += row.input_tokens
        target.cachedInputTokens += row.cached_input_tokens
        target.outputTokens += row.output_tokens
      }
    }
    const totals = emptyUsageTotals()
    for (const { totals: value } of groups.values()) {
      for (const field of Object.keys(totals) as Array<keyof UsageTotalsRow>) totals[field] += value[field]
    }
    if (!groupBy) return { totals, groups: [] }
    const bySize = (a: UsageTotalsRow, b: UsageTotalsRow): number => b.spentUsdc - a.spentUsdc || b.requests - a.requests
    const list: UsageGroupRow[] = [...groups].map(([group, entry]) => ({
      group,
      ...entry.totals,
      ...(splitBy ? { splits: [...entry.splits].map(([split, part]) => ({ group: split, ...part })).sort(bySize) } : {}),
    }))
    if (isTimeGrouping(groupBy)) list.sort((a, b) => String(a.group).localeCompare(String(b.group)))
    else list.sort(bySize)
    return { totals, groups: list }
  }

  // ── Ledger ──────────────────────────────────────────────────────────────

  /**
   * Returns false when the entry was already recorded (same externalRef).
   * The entry is attributed to the workspace, member, model and end user of
   * its request (or, without one, of its key as it is now) unless given.
   */
  recordLedgerEntry(entry: LedgerEntryInput): boolean {
    if (!Number.isSafeInteger(entry.amountUsdc) || entry.amountUsdc < 0) {
      throw new Error('Ledger amounts are non-negative integer USDC base units; the kind sets the sign.')
    }
    const signed = entry.kind === 'spend' ? -entry.amountUsdc : entry.amountUsdc
    const request = entry.requestTag ? this.findRequest(entry.requestTag) : null
    const key = request ? null : this.getKey(entry.keyId)
    const workspaceId = entry.workspaceId ?? request?.workspaceId ?? key?.workspaceId ?? null
    let memberId = entry.memberId
    if (memberId === undefined) memberId = request ? request.memberId : key?.ownerMemberId ?? null
    const result = this._stmt(`
      INSERT OR IGNORE INTO ledger_entries
        (kind, key_id, buyer_identity, amount_usdc, external_ref, request_tag, seller_peer_id,
         input_tokens, cached_input_tokens, output_tokens, note, created_at, workspace_id, member_id, model, end_user)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.kind, entry.keyId, entry.buyerIdentity, signed, entry.externalRef,
      entry.requestTag ?? null, entry.sellerPeerId ?? null,
      entry.inputTokens ?? 0, entry.cachedInputTokens ?? 0, entry.outputTokens ?? 0,
      entry.note ?? null, entry.createdAt,
      workspaceId, memberId, entry.model ?? request?.model ?? null, entry.endUser ?? request?.endUser ?? null,
    )
    return result.changes > 0
  }

  /** A key's spend for the periods `antseed gateway key` shows. */
  periodSpend(keyId: string, now = this._now()): Record<LimitPeriod, number> {
    const all = this.spendByPeriod({ keyId }, now)
    return Object.fromEntries(LIMIT_PERIODS.map((period) => [period, all[period]])) as Record<LimitPeriod, number>
  }

  /**
   * Settled spend per budget period of a key, member or workspace, as
   * attributed when it was spent. Only `periods` are summed (the rest are 0),
   * in one indexed query.
   */
  spendByPeriod(scope: BudgetScope, now = this._now(), periods: readonly BudgetPeriod[] = BUDGET_PERIODS): BudgetSpend {
    const spend: BudgetSpend = { daily: 0, weekly: 0, monthly: 0, total: 0 }
    if (periods.length === 0) return spend
    // Read from the rollups the ledger trigger keeps (see migration v3):
    // the lifetime total is one row, a dated period at most 31 daily rows,
    // however long the ledger grows. Periods start at UTC midnight, so they
    // align with the daily rows.
    const { kind, id } = budgetScopeRow(scope)
    if (periods.includes('total')) {
      const row = this._stmt('SELECT total_usdc FROM spend_totals WHERE scope_kind = ? AND scope_id = ?').get(kind, id) as { total_usdc: number } | undefined
      spend.total = row?.total_usdc ?? 0
    }
    const dated = periods.filter((period) => period !== 'total')
    if (dated.length > 0) {
      const starts = dated.map((period) => periodStart(period, now))
      const row = this._stmt(`
        SELECT ${dated.map((_, index) => `COALESCE(SUM(CASE WHEN day_start >= ? THEN amount_usdc ELSE 0 END), 0) AS p${index}`).join(', ')}
        FROM spend_daily WHERE scope_kind = ? AND scope_id = ? AND day_start >= ?
      `).get(...starts, kind, id, Math.min(...starts)) as Record<string, number>
      dated.forEach((period, index) => { spend[period] = row[`p${index}`] ?? 0 })
    }
    return spend
  }

  usageStats(keyId: string, since = 0): KeyUsageStats {
    const requests = this._stmt(`
      SELECT COUNT(*) AS requests, COALESCE(SUM(${FAILED_SQL}), 0) AS failed
      FROM gateway_requests r WHERE r.key_id = ? AND r.started_at >= ?
    `).get(keyId, since) as { requests: number; failed: number }
    const rolled = this._stmt(`
      SELECT COALESCE(SUM(requests), 0) AS requests, COALESCE(SUM(failed_requests), 0) AS failed
      FROM request_rollups WHERE key_id = ? AND hour_start >= ?
    `).get(keyId, since) as { requests: number; failed: number }
    const ledger = this._stmt(`
      SELECT COALESCE(-SUM(CASE WHEN kind = 'spend' THEN amount_usdc ELSE 0 END), 0) AS spent,
             COALESCE(SUM(CASE WHEN kind = 'credit' THEN amount_usdc ELSE 0 END), 0) AS credited,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens
      FROM ledger_entries WHERE key_id = ? AND created_at >= ?
    `).get(keyId, since) as { spent: number; credited: number; input_tokens: number; cached_input_tokens: number; output_tokens: number }
    return {
      requests: requests.requests + rolled.requests,
      failedRequests: requests.failed + rolled.failed,
      spentUsdc: ledger.spent,
      creditedUsdc: ledger.credited,
      inputTokens: ledger.input_tokens,
      cachedInputTokens: ledger.cached_input_tokens,
      outputTokens: ledger.output_tokens,
    }
  }

  // ── Peer lists ──────────────────────────────────────────────────────────

  listPeerLists(): PeerListRecord[] {
    return (this._stmt('SELECT * FROM peer_lists ORDER BY created_at, id').all() as Array<Record<string, unknown>>).map(toPeerList)
  }

  getPeerList(id: string): PeerListRecord | null {
    const row = this._stmt('SELECT * FROM peer_lists WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? toPeerList(row) : null
  }

  createPeerList(input: { name: string; description: string | null; peerIds: string[] }): PeerListRecord {
    const id = newId('pl')
    this._stmt('INSERT INTO peer_lists (id, name, description, peer_ids, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, input.name, input.description, JSON.stringify(input.peerIds), this._now())
    return this.getPeerList(id)!
  }

  updatePeerList(id: string, patch: { name?: string; description?: string | null; peerIds?: string[] }): PeerListRecord {
    const current = this.getPeerList(id)
    if (!current) throw new Error(`Unknown peer list "${id}".`)
    this._stmt('UPDATE peer_lists SET name = ?, description = ?, peer_ids = ? WHERE id = ?').run(
      patch.name ?? current.name,
      patch.description === undefined ? current.description : patch.description,
      JSON.stringify(patch.peerIds ?? current.peerIds),
      id,
    )
    return this.getPeerList(id)!
  }

  deletePeerList(id: string): boolean {
    return this._stmt('DELETE FROM peer_lists WHERE id = ?').run(id).changes > 0
  }

  // ── Presets ─────────────────────────────────────────────────────────────

  listPresets(): PresetRecord[] {
    return (this._stmt('SELECT * FROM presets ORDER BY created_at, id').all() as Array<Record<string, unknown>>).map(toPreset)
  }

  getPreset(id: string): PresetRecord | null {
    const row = this._stmt('SELECT * FROM presets WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? toPreset(row) : null
  }

  /** A workspace's own preset wins over an org-wide one with the same slug. */
  findPresetBySlug(slug: string, workspaceId: string | null): PresetRecord | null {
    const row = this._stmt(`
      SELECT * FROM presets WHERE slug = ? AND (workspace_id IS NULL OR workspace_id = ?)
      ORDER BY workspace_id IS NULL LIMIT 1
    `).get(slug, workspaceId) as Record<string, unknown> | undefined
    return row ? toPreset(row) : null
  }

  createPreset(input: Omit<PresetRecord, 'id' | 'createdAt'>): PresetRecord {
    const id = newId('pre')
    this._stmt(`
      INSERT INTO presets (id, slug, name, workspace_id, model, routing_policy, system_prompt, params, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, input.slug, input.name, input.workspaceId, input.model, policyJson(input.routingPolicy), input.systemPrompt,
      JSON.stringify(input.params ?? {}), this._now())
    return this.getPreset(id)!
  }

  updatePreset(id: string, patch: Partial<Omit<PresetRecord, 'id' | 'createdAt' | 'workspaceId'>>): PresetRecord {
    const current = this.getPreset(id)
    if (!current) throw new Error(`Unknown preset "${id}".`)
    const next = { ...current, ...patch }
    this._stmt(`
      UPDATE presets SET slug = ?, name = ?, model = ?, routing_policy = ?, system_prompt = ?, params = ? WHERE id = ?
    `).run(next.slug, next.name, next.model, policyJson(next.routingPolicy), next.systemPrompt, JSON.stringify(next.params ?? {}), id)
    return this.getPreset(id)!
  }

  deletePreset(id: string): boolean {
    return this._stmt('DELETE FROM presets WHERE id = ?').run(id).changes > 0
  }

  // ── Management tokens ───────────────────────────────────────────────────

  /**
   * `createdBy` is the creating member's id (null from the CLI); the token
   * stops working when that member is no longer an active admin or owner.
   * `expiresAt` null never expires.
   */
  createAdminToken(input: { label: string; scope: 'admin' | 'read'; createdBy: string | null; expiresAt?: number | null }): { token: AdminTokenRecord; secret: string } {
    const secret = `${ADMIN_TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`
    const id = newId('tok')
    this._stmt('INSERT INTO admin_tokens (id, label, token_hash, hint, scope, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, input.label, hashApiKey(secret), apiKeyHint(secret), input.scope, input.createdBy, input.expiresAt ?? null, this._now())
    return { token: this.getAdminToken(id)!, secret }
  }

  getAdminToken(id: string): AdminTokenRecord | null {
    const row = this._stmt('SELECT * FROM admin_tokens WHERE id = ?').get(id) as Record<string, unknown> | undefined
    return row ? toAdminToken(row) : null
  }

  listAdminTokens(): AdminTokenRecord[] {
    return (this._stmt('SELECT * FROM admin_tokens WHERE revoked_at IS NULL ORDER BY created_at, id').all() as Array<Record<string, unknown>>)
      .map(toAdminToken)
  }

  /** Active token for a presented secret (hash lookup). */
  findAdminTokenBySecret(secret: string): AdminTokenRecord | null {
    const row = this._stmt('SELECT * FROM admin_tokens WHERE token_hash = ? AND revoked_at IS NULL').get(hashApiKey(secret)) as Record<string, unknown> | undefined
    return row ? toAdminToken(row) : null
  }

  /** Like `touchKey`: at most once a minute per token. */
  touchAdminToken(id: string): void {
    const now = this._now()
    if (!this._shouldTouch(`token:${id}`, now)) return
    this._stmt('UPDATE admin_tokens SET last_used_at = ? WHERE id = ?').run(now, id)
  }

  revokeAdminToken(id: string): boolean {
    return this._stmt('UPDATE admin_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(this._now(), id).changes > 0
  }

  /** Revokes every token a member created (when they are disabled or lose admin); returns their ids. */
  revokeAdminTokensCreatedBy(memberId: string): string[] {
    const rows = this._stmt('SELECT id FROM admin_tokens WHERE created_by = ? AND revoked_at IS NULL').all(memberId) as Array<{ id: string }>
    const now = this._now()
    const revoke = this._stmt('UPDATE admin_tokens SET revoked_at = ? WHERE id = ?')
    this._db.transaction(() => { for (const row of rows) revoke.run(now, row.id) })()
    return rows.map((row) => row.id)
  }

  // ── Audit log ───────────────────────────────────────────────────────────

  /**
   * Appends one audit entry. Every mutating console action calls this:
   *
   *   deps.store.recordAudit({ actor, action, target, details, ip })
   *
   * `actor` comes from `auditActor(store, principal)` in console-api/access.ts
   * (`{ kind: 'cli', id: null }` from CLI commands), `ip` from
   * `clientIp(request)`. `details` must never contain secrets.
   */
  recordAudit(input: AuditInput): AuditRecord {
    const id = newId('aud')
    const at = this._now()
    this._stmt(`
      INSERT INTO audit_log (id, at, actor_kind, actor_id, actor_label, action, target_kind, target_id, target_label, details, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, at, input.actor.kind, input.actor.id, input.actor.label ?? null, input.action,
      input.target?.kind ?? null, input.target?.id ?? null, input.target?.label ?? null,
      JSON.stringify(input.details ?? {}), input.ip ?? null)
    return {
      id,
      at,
      actor: { kind: input.actor.kind, id: input.actor.id, label: input.actor.label ?? null },
      action: input.action,
      target: input.target ? { kind: input.target.kind, id: input.target.id, label: input.target.label ?? null } : null,
      details: input.details ?? {},
      ip: input.ip ?? null,
    }
  }

  /** Newest first. `before` is the opaque cursor returned as `nextBefore`. */
  listAudit(filter: { before?: string | null; limit?: number; actorId?: string | null; action?: string | null } = {}): { entries: AuditRecord[]; nextBefore: string | null } {
    const limit = Math.max(1, Math.min(500, Math.floor(filter.limit ?? 100)))
    const where: string[] = []
    const params: unknown[] = []
    const before = filter.before ? Number.parseInt(filter.before, 10) : NaN
    if (Number.isFinite(before)) { where.push('seq < ?'); params.push(before) }
    if (filter.actorId) { where.push('actor_id = ?'); params.push(filter.actorId) }
    if (filter.action) {
      // "key" matches "key" and "key.*"
      where.push("(action = ? OR action LIKE ? ESCAPE '\\')")
      params.push(filter.action, `${escapeLike(filter.action)}.%`)
    }
    const rows = this._stmt(`SELECT * FROM audit_log ${whereClause(where)} ORDER BY seq DESC LIMIT ?`)
      .all(...params, limit + 1) as Array<Record<string, unknown>>
    const page = rows.slice(0, limit)
    return {
      entries: page.map(toAudit),
      nextBefore: rows.length > limit ? String(page[page.length - 1]!['seq']) : null,
    }
  }

  // ── Settings ────────────────────────────────────────────────────────────

  /**
   * Settings are read on every request, so values are cached for a few
   * seconds. A write through this store clears its cache at once; a write by
   * another process (a CLI command) is seen within `SETTINGS_TTL_MS`.
   */
  getSetting<T>(key: string): T | null {
    const now = Date.now()
    let cached = this._settings.get(key)
    if (!cached || now - cached.at >= SETTINGS_TTL_MS || now < cached.at) {
      const row = this._stmt('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined
      cached = { raw: row?.value ?? null, at: now }
      this._settings.set(key, cached)
    }
    // Parsed per call so callers never share (and mutate) one object.
    return cached.raw === null ? null : parseJson<T | null>(cached.raw, null)
  }

  setSetting(key: string, value: unknown): void {
    this._settings.delete(key)
    if (value === null || value === undefined) {
      this._stmt('DELETE FROM settings WHERE key = ?').run(key)
      return
    }
    this._stmt('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value')
      .run(key, JSON.stringify(value))
  }
}

/** Column names a filter or grouping maps to in each table that carries usage. */
interface ScopeColumns {
  key: string
  workspace: string
  member: string
  model: string
  peer: string
  user: string
  time: string
}

const REQUEST_COLUMNS: ScopeColumns = {
  key: 'r.key_id', workspace: 'r.workspace_id', member: 'r.member_id', model: 'r.model', peer: 'r.seller_peer_id', user: 'r.end_user', time: 'r.started_at',
}
const LEDGER_COLUMNS: ScopeColumns = {
  key: 'l.key_id', workspace: 'l.workspace_id', member: 'l.member_id', model: 'l.model', peer: 'l.seller_peer_id', user: 'l.end_user', time: 'l.created_at',
}
const ROLLUP_COLUMNS: ScopeColumns = {
  key: 'u.key_id', workspace: 'u.workspace_id', member: 'u.member_id', model: 'u.model', peer: 'u.seller_peer_id', user: 'u.end_user', time: 'u.hour_start',
}

const HOUR_MS = 60 * 60 * 1000
const TOUCH_INTERVAL_MS = 60 * 1000
const MAX_TRACKED_TOUCHES = 10_000
const SETTINGS_TTL_MS = 5_000
const MAX_CACHED_STATEMENTS = 500
const MAX_ERROR_CODE = 100
const MAX_ERROR_MESSAGE = 500
/** A failed request: finished with an error status. One still in flight is not a failure. */
const FAILED_SQL = '(r.finished_at IS NOT NULL AND (r.status IS NULL OR r.status >= 400))'

/** WHERE clauses shared by request-log, rollup and ledger queries. */
function scopeSql(filter: UsageFilter, columns: ScopeColumns): { where: string[]; params: unknown[] } {
  const where: string[] = []
  const params: unknown[] = []
  if (filter.keyIds) { where.push(`${columns.key} IN (SELECT value FROM json_each(?))`); params.push(JSON.stringify(filter.keyIds)) }
  if (filter.keyId) { where.push(`${columns.key} = ?`); params.push(filter.keyId) }
  if (filter.workspaceId) { where.push(`${columns.workspace} = ?`); params.push(filter.workspaceId) }
  if (filter.memberId) { where.push(`${columns.member} = ?`); params.push(filter.memberId) }
  if (filter.model) { where.push(`${columns.model} = ?`); params.push(filter.model) }
  if (filter.from != null) { where.push(`${columns.time} >= ?`); params.push(filter.from) }
  if (filter.to != null) { where.push(`${columns.time} < ?`); params.push(filter.to) }
  return { where, params }
}

function whereClause(where: readonly string[]): string {
  return where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''
}

/** Escapes LIKE wildcards; the queries declare backslash as the escape character. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`)
}

/** The SQL a usage report groups by; one group ('all') without a grouping. */
function groupExpression(groupBy: UsageGroupBy | null, columns: ScopeColumns): string {
  if (!groupBy) return "'all'"
  if (groupBy === 'day') return `strftime('%Y-%m-%d', ${columns.time} / 1000, 'unixepoch')`
  if (groupBy === 'hour') return `strftime('%Y-%m-%dT%H', ${columns.time} / 1000, 'unixepoch')`
  return columns[groupBy]
}

/** Groupings whose groups are UTC time buckets (listed oldest first). */
export function isTimeGrouping(groupBy: UsageGroupBy): boolean {
  return groupBy === 'day' || groupBy === 'hour'
}

function emptyUsageTotals(): UsageTotalsRow {
  return { requests: 0, failedRequests: 0, spentUsdc: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0 }
}

/** The `spend_totals` / `spend_daily` row key of a budget scope. */
function budgetScopeRow(scope: BudgetScope): { kind: 'key' | 'member' | 'workspace'; id: string } {
  if ('keyId' in scope) return { kind: 'key', id: scope.keyId }
  if ('memberId' in scope) return { kind: 'member', id: scope.memberId }
  return { kind: 'workspace', id: scope.workspaceId }
}

function toKey(row: KeyRow): ApiKeyRecord {
  return {
    id: row.id,
    label: row.label,
    hint: row.key_hint,
    buyerIdentity: row.buyer_identity,
    workspaceId: row.workspace_id ?? DEFAULT_WORKSPACE_ID,
    ownerMemberId: row.owner_member_id,
    source: row.source,
    status: row.status,
    limits: rowLimits(row),
    routingPolicy: parsePolicy(row.routing_policy),
    ownerLimits: {
      daily: row.owner_daily_limit_usdc,
      weekly: row.owner_weekly_limit_usdc,
      monthly: row.owner_monthly_limit_usdc,
      total: row.owner_total_limit_usdc,
    },
    ownerRoutingPolicy: parsePolicy(row.owner_routing_policy),
    topupEnabled: row.topup_enabled === 1,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
  }
}

function toWorkspace(row: WorkspaceRow): WorkspaceRecord {
  return {
    id: row.id,
    name: row.name,
    buyerIdentity: row.buyer_identity,
    isDefault: row.is_default === 1,
    walletAddress: row.wallet_address,
    limits: rowLimits(row),
    routingPolicy: parsePolicy(row.routing_policy),
    orgRoutingPolicy: parsePolicy(row.org_routing_policy),
    createdAt: row.created_at,
  }
}

function toMember(row: MemberRow): MemberRecord {
  return {
    id: row.id,
    label: row.label,
    email: row.email,
    orgRole: row.org_role,
    status: row.status,
    limits: rowLimits(row),
    routingPolicy: parsePolicy(row.routing_policy),
    maxKeys: row.max_keys,
    createdAt: row.created_at,
  }
}

function toInvite(row: InviteRow): InviteRecord {
  return {
    id: row.id,
    memberId: row.member_id,
    label: row.label,
    email: row.email,
    orgRole: row.org_role,
    workspaces: parseJson(row.workspace_roles, []),
    createdBy: row.created_by,
    expiresAt: row.expires_at,
    usedAt: row.used_at,
    createdAt: row.created_at,
  }
}

function toPeerList(row: Record<string, unknown>): PeerListRecord {
  return {
    id: row['id'] as string,
    name: row['name'] as string,
    description: row['description'] as string | null,
    peerIds: parseJson(row['peer_ids'] as string, []),
    createdAt: row['created_at'] as number,
  }
}

function toPreset(row: Record<string, unknown>): PresetRecord {
  return {
    id: row['id'] as string,
    slug: row['slug'] as string,
    name: row['name'] as string,
    workspaceId: row['workspace_id'] as string | null,
    model: row['model'] as string,
    routingPolicy: parsePolicy(row['routing_policy'] as string | null),
    systemPrompt: row['system_prompt'] as string | null,
    params: parseJson(row['params'] as string, {}),
    createdAt: row['created_at'] as number,
  }
}

function toAdminToken(row: Record<string, unknown>): AdminTokenRecord {
  return {
    id: row['id'] as string,
    label: row['label'] as string,
    hint: row['hint'] as string,
    scope: row['scope'] as 'admin' | 'read',
    createdBy: row['created_by'] as string | null,
    expiresAt: (row['expires_at'] as number | null) ?? null,
    createdAt: row['created_at'] as number,
    lastUsedAt: row['last_used_at'] as number | null,
    revokedAt: row['revoked_at'] as number | null,
  }
}

function toAudit(row: Record<string, unknown>): AuditRecord {
  const targetKind = row['target_kind'] as string | null
  return {
    id: row['id'] as string,
    at: row['at'] as number,
    actor: { kind: row['actor_kind'] as AuditActorKind, id: row['actor_id'] as string | null, label: row['actor_label'] as string | null },
    action: row['action'] as string,
    target: targetKind ? { kind: targetKind, id: row['target_id'] as string | null, label: row['target_label'] as string | null } : null,
    details: parseJson(row['details'] as string, {}),
    ip: row['ip'] as string | null,
  }
}
