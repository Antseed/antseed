import { DEFAULT_BUYER_IDENTITY } from '@antseed/node'
import Database from 'better-sqlite3'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { generateApiKey, hashApiKey, apiKeyHint, newKeyId } from './keys.js'
import { LIMIT_PERIODS, periodStart, type PeriodSpend, type SpendLimits } from './limits.js'

export type ApiKeySource = 'created' | 'tunnel-env'
export type ApiKeyStatus = 'active' | 'revoked'

export interface ApiKeyRecord {
  id: string
  label: string
  hint: string
  /** Buyer identity (wallet) that pays for this key's requests. */
  buyerIdentity: string
  source: ApiKeySource
  status: ApiKeyStatus
  limits: SpendLimits
  /** Whether the key holder may fund the key's wallet with x402 top-ups. */
  topupEnabled: boolean
  expiresAt: number | null
  createdAt: number
  revokedAt: number | null
  lastUsedAt: number | null
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
}

export interface GatewayRequestStart {
  tag: string
  keyId: string
  buyerIdentity: string
  method: string
  path: string
  model: string | null
  startedAt: number
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

type KeyRow = {
  id: string
  label: string
  key_hint: string
  buyer_identity: string
  source: ApiKeySource
  status: ApiKeyStatus
  daily_limit_usdc: number | null
  monthly_limit_usdc: number | null
  total_limit_usdc: number | null
  topup_enabled: number
  expires_at: number | null
  created_at: number
  revoked_at: number | null
  last_used_at: number | null
}

const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE api_keys (
    id TEXT PRIMARY KEY,
    label TEXT NOT NULL,
    key_hash TEXT NOT NULL UNIQUE,
    key_hint TEXT NOT NULL,
    buyer_identity TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'created',
    status TEXT NOT NULL DEFAULT 'active',
    daily_limit_usdc INTEGER,
    monthly_limit_usdc INTEGER,
    total_limit_usdc INTEGER,
    expires_at INTEGER,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER,
    last_used_at INTEGER
  );
  CREATE TABLE gateway_requests (
    tag TEXT PRIMARY KEY,
    key_id TEXT NOT NULL,
    buyer_identity TEXT NOT NULL,
    method TEXT NOT NULL,
    path TEXT NOT NULL,
    model TEXT,
    status INTEGER,
    buyer_request_id TEXT,
    started_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX gateway_requests_key_time ON gateway_requests(key_id, started_at);
  CREATE TABLE ledger_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('spend', 'credit')),
    key_id TEXT NOT NULL,
    buyer_identity TEXT NOT NULL,
    amount_usdc INTEGER NOT NULL,
    external_ref TEXT NOT NULL UNIQUE,
    request_tag TEXT,
    seller_peer_id TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    cached_input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    note TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX ledger_entries_key_time ON ledger_entries(key_id, kind, created_at);
  `,
  `
  ALTER TABLE api_keys ADD COLUMN topup_enabled INTEGER NOT NULL DEFAULT 0;
  `,
]

export function gatewayDir(dataDir: string): string {
  return join(dataDir, 'gateway')
}

/**
 * Durable state for the API-key gateway: keys, request log and the per-key
 * ledger. SQLite in WAL mode so `antseed gateway key …`
 * commands can change keys while a gateway process is serving them.
 */
export class GatewayStore {
  private readonly _db: Database.Database

  constructor(dataDir: string, private readonly _now: () => number = () => Date.now()) {
    mkdirSync(gatewayDir(dataDir), { recursive: true })
    this._db = new Database(join(gatewayDir(dataDir), 'gateway.db'))
    this._db.pragma('journal_mode = WAL')
    this._db.pragma('busy_timeout = 5000')
    this._db.pragma('foreign_keys = ON')
    this._migrate()
  }

  close(): void {
    this._db.close()
  }

  private _migrate(): void {
    const version = this._db.pragma('user_version', { simple: true }) as number
    for (let index = version; index < MIGRATIONS.length; index += 1) {
      this._db.transaction(() => {
        this._db.exec(MIGRATIONS[index]!)
        this._db.pragma(`user_version = ${index + 1}`)
      })()
    }
  }

  // ── Keys ────────────────────────────────────────────────────────────────

  createKey(input: {
    label: string
    buyerIdentity: string
    limits: SpendLimits
    expiresAt: number | null
    topupEnabled?: boolean
  }): { key: ApiKeyRecord; secret: string } {
    const generated = generateApiKey()
    const id = newKeyId()
    this._db.prepare(`
      INSERT INTO api_keys (id, label, key_hash, key_hint, buyer_identity, source, daily_limit_usdc, monthly_limit_usdc, total_limit_usdc, topup_enabled, expires_at, created_at)
      VALUES (?, ?, ?, ?, ?, 'created', ?, ?, ?, ?, ?, ?)
    `).run(
      id, input.label, generated.hash, generated.hint, input.buyerIdentity,
      input.limits.daily, input.limits.monthly, input.limits.total, input.topupEnabled ? 1 : 0, input.expiresAt, this._now(),
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
    const existing = this._db.prepare("SELECT id FROM api_keys WHERE source = 'tunnel-env'").get() as { id: string } | undefined
    if (existing) {
      this._db.prepare("UPDATE api_keys SET key_hash = ?, key_hint = ?, status = 'active', revoked_at = NULL WHERE id = ?")
        .run(hash, apiKeyHint(secret), existing.id)
      return this.getKey(existing.id)!
    }
    const id = newKeyId()
    this._db.prepare(`
      INSERT INTO api_keys (id, label, key_hash, key_hint, buyer_identity, source, created_at)
      VALUES (?, 'Tunnel key', ?, ?, ?, 'tunnel-env', ?)
    `).run(id, hash, apiKeyHint(secret), DEFAULT_BUYER_IDENTITY, this._now())
    return this.getKey(id)!
  }

  /**
   * Revokes the ANTSEED_TUNNEL_API_KEY key once the tunnel starts without the
   * env var, so unsetting it retires the shared unlimited key. Returns the
   * revoked key, or null when there was no active one.
   */
  retireEnvironmentKey(): ApiKeyRecord | null {
    const existing = this._db.prepare("SELECT id FROM api_keys WHERE source = 'tunnel-env' AND status = 'active'").get() as { id: string } | undefined
    return existing ? this.revokeKey(existing.id) : null
  }

  findKeyBySecret(secret: string): ApiKeyRecord | null {
    const row = this._db.prepare('SELECT * FROM api_keys WHERE key_hash = ?').get(hashApiKey(secret)) as KeyRow | undefined
    return row ? toKey(row) : null
  }

  getKey(id: string): ApiKeyRecord | null {
    const row = this._db.prepare('SELECT * FROM api_keys WHERE id = ?').get(id) as KeyRow | undefined
    return row ? toKey(row) : null
  }

  listKeys(): ApiKeyRecord[] {
    const rows = this._db.prepare('SELECT * FROM api_keys ORDER BY created_at, id').all() as KeyRow[]
    return rows.map(toKey)
  }

  countActiveKeys(): number {
    return (this._db.prepare("SELECT COUNT(*) AS count FROM api_keys WHERE status = 'active'").get() as { count: number }).count
  }

  setLimits(id: string, limits: Partial<SpendLimits>): ApiKeyRecord {
    const key = this.getKey(id)
    if (!key) throw new Error(`Unknown key "${id}".`)
    const next = { ...key.limits, ...limits }
    this._db.prepare('UPDATE api_keys SET daily_limit_usdc = ?, monthly_limit_usdc = ?, total_limit_usdc = ? WHERE id = ?')
      .run(next.daily, next.monthly, next.total, id)
    return this.getKey(id)!
  }

  setTopupEnabled(id: string, enabled: boolean): ApiKeyRecord {
    const result = this._db.prepare('UPDATE api_keys SET topup_enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id)
    if (result.changes === 0) throw new Error(`Unknown key "${id}".`)
    return this.getKey(id)!
  }

  revokeKey(id: string): ApiKeyRecord {
    const result = this._db.prepare("UPDATE api_keys SET status = 'revoked', revoked_at = ? WHERE id = ? AND status = 'active'")
      .run(this._now(), id)
    if (result.changes === 0 && !this.getKey(id)) throw new Error(`Unknown key "${id}".`)
    return this.getKey(id)!
  }

  touchKey(id: string): void {
    this._db.prepare('UPDATE api_keys SET last_used_at = ? WHERE id = ?').run(this._now(), id)
  }

  // ── Requests ────────────────────────────────────────────────────────────

  startRequest(input: GatewayRequestStart): void {
    this._db.prepare(`
      INSERT INTO gateway_requests (tag, key_id, buyer_identity, method, path, model, started_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(input.tag, input.keyId, input.buyerIdentity, input.method, input.path, input.model, input.startedAt)
  }

