import type Database from 'better-sqlite3'
import { createHash, randomBytes } from 'node:crypto'

/**
 * Auth tables share the gateway database but track their own schema version.
 * Append-only once shipped; v1 has not shipped yet, so columns still go
 * straight into it.
 */
const MIGRATIONS: readonly string[] = [
  `
  CREATE TABLE auth_sessions (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('member', 'key')),
    member_id TEXT,
    key_id TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    user_agent TEXT,
    ip TEXT,
    -- When the session's sign-in happened (a passkey, wallet or SSO proof);
    -- sensitive actions need a recent one.
    authenticated_at INTEGER,
    -- Which credential proved that sign-in, so a sensitive action can insist
    -- on a proof other than the credential it concerns.
    authenticated_credential_id TEXT
  );
  CREATE INDEX auth_sessions_member ON auth_sessions(member_id);
  CREATE INDEX auth_sessions_key ON auth_sessions(key_id);
  CREATE TABLE auth_credentials (
    id TEXT PRIMARY KEY,
    member_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('passkey', 'wallet', 'oidc')),
    label TEXT NOT NULL,
    webauthn_id TEXT UNIQUE,
    public_key BLOB,
    counter INTEGER,
    transports TEXT,
    wallet_address TEXT UNIQUE,
    oidc_issuer TEXT,
    oidc_subject TEXT,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    UNIQUE (oidc_issuer, oidc_subject)
  );
  CREATE INDEX auth_credentials_member ON auth_credentials(member_id);
  CREATE TABLE auth_enrollments (
    token_hash TEXT PRIMARY KEY,
    member_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE auth_setup_tokens (
    token_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    used_at INTEGER
  );
  CREATE TABLE auth_challenges (
    challenge TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('register', 'login')),
    member_id TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE auth_wallet_nonces (
    nonce TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE auth_oidc_states (
    state_hash TEXT PRIMARY KEY,
    nonce TEXT NOT NULL,
    code_verifier TEXT NOT NULL,
    enrollment_hash TEXT,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE auth_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  `,
]

export const SESSION_IDLE_MS = 12 * 60 * 60 * 1000
export const SESSION_ABSOLUTE_MS = 14 * 24 * 60 * 60 * 1000
const ENROLLMENT_TTL_MS = 15 * 60 * 1000
export const SETUP_TOKEN_TTL_MS = 60 * 60 * 1000
/** How recent a sign-in must be for sensitive actions (operator authorizations). */
export const FRESH_SIGN_IN_MS = 5 * 60 * 1000
/**
 * A wallet credential must be this old before it can be authorized as a
 * workspace wallet's operator: a stolen session that links its own wallet
 * can't turn it into an operator before the owner notices (the add is audited).
 */
export const OPERATOR_WALLET_MIN_AGE_MS = 24 * 60 * 60 * 1000
/** Unauthenticated endpoints write challenges and nonces; keep at most this many live rows of each. */
export const MAX_PENDING_TICKETS = 5000
const CHALLENGE_TTL_MS = 5 * 60 * 1000
export const WALLET_NONCE_TTL_MS = 10 * 60 * 1000
export const OIDC_STATE_TTL_MS = 10 * 60 * 1000
/** Sessions record activity at most this often, so reads don't write on every request. */
const SESSION_TOUCH_MS = 60 * 1000

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url')
}

export interface SessionRow {
  id: string
  kind: 'member' | 'key'
  member_id: string | null
  key_id: string | null
  created_at: number
  expires_at: number
  last_seen_at: number
  authenticated_at: number | null
  authenticated_credential_id: string | null
}

export interface CredentialRow {
  id: string
  member_id: string
  kind: 'passkey' | 'wallet' | 'oidc'
  label: string
  webauthn_id: string | null
  public_key: Buffer | null
  counter: number | null
  transports: string | null
  wallet_address: string | null
  oidc_issuer: string | null
  oidc_subject: string | null
  created_at: number
  last_used_at: number | null
}

