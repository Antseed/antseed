import type Database from 'better-sqlite3'
import type { JWTVerifyGetKey } from 'jose'
import type { ApiKey, Member, OrgRole, WorkspaceRole, WorkspaceSummary } from '../console-api/types.js'

/**
 * The parts of a gateway member record auth reads. Structural, so the
 * gateway store's `MemberRecord` satisfies it without auth importing it.
 */
export interface AuthMember {
  id: string
  label: string
  email: string | null
  orgRole: OrgRole
  status: 'active' | 'invited' | 'disabled'
  createdAt: number
  limits?: unknown
  routingPolicy?: unknown
  maxKeys?: number | null
}

/** The parts of an API key record auth reads (`ApiKeyRecord` satisfies it). */
export interface AuthKey {
  id: string
  label: string
  hint: string
  buyerIdentity: string
  status: 'active' | 'revoked'
  limits: unknown
  topupEnabled: boolean
  expiresAt: number | null
  createdAt: number
  lastUsedAt: number | null
  workspaceId?: string
  ownerMemberId?: string | null
  routingPolicy?: unknown
}

export interface NewAuthMember {
  label: string
  email: string | null
  orgRole: OrgRole
  status: 'active'
  workspaces: Array<{ workspaceId: string; role: WorkspaceRole }>
}

/** What auth needs from `GatewayStore`; methods marked optional degrade gracefully when missing. */
export interface AuthStore {
  readonly database: Database.Database
  getMember(id: string): AuthMember | null
  findMemberByEmail(email: string): AuthMember | null
  memberWorkspaceRoles(memberId: string): ReadonlyMap<string, WorkspaceRole>
  isSetupComplete(): boolean
  createOwner(input: { label: string; email: string | null }): AuthMember
  consumeInvite(tokenHash: string, now: number): AuthMember | null
  /** Token hash of the member's live invite; an invited member signs in by SSO only while it lasts. */
  liveInviteHash(memberId: string, now: number): string | null
  findKeyBySecret(secret: string): AuthKey | null
  getKey(id: string): AuthKey | null
  getWorkspace?(id: string): WorkspaceSummary | null
  listWorkspaces?(): WorkspaceSummary[]
  workspaceForKey?(keyId: string): WorkspaceSummary | null
  usageStats?(keyId: string, since?: number): { requests: number; spentUsdc: number }
  /** Used by OIDC / Cloudflare Access domain auto-join; falls back to createInvite + consumeInvite. */
  createMember?(input: NewAuthMember): AuthMember
  createInvite?(input: {
    label: string
    email: string | null
    orgRole: OrgRole
    workspaces: Array<{ workspaceId: string; role: WorkspaceRole }>
    expiresAt: number
    createdBy: string | null
  }): { token: string }
  /**
   * Management tokens; when absent auth reads the `admin_tokens` table
   * directly. A token past `expiresAt`, or whose creator is no longer an
   * active owner/admin, is refused.
   */
  findAdminTokenBySecret?(secret: string): { id: string; scope: 'admin' | 'read'; revokedAt: number | null; expiresAt?: number | null; createdBy?: string | null } | null
  touchAdminToken?(id: string): void
  /** Audit log (sign-ins, failed sign-ins, setup); skipped when absent. */
  recordAudit?(input: {
    actor: { kind: 'member' | 'token' | 'key' | 'system' | 'cli'; id: string | null; label?: string | null }
    action: string
    target?: { kind: string; id: string | null; label?: string | null } | null
    details?: Record<string, unknown>
    ip?: string | null
  }): unknown
}

/** Subset of `ConsoleDeps` auth uses; `ConsoleDeps` is assignable to it. */
export interface AuthDeps {
  store: AuthStore
  publicUrl: string | null
  now: () => number
  log: (message: string) => void
  /** Gateway listen port, for the setup link when there is no publicUrl. */
  gatewayPort?: number
  /**
   * The gateway runs behind its own Cloudflare tunnel, so `CF-Connecting-IP`
   * from the local cloudflared is the real client address. Off by default:
   * behind Caddy or ngrok a client could forge it.
   */
  trustCloudflareHeaders?: boolean
}

export interface ConsoleAuthOptions {
  /** Defaults to process.env; read for ANTSEED_OIDC_* and ANTSEED_CF_ACCESS_*. */
  env?: Record<string, string | undefined>
  gatewayPort?: number
  /** Override how `me()` renders a member or key (gateway-core can share its own serializers). */
  presentMember?: (member: AuthMember, credentials: Member['credentials']) => Member
  presentKey?: (key: AuthKey) => ApiKey
  /** Test hook: the Cloudflare Access signing keys instead of `https://<team>/cdn-cgi/access/certs`. */
  cloudflareAccessKeys?: JWTVerifyGetKey
  /** Test hook / custom transport for OIDC discovery and token exchange. */
  fetch?: typeof fetch
}