  finishRequest(tag: string, result: { status: number; buyerRequestId: string | null }): void {
    this._db.prepare('UPDATE gateway_requests SET status = ?, buyer_request_id = ?, finished_at = ? WHERE tag = ?')
      .run(result.status, result.buyerRequestId, this._now(), tag)
  }

  findRequest(tag: string): { keyId: string; buyerIdentity: string } | null {
    const row = this._db.prepare('SELECT key_id, buyer_identity FROM gateway_requests WHERE tag = ?').get(tag) as
      { key_id: string; buyer_identity: string } | undefined
    return row ? { keyId: row.key_id, buyerIdentity: row.buyer_identity } : null
  }

  // ── Ledger ──────────────────────────────────────────────────────────────

  /** Returns false when the entry was already recorded (same externalRef). */
  recordLedgerEntry(entry: LedgerEntryInput): boolean {
    if (!Number.isSafeInteger(entry.amountUsdc) || entry.amountUsdc < 0) {
      throw new Error('Ledger amounts are non-negative integer USDC base units; the kind sets the sign.')
    }
    const signed = entry.kind === 'spend' ? -entry.amountUsdc : entry.amountUsdc
    const result = this._db.prepare(`
      INSERT OR IGNORE INTO ledger_entries
        (kind, key_id, buyer_identity, amount_usdc, external_ref, request_tag, seller_peer_id,
         input_tokens, cached_input_tokens, output_tokens, note, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      entry.kind, entry.keyId, entry.buyerIdentity, signed, entry.externalRef,
      entry.requestTag ?? null, entry.sellerPeerId ?? null,
      entry.inputTokens ?? 0, entry.cachedInputTokens ?? 0, entry.outputTokens ?? 0,
      entry.note ?? null, entry.createdAt,
    )
    return result.changes > 0
  }

  periodSpend(keyId: string, now = this._now()): PeriodSpend {
    const statement = this._db.prepare(
      "SELECT COALESCE(-SUM(amount_usdc), 0) AS spent FROM ledger_entries WHERE key_id = ? AND kind = 'spend' AND created_at >= ?",
    )
    const spend = {} as PeriodSpend
    for (const period of LIMIT_PERIODS) {
      spend[period] = (statement.get(keyId, periodStart(period, now)) as { spent: number }).spent
    }
    return spend
  }

  usageStats(keyId: string, since = 0): KeyUsageStats {
    const requests = this._db.prepare(`
      SELECT COUNT(*) AS requests,
             COALESCE(SUM(CASE WHEN status IS NULL OR status >= 400 THEN 1 ELSE 0 END), 0) AS failed
      FROM gateway_requests WHERE key_id = ? AND started_at >= ?
    `).get(keyId, since) as { requests: number; failed: number }
    const ledger = this._db.prepare(`
      SELECT COALESCE(-SUM(CASE WHEN kind = 'spend' THEN amount_usdc ELSE 0 END), 0) AS spent,
             COALESCE(SUM(CASE WHEN kind = 'credit' THEN amount_usdc ELSE 0 END), 0) AS credited,
             COALESCE(SUM(input_tokens), 0) AS input_tokens,
             COALESCE(SUM(cached_input_tokens), 0) AS cached_input_tokens,
             COALESCE(SUM(output_tokens), 0) AS output_tokens
      FROM ledger_entries WHERE key_id = ? AND created_at >= ?
    `).get(keyId, since) as { spent: number; credited: number; input_tokens: number; cached_input_tokens: number; output_tokens: number }
    return {
      requests: requests.requests,
      failedRequests: requests.failed,
      spentUsdc: ledger.spent,
      creditedUsdc: ledger.credited,
      inputTokens: ledger.input_tokens,
      cachedInputTokens: ledger.cached_input_tokens,
      outputTokens: ledger.output_tokens,
    }
  }
}

function toKey(row: KeyRow): ApiKeyRecord {
  return {
    id: row.id,
    label: row.label,
    hint: row.key_hint,
    buyerIdentity: row.buyer_identity,
    source: row.source,
    status: row.status,
    limits: {
      daily: row.daily_limit_usdc,
      monthly: row.monthly_limit_usdc,
      total: row.total_limit_usdc,
    },
    topupEnabled: row.topup_enabled === 1,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
  }
}