export type NewCredential =
  | { kind: 'passkey'; label: string; webauthnId: string; publicKey: Uint8Array; counter: number; transports: string[] }
  | { kind: 'wallet'; label: string; address: string }
  | { kind: 'oidc'; label: string; issuer: string; subject: string }

/** Auth's own rows: sessions, credentials and short-lived login tickets. Secrets are stored as SHA-256 hashes. */
export class AuthDb {
  constructor(private readonly _db: Database.Database, private readonly _now: () => number) {
    this._migrate()
  }

  /**
   * The version is read and bumped inside one IMMEDIATE transaction (it holds
   * the write lock), so processes opening the database at once never apply a
   * migration twice.
   */
  private _migrate(): void {
    const current = this._db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'auth_schema_version'").get()
      ? (this._db.prepare('SELECT version FROM auth_schema_version').get() as { version: number } | undefined)?.version
      : undefined
    if (current !== undefined && current >= MIGRATIONS.length) return
    this._db.transaction(() => {
      this._db.exec('CREATE TABLE IF NOT EXISTS auth_schema_version (version INTEGER NOT NULL)')
      const row = this._db.prepare('SELECT version FROM auth_schema_version').get() as { version: number } | undefined
      if (!row) this._db.prepare('INSERT INTO auth_schema_version (version) VALUES (0)').run()
      for (let index = row?.version ?? 0; index < MIGRATIONS.length; index += 1) {
        this._db.exec(MIGRATIONS[index]!)
        this._db.prepare('UPDATE auth_schema_version SET version = ?').run(index + 1)
      }
    }).immediate()
  }

  transaction<T>(fn: () => T): T {
    return this._db.transaction(fn)()
  }

  /** Drops expired tickets and sessions; cheap enough to run on every login. */
  sweep(): void {
    const now = this._now()
    this._db.prepare('DELETE FROM auth_sessions WHERE expires_at <= ? OR last_seen_at <= ?').run(now, now - SESSION_IDLE_MS)
    for (const table of ['auth_enrollments', 'auth_challenges', 'auth_wallet_nonces', 'auth_oidc_states']) {
      this._db.prepare(`DELETE FROM ${table} WHERE expires_at <= ?`).run(now)
    }
  }

  // ── Meta ────────────────────────────────────────────────────────────────

  getMeta(key: string): string | null {
    const row = this._db.prepare('SELECT value FROM auth_meta WHERE key = ?').get(key) as { value: string } | undefined
    return row?.value ?? null
  }

  setMeta(key: string, value: string): void {
    this._db.prepare('INSERT INTO auth_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
  }

  // ── Sessions ────────────────────────────────────────────────────────────

  /** Returns the cookie value; only its hash is stored. */
  createSession(
    principal: { kind: 'member'; memberId: string } | { kind: 'key'; keyId: string },
    client: { userAgent: string | null; ip: string | null },
    credentialId: string | null = null,
  ): string {
    const secret = randomToken(32)
    const now = this._now()
    this._db.prepare(`
      INSERT INTO auth_sessions (id, kind, member_id, key_id, created_at, expires_at, last_seen_at, user_agent, ip, authenticated_at, authenticated_credential_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      sha256Hex(secret), principal.kind,
      principal.kind === 'member' ? principal.memberId : null,
      principal.kind === 'key' ? principal.keyId : null,
      now, now + SESSION_ABSOLUTE_MS, now, client.userAgent?.slice(0, 300) ?? null, client.ip, now, credentialId,
    )
    return secret
  }

  /** Resolves a live session by cookie value and records activity; null when unknown, idle or expired. */
  findSession(secret: string): SessionRow | null {
    const id = sha256Hex(secret)
    const row = this._db.prepare('SELECT * FROM auth_sessions WHERE id = ?').get(id) as SessionRow | undefined
    if (!row) return null
    const now = this._now()
    if (row.expires_at <= now || row.last_seen_at + SESSION_IDLE_MS <= now) {
      this.deleteSession(id)
      return null
    }
    if (now - row.last_seen_at >= SESSION_TOUCH_MS) {
      this._db.prepare('UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?').run(now, id)
      row.last_seen_at = now
    }
    return row
  }

  deleteSession(id: string): void {
    this._db.prepare('DELETE FROM auth_sessions WHERE id = ?').run(id)
  }

  /** Records a new sign-in proof on an existing session (re-authentication); false when the session is gone. */
  markAuthenticated(id: string, credentialId: string | null): boolean {
    return this._db.prepare('UPDATE auth_sessions SET authenticated_at = ?, authenticated_credential_id = ? WHERE id = ?')
      .run(this._now(), credentialId, id).changes > 0
  }

  deleteSessionBySecret(secret: string): void {
    this.deleteSession(sha256Hex(secret))
  }

  deleteMemberSessions(memberId: string): number {
    return this._db.prepare('DELETE FROM auth_sessions WHERE member_id = ?').run(memberId).changes
  }

  /** Ends a member's sessions except `keepId` (the caller's own, when they act on themselves). */
  deleteMemberSessionsExcept(memberId: string, keepId: string | null): number {
    if (!keepId) return this.deleteMemberSessions(memberId)
    return this._db.prepare('DELETE FROM auth_sessions WHERE member_id = ? AND id != ?').run(memberId, keepId).changes
  }

  deleteKeySessions(keyId: string): number {
    return this._db.prepare('DELETE FROM auth_sessions WHERE key_id = ?').run(keyId).changes
  }

  // ── Credentials ─────────────────────────────────────────────────────────

  addCredential(memberId: string, credential: NewCredential): CredentialRow {
    const id = `cred_${randomBytes(8).toString('hex')}`
    const now = this._now()
    const insert = this._db.prepare(`
      INSERT INTO auth_credentials
        (id, member_id, kind, label, webauthn_id, public_key, counter, transports, wallet_address, oidc_issuer, oidc_subject, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    if (credential.kind === 'passkey') {
      insert.run(id, memberId, 'passkey', credential.label, credential.webauthnId, Buffer.from(credential.publicKey), credential.counter,
        JSON.stringify(credential.transports), null, null, null, now, now)
    } else if (credential.kind === 'wallet') {
      insert.run(id, memberId, 'wallet', credential.label, null, null, null, null, credential.address.toLowerCase(), null, null, now, now)
    } else {
      insert.run(id, memberId, 'oidc', credential.label, null, null, null, null, null, credential.issuer, credential.subject, now, now)
    }
    return this.getCredential(id)!
  }

  getCredential(id: string): CredentialRow | null {
    return (this._db.prepare('SELECT * FROM auth_credentials WHERE id = ?').get(id) as CredentialRow | undefined) ?? null
  }

  listCredentials(memberId: string): CredentialRow[] {
    return this._db.prepare('SELECT * FROM auth_credentials WHERE member_id = ? ORDER BY created_at, id').all(memberId) as CredentialRow[]
  }

  countCredentials(memberId: string): number {
    return (this._db.prepare('SELECT COUNT(*) AS count FROM auth_credentials WHERE member_id = ?').get(memberId) as { count: number }).count
  }

  deleteCredential(memberId: string, id: string): boolean {
    return this._db.prepare('DELETE FROM auth_credentials WHERE id = ? AND member_id = ?').run(id, memberId).changes > 0
  }

  findPasskey(webauthnId: string): CredentialRow | null {
    return (this._db.prepare("SELECT * FROM auth_credentials WHERE kind = 'passkey' AND webauthn_id = ?").get(webauthnId) as CredentialRow | undefined) ?? null
  }

  findWallet(address: string): CredentialRow | null {
    return (this._db.prepare("SELECT * FROM auth_credentials WHERE kind = 'wallet' AND wallet_address = ?").get(address.toLowerCase()) as CredentialRow | undefined) ?? null
  }

  findOidc(issuer: string, subject: string): CredentialRow | null {
    return (this._db.prepare("SELECT * FROM auth_credentials WHERE kind = 'oidc' AND oidc_issuer = ? AND oidc_subject = ?").get(issuer, subject) as CredentialRow | undefined) ?? null
  }

  touchCredential(id: string, counter?: number): void {
    if (counter === undefined) {
      this._db.prepare('UPDATE auth_credentials SET last_used_at = ? WHERE id = ?').run(this._now(), id)
    } else {
      this._db.prepare('UPDATE auth_credentials SET last_used_at = ?, counter = ? WHERE id = ?').run(this._now(), counter, id)
    }
  }

  // ── Enrollments ─────────────────────────────────────────────────────────

  createEnrollment(memberId: string): string {
    const secret = randomToken(32)
    const now = this._now()
    this._db.prepare('INSERT INTO auth_enrollments (token_hash, member_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(sha256Hex(secret), memberId, now, now + ENROLLMENT_TTL_MS)
    return secret
  }

  /** Member id of a live enrollment, without consuming it. */
  peekEnrollment(secret: string): string | null {
    const row = this._db.prepare('SELECT member_id, expires_at FROM auth_enrollments WHERE token_hash = ?').get(sha256Hex(secret)) as
      { member_id: string; expires_at: number } | undefined
    return row && row.expires_at > this._now() ? row.member_id : null
  }

  consumeEnrollment(secret: string): string | null {
    const memberId = this.peekEnrollment(secret)
    if (memberId) this._db.prepare('DELETE FROM auth_enrollments WHERE token_hash = ?').run(sha256Hex(secret))
    return memberId
  }

  // ── Setup tokens ────────────────────────────────────────────────────────

  /** Only the newest setup link works: issuing one retires unused earlier ones. */
  createSetupToken(): string {
    const secret = randomToken(32)
    const now = this._now()
    this.transaction(() => {
      this._db.prepare('DELETE FROM auth_setup_tokens WHERE used_at IS NULL').run()
      this._db.prepare('INSERT INTO auth_setup_tokens (token_hash, created_at, expires_at) VALUES (?, ?, ?)')
        .run(sha256Hex(secret), now, now + SETUP_TOKEN_TTL_MS)
    })
    return secret
  }

  consumeSetupToken(secret: string): boolean {
    const now = this._now()
    return this._db.prepare('UPDATE auth_setup_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?')
      .run(now, sha256Hex(secret), now).changes > 0
  }

  // ── WebAuthn challenges ─────────────────────────────────────────────────

  /** Drops expired rows of a ticket table, then the oldest ones beyond the cap. */
  private _capTickets(table: 'auth_challenges' | 'auth_wallet_nonces', key: 'challenge' | 'nonce'): void {
    const now = this._now()
    this._db.prepare(`DELETE FROM ${table} WHERE expires_at <= ?`).run(now)
    const count = (this._db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count
    if (count >= MAX_PENDING_TICKETS) {
      this._db.prepare(`DELETE FROM ${table} WHERE ${key} IN (SELECT ${key} FROM ${table} ORDER BY created_at LIMIT ?)`).run(count - MAX_PENDING_TICKETS + 1)
    }
  }

  saveChallenge(challenge: string, kind: 'register' | 'login', memberId: string | null): void {
    this._capTickets('auth_challenges', 'challenge')
    const now = this._now()
    this._db.prepare('INSERT INTO auth_challenges (challenge, kind, member_id, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(challenge, kind, memberId, now, now + CHALLENGE_TTL_MS)
  }

  /** Single use: the row is deleted whether or not the response then verifies. */
  takeChallenge(challenge: string, kind: 'register' | 'login'): { memberId: string | null } | null {
    const row = this._db.prepare('SELECT member_id, expires_at FROM auth_challenges WHERE challenge = ? AND kind = ?').get(challenge, kind) as
      { member_id: string | null; expires_at: number } | undefined
    if (!row) return null
    this._db.prepare('DELETE FROM auth_challenges WHERE challenge = ?').run(challenge)
    return row.expires_at > this._now() ? { memberId: row.member_id } : null
  }

  // ── Wallet nonces ───────────────────────────────────────────────────────

  saveWalletNonce(nonce: string, address: string, message: string, expiresAt: number): void {
    this._capTickets('auth_wallet_nonces', 'nonce')
    this._db.prepare('INSERT INTO auth_wallet_nonces (nonce, address, message, created_at, expires_at) VALUES (?, ?, ?, ?, ?)')
      .run(nonce, address.toLowerCase(), message, this._now(), expiresAt)
  }

  takeWalletNonce(nonce: string): { address: string; message: string } | null {
    const row = this._db.prepare('SELECT address, message, expires_at FROM auth_wallet_nonces WHERE nonce = ?').get(nonce) as
      { address: string; message: string; expires_at: number } | undefined
    if (!row) return null
    this._db.prepare('DELETE FROM auth_wallet_nonces WHERE nonce = ?').run(nonce)
    return row.expires_at > this._now() ? { address: row.address, message: row.message } : null
  }

  // ── OIDC states ─────────────────────────────────────────────────────────

  saveOidcState(state: string, input: { nonce: string; codeVerifier: string; enrollment: string | null }): void {
    const now = this._now()
    this._db.prepare('INSERT INTO auth_oidc_states (state_hash, nonce, code_verifier, enrollment_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(sha256Hex(state), input.nonce, input.codeVerifier, input.enrollment === null ? null : sha256Hex(input.enrollment), now, now + OIDC_STATE_TTL_MS)
  }

  takeOidcState(state: string): { nonce: string; codeVerifier: string; enrollmentHash: string | null } | null {
    const hash = sha256Hex(state)
    const row = this._db.prepare('SELECT nonce, code_verifier, enrollment_hash, expires_at FROM auth_oidc_states WHERE state_hash = ?').get(hash) as
      { nonce: string; code_verifier: string; enrollment_hash: string | null; expires_at: number } | undefined
    if (!row) return null
    this._db.prepare('DELETE FROM auth_oidc_states WHERE state_hash = ?').run(hash)
    return row.expires_at > this._now() ? { nonce: row.nonce, codeVerifier: row.code_verifier, enrollmentHash: row.enrollment_hash } : null
  }

  /** Consumes an enrollment by its stored hash (the OIDC state carries the hash, not the secret). */
  consumeEnrollmentHash(hash: string): string | null {
    const row = this._db.prepare('SELECT member_id, expires_at FROM auth_enrollments WHERE token_hash = ?').get(hash) as
      { member_id: string; expires_at: number } | undefined
    if (!row) return null
    this._db.prepare('DELETE FROM auth_enrollments WHERE token_hash = ?').run(hash)
    return row.expires_at > this._now() ? row.member_id : null
  }

  // ── Management tokens (table owned by gateway-core) ─────────────────────

  private _adminColumns: Set<string> | null = null

  /** Looks up `admin_tokens` structurally; null when the table doesn't exist yet or the token is unknown/revoked. */
  findAdminToken(secret: string): { id: string; scope: 'admin' | 'read' } | null {
    if (!this._adminColumns) {
      const exists = this._db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'admin_tokens'").get()
      if (!exists) return null
      const columns = this._db.prepare('PRAGMA table_info(admin_tokens)').all() as Array<{ name: string }>
      this._adminColumns = new Set(columns.map((column) => column.name))
    }
    const columns = this._adminColumns
    if (!columns.has('token_hash')) return null
    const row = this._db.prepare('SELECT * FROM admin_tokens WHERE token_hash = ?').get(sha256Hex(secret)) as Record<string, unknown> | undefined
    if (!row) return null
    if (columns.has('revoked_at') && row.revoked_at !== null) return null
    if (columns.has('revoked') && Number(row.revoked) !== 0) return null
    if (columns.has('status') && row.status !== 'active') return null
    if (columns.has('expires_at') && typeof row.expires_at === 'number' && row.expires_at <= this._now()) return null
    if (columns.has('created_by') && typeof row.created_by === 'string' && !creatorIsAdmin(this._db, row.created_by)) return null
    const scope = row.scope === 'admin' ? 'admin' : 'read'
    if (columns.has('last_used_at')) {
      this._db.prepare('UPDATE admin_tokens SET last_used_at = ? WHERE id = ?').run(this._now(), row.id)
    }
    return { id: String(row.id), scope }
  }
}

/** Whether a member is still an active owner or admin (management tokens die with the role). */
function creatorIsAdmin(db: Database.Database, memberId: string): boolean {
  try {
    const row = db.prepare('SELECT org_role, status FROM members WHERE id = ?').get(memberId) as { org_role: string; status: string } | undefined
    return Boolean(row && row.status === 'active' && (row.org_role === 'owner' || row.org_role === 'admin'))
  } catch {
    return false
  }
}

/**
 * When the sign-in behind a console session happened; null for unknown
 * sessions (or Cloudflare Access principals, which have no session row).
 * Reads auth's table directly so route modules need no auth object.
 */
export function sessionAuthenticatedAt(db: Database.Database, sessionId: string): number | null {
  try {
    const row = db.prepare('SELECT authenticated_at, created_at FROM auth_sessions WHERE id = ?').get(sessionId) as
      { authenticated_at: number | null; created_at: number } | undefined
    return row ? row.authenticated_at ?? row.created_at : null
  } catch {
    return null
  }
}

/** The sign-in behind a console session: when it happened and with which credential (null: unknown, e.g. older sessions). */
export function sessionSignIn(db: Database.Database, sessionId: string): { authenticatedAt: number; credentialId: string | null } | null {
  try {
    const row = db.prepare('SELECT authenticated_at, created_at, authenticated_credential_id FROM auth_sessions WHERE id = ?').get(sessionId) as
      { authenticated_at: number | null; created_at: number; authenticated_credential_id: string | null } | undefined
    return row ? { authenticatedAt: row.authenticated_at ?? row.created_at, credentialId: row.authenticated_credential_id } : null
  } catch {
    return null
  }
}

/** A member's wallet credentials (lower-case addresses) with when each was added, plus how many credentials they have in all. */
export function memberWalletCredentials(db: Database.Database, memberId: string): { wallets: Array<{ id: string; address: string; createdAt: number }>; total: number } {
  try {
    const rows = db.prepare('SELECT id, kind, wallet_address, created_at FROM auth_credentials WHERE member_id = ?').all(memberId) as
      Array<{ id: string; kind: string; wallet_address: string | null; created_at: number }>
    return {
      wallets: rows.filter((row) => row.kind === 'wallet' && row.wallet_address)
        .map((row) => ({ id: row.id, address: row.wallet_address!.toLowerCase(), createdAt: row.created_at })),
      total: rows.length,
    }
  } catch {
    return { wallets: [], total: 0 }
  }
}

/** Lower-case addresses of the wallets a member has proven (SIWE) as sign-in methods. */
export function memberWalletAddresses(db: Database.Database, memberId: string): string[] {
  try {
    const rows = db.prepare("SELECT wallet_address FROM auth_credentials WHERE member_id = ? AND kind = 'wallet' AND wallet_address IS NOT NULL").all(memberId) as
      Array<{ wallet_address: string }>
    return rows.map((row) => row.wallet_address.toLowerCase())
  } catch {
    return []
  }
}
