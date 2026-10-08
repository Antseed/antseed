/**
 * Contract between the gateway's console API (`/console/api/*`, served by the
 * gateway process) and the console web app (`apps/gateway-console`), which
 * imports these types by relative path. Amounts are USDC as decimal strings
 * ("12.345678") on the wire; timestamps are epoch milliseconds.
 *
 * Auth: a session cookie (`antseed_console`, HttpOnly, Secure unless served
 * on loopback, SameSite=Strict) or `Authorization: Bearer antseed_admin_…`
 * (a management token). Every mutating request from the browser must carry
 * `x-antseed-console: 1`. Errors are `{ error: { code, message } }` with an
 * HTTP status.
 */
import type { RoutingPolicy } from '../../routing-policy/policy.js'

export type { RoutingPolicy, ModelRoute, RoutingSort } from '../../routing-policy/policy.js'
export type { OperatorRelation, OperatorState, OperatorAuthorization } from './operator-types.js'

export const CONSOLE_BASE_PATH = '/console'
export const CONSOLE_API_PATH = '/console/api'
export const CONSOLE_CSRF_HEADER = 'x-antseed-console'

export type Usdc = string
export type OrgRole = 'owner' | 'admin' | 'member'
export type WorkspaceRole = 'admin' | 'member'
export type LimitPeriod = 'daily' | 'weekly' | 'monthly' | 'total'
export type SpendLimits = Record<LimitPeriod, Usdc | null>

export interface ApiError {
  error: { code: string; message: string }
}

// ── Auth ────────────────────────────────────────────────────────────────

export interface AuthConfig {
  /** True until the owner has claimed the console with the setup link. */
  setupRequired: boolean
  passkey: boolean
  wallet: boolean
  /** Present when the operator configured an OpenID Connect provider. */
  oidc: { label: string } | null
  /** Present when the gateway trusts Cloudflare Access identity headers. */
  cloudflareAccess: boolean
  /** Key holders may sign in with an API key to see that key only. */
  apiKeyLogin: boolean
}

export interface Me {
  member: Member
  /** The workspaces this member can open, with their role in each. */
  workspaces: Array<{ workspace: WorkspaceSummary; role: WorkspaceRole }>
}

/** A read-only session from an API key; sees only that key. */
export interface KeySessionMe {
  key: ApiKey
}

export type MeResponse = { kind: 'member'; me: Me } | { kind: 'key'; me: KeySessionMe }

// POST /auth/setup                  { token }                         → enrollment
// POST /auth/invite                 { token }                         → enrollment
//   An enrollment lets the browser register its first credential:
// POST /auth/passkey/register/options { enrollment? }                 → WebAuthn creation options
// POST /auth/passkey/register/verify  { enrollment?, response }       → MeResponse (session set)
// POST /auth/passkey/login/options    {}                              → WebAuthn request options
// POST /auth/passkey/login/verify     { response }                    → MeResponse
// POST /auth/wallet/nonce             { address }                     → { message }  (EIP-4361 text)
// POST /auth/wallet/verify            { message, signature, enrollment? } → MeResponse
// GET  /auth/oidc/start?enrollment=   → 302 to the provider
// GET  /auth/oidc/callback            → 302 to /console
// POST /auth/reauth/passkey/options   {}                              → WebAuthn request options (member session; own passkeys only)
// POST /auth/reauth/passkey/verify    { response }                    → MeResponse (refreshes this session's sign-in time; another member's passkey → 403 reauth_wrong_member)
// POST /auth/reauth/wallet/nonce      { address }                     → { message }  (member session)
// POST /auth/reauth/wallet/verify     { message, signature }          → MeResponse (same session; a wallet that isn't the member's → 403 reauth_wrong_member)
// POST /auth/api-key                  { key }                         → MeResponse
// POST /auth/logout                   → 204
// GET  /auth/config                   → AuthConfig   (no session needed)
// GET  /auth/me                       → MeResponse
export interface Enrollment {
  enrollment: string
  /** Who is enrolling, for the welcome screen. */
  label: string
  orgRole: OrgRole
}

// ── Organization ────────────────────────────────────────────────────────

export interface Member {
  id: string
  label: string
  email: string | null
  orgRole: OrgRole
  status: 'active' | 'invited' | 'disabled'
  credentials: Array<{ id: string; kind: 'passkey' | 'wallet' | 'oidc'; label: string; createdAt: number; lastUsedAt: number | null }>
  limits: SpendLimits
  routingPolicy: RoutingPolicy | null
  /** How many keys this member may create on their own; null means no limit. */
  maxKeys: number | null
  createdAt: number
}

// GET    /members                       → Member[]                (org admins)
// POST   /invites                       InviteInput               → Invite
// GET    /invites                       → Invite[]
// DELETE /invites/:id                   → 204
// PATCH  /members/:id                   Partial<MemberInput>      → Member
// POST   /members/:id/disable           → Member  (revokes their keys and sessions)
// POST   /members/:id/enable            → Member
// DELETE /members/:id/credentials/:credentialId → 204
export interface MemberInput {
  label: string
  email: string | null
  orgRole: OrgRole
  limits: SpendLimits
  routingPolicy: RoutingPolicy | null
  maxKeys: number | null
}

export interface InviteInput {
  label: string
  email?: string | null
  orgRole: OrgRole
  workspaces: Array<{ workspaceId: string; role: WorkspaceRole }>
  /** Hours until the link expires; default 72. */
  expiresInHours?: number
}

export interface Invite {
  id: string
  label: string
  email: string | null
  orgRole: OrgRole
  /** Shown once, on creation. */
  url?: string
  expiresAt: number
  createdAt: number
}

// ── Workspaces ──────────────────────────────────────────────────────────

export interface WorkspaceSummary {
  id: string
  name: string
  isDefault: boolean
}

export interface Workspace extends WorkspaceSummary {
  /** Buyer identity (wallet) that pays for this workspace's keys. */
  buyerIdentity: string
  walletAddress: string | null
  limits: SpendLimits
  /** Set by workspace admins. */
  routingPolicy: RoutingPolicy | null
  /** Set by org admins; workspace admins can only narrow it with `routingPolicy`. */
  orgRoutingPolicy: RoutingPolicy | null
  memberCount: number
  keyCount: number
  createdAt: number
}

// GET    /workspaces                    → Workspace[]   (only those the caller can open)
// POST   /workspaces                    WorkspaceInput  → Workspace  (org admins; creates its wallet)
// GET    /workspaces/:id                → Workspace
// PATCH  /workspaces/:id                Partial<WorkspaceInput> → Workspace
// DELETE /workspaces/:id                → 204 (refused while it has active keys or a balance)
// GET    /workspaces/:id/members        → Array<{ member: Member; role: WorkspaceRole }>
// PUT    /workspaces/:id/members/:memberId  { role } → 204
// DELETE /workspaces/:id/members/:memberId  → 204
export interface WorkspaceInput {
  name: string
  limits: SpendLimits
  routingPolicy: RoutingPolicy | null
  /** Org admins only. */
  orgRoutingPolicy?: RoutingPolicy | null
  /** Use an existing buyer identity instead of creating a new wallet. */
  buyerIdentity?: string
}

// ── API keys ────────────────────────────────────────────────────────────

export interface ApiKey {
  id: string
  label: string
  hint: string
  workspaceId: string
  ownerMemberId: string | null
  buyerIdentity: string
  status: 'active' | 'revoked'
  /** Admin layer: set by workspace admins; the key's owner cannot change it. */
  limits: SpendLimits
  routingPolicy: RoutingPolicy | null
  /**
   * Owner layer: set by the key's owner (or an admin) on top of the admin
   * layer. Each layer only narrows, so the effective cap per period is the
   * lower of `limits` and `ownerLimits`, and the owner's policy can never
   * allow what the admin layer does not.
   */
  ownerLimits?: SpendLimits
  ownerRoutingPolicy?: RoutingPolicy | null
  topupEnabled: boolean
  expiresAt: number | null
  createdAt: number
  lastUsedAt: number | null
  usage: { requests: number; spent: Usdc; spentThisMonth: Usdc }
}

// GET    /keys?workspace=&member=       → ApiKey[]
// POST   /keys                          ApiKeyInput → { key: ApiKey; secret: string }
// PATCH  /keys/:id                      Partial<ApiKeyInput> → ApiKey
//   A key's owner (not a workspace admin) may only send `label`,
//   `ownerLimits`, `ownerRoutingPolicy` and an earlier `expiresAt`; `limits`
//   and `routingPolicy` are 403 for them. On create, a non-admin's `limits` /
//   `routingPolicy` are stored as the owner layer.
//   409 `narrowed` (body: PolicyNarrowedError) when a sent policy or limit
//   asks for more than the levels above allow; nothing is stored unless the
//   request repeats with `acceptNarrowed: true`.
//   400 `empty_allow_list` when a sent policy's allow list leaves no seller
//   (`allowedPeerIds: []`, lists that expand to nothing, or no overlap with
//   the levels above) unless `confirmEmpty: true`. The same two checks apply
//   to workspace and member policies (PATCH /workspaces/:id, /members/:id).
// POST   /keys/:id/rotate               → { key: ApiKey; secret: string }
// POST   /keys/:id/revoke               → ApiKey
export interface ApiKeyInput {
  label: string
  workspaceId: string
  limits: SpendLimits
  routingPolicy: RoutingPolicy | null
  topupEnabled: boolean
  expiresAt: number | null
  /** Admins may create a key for another member. */
  ownerMemberId?: string | null
  ownerLimits?: SpendLimits
  ownerRoutingPolicy?: RoutingPolicy | null
  /** Store a policy whose allow list leaves no seller. */
  confirmEmpty?: boolean
  /** Store a policy or limits even though the levels above narrow them. */
  acceptNarrowed?: boolean
}

/** Body of a 409 `narrowed` answer. */
export interface PolicyNarrowedError {
  error: {
    code: 'narrowed'
    message: string
    /** Which fields lost something, e.g. "allowedPeerIds", "limits.daily". */
    fields: string[]
    /** The routing policy at that level after narrowing under every level above (peer lists expanded), when a policy was sent. */
    effectiveRoutingPolicy?: RoutingPolicy
    /** The effective key caps (lower of admin and owner layer), when limits were sent. */
    effectiveLimits?: SpendLimits
  }
}

// ── Management tokens (programmatic access to this API) ─────────────────

export interface AdminToken {
  id: string
  label: string
  hint: string
  /** 'admin' = everything an org admin can do; 'read' = GETs only. */
  scope: 'admin' | 'read'
  createdByMemberId: string | null
  /** Tokens stop working at this time; null never expires. */
  expiresAt: number | null
  createdAt: number
  lastUsedAt: number | null
}
// GET /admin-tokens → AdminToken[];  POST /admin-tokens { label, scope, expiresInDays? } → { token: AdminToken; secret }
// DELETE /admin-tokens/:id → 204

// ── Usage & activity ────────────────────────────────────────────────────

/** `hour` and `day` group by UTC hour (`YYYY-MM-DDTHH`) and day (`YYYY-MM-DD`), oldest first. */
export type UsageGroupBy = 'hour' | 'day' | 'model' | 'key' | 'member' | 'peer' | 'workspace' | 'user'

// GET /usage?workspace=&key=&member=&from=&to=&groupBy=&splitBy=   → UsageReport
//   splitBy (needs groupBy, must differ) adds `splits` to each group, e.g. groupBy=day&splitBy=model
//   for a per-day, per-model chart in one request; `groupBy=day,model` is the same.
// GET /requests?workspace=&key=&member=&model=&status=&from=&to=&q=&before=&limit=  → { requests: RequestLogEntry[]; nextBefore: string | null }  (opaque cursor)
// GET /requests/:tag → RequestDetail
// GET /usage/export.csv?…same filters…                      → text/csv
export interface UsageReport {
  from: number
  to: number
  totals: UsageTotals
  groups: Array<{ group: string; label: string; splits?: UsageSplit[] } & UsageTotals>
}

/** One part of a usage group when the report was split (`splitBy`). */
export type UsageSplit = { group: string; label: string } & UsageTotals

export interface UsageTotals {
  requests: number
  failedRequests: number
  spent: Usdc
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
}

export interface RequestLogEntry {
  tag: string
  startedAt: number
  finishedAt: number | null
  keyId: string
  keyLabel: string
  workspaceId: string
  memberId: string | null
  /** End user from the request's `user` field, if the client sent one. */
  endUser: string | null
  method: string
  path: string
  model: string | null
  status: number | null
  sellerPeerId: string | null
  latencyMs: number | null
  spent: Usdc | null
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  /** Error code and message from a failed response (gateway, buyer or seller). */
  errorCode: string | null
  errorMessage: string | null
  /**
   * A model request that did not fail and has no spend recorded yet: the
   * buyer reports spend a moment after the response. If it stays pending
   * for minutes the spend was not recorded (a free seller, or lost).
   * Token counts meanwhile come from the response's own usage.
   */
  costPending?: boolean
}

/** GET /requests/:tag → one entry, with bodies when content logging was on for it. */
export interface RequestDetail extends RequestLogEntry {
  requestBody: string | null
  responseBody: string | null
}

// ── Audit log ───────────────────────────────────────────────────────────

// GET /audit?before=&limit=&actor=&action=   (org admins) → { entries: AuditEntry[]; nextBefore: string | null }
//   actor = exact actor id; action = a verb or a verb family ("key" matches "key.create", "key.revoke", …)
export interface AuditEntry {
  id: string
  at: number
  actor: { kind: 'member' | 'token' | 'key' | 'system' | 'cli'; id: string | null; label: string | null }
  /** Dotted verb, e.g. "key.create", "workspace.policy.update", "wallet.operator_auth". */
  action: string
  target: { kind: string; id: string | null; label: string | null } | null
  details: Record<string, unknown>
  ip: string | null
}

// ── Wallets, funding, channels, rewards ─────────────────────────────────

// GET  /workspaces/:id/wallet                 → Wallet
// POST /workspaces/:id/wallet/card-link       { amountUsd, provider: 'crossmint' | 'stripe' } → { url }
// POST /workspaces/:id/wallet/watch           { mode: 'active' | 'background' } → DepositWatch
// POST /workspaces/:id/wallet/operator-auth  { operator } → OperatorAuth  (org owners only, fresh sign-in, operator must be one of the caller's wallet credentials)
// GET  /workspaces/:id/channels?all=1         → Channel[]
// POST /workspaces/:id/channels/close         { peerId } → { ok: true }
// GET  /workspaces/:id/rewards                → Rewards
// GET  /chain                                 → ChainInfo  (for wallet-signed actions in the browser)
export interface Wallet {
  buyerIdentity: string
  address: string
  /** Credits deposited in AntseedDeposits and available to spend. */
  available: Usdc
  reserved: Usdc
  /** USDC sitting in the wallet itself, not yet swept into deposits. */
  walletUsdc: Usdc
  creditLimit: Usdc | null
  /** Personal wallet authorized to withdraw and claim for this wallet. */
  operator: string | null
  deposit: DepositWatch
  /** Last known values: the chain RPC is unreachable or rate limiting right now. */
  stale?: boolean
}

/**
 * The workspace wallet's EIP-712 SetOperator authorization for
 * AntseedDeposits; the operator submits `setOperator(buyer, operator, nonce,
 * signature)` from its own wallet.
 */
export interface OperatorAuth {
  buyer: string
  /** Operator nonce as a decimal string. */
  nonce: string
  signature: string
}

export interface DepositWatch {
  mode: 'active' | 'background' | 'off'
  status: string
  lastTxHash: string | null
}

export interface Channel {
  channelId: string
  peerId: string
  sellerName: string | null
  status: string
  reserved: Usdc
  spent: Usdc
  openedAt: number | null
  canCooperativeClose: boolean
}

export interface Rewards {
  address: string
  pendingAnts: string
  claimedAnts: string
  epochs: Array<{ epoch: number; pendingAnts: string; claimed: boolean }>
  /** Claiming needs the operator wallet connected in the browser. */
  operator: string | null
  /** Last known values: the chain RPC is unreachable or rate limiting right now. */
  stale?: boolean
}

export interface ChainInfo {
  chainId: number
  name: string
  rpcUrl: string
  explorerUrl: string | null
  contracts: Record<string, string>
}

// ── Network & routing ───────────────────────────────────────────────────

// GET  /peers                     → Peer[]
// GET  /route-preview?model=&workspace=&key=&member=&preset=   → RoutePreview
// GET  /routing                   → RoutingPolicy   (gateway default)
// PUT  /routing                   RoutingPolicy     → RoutingPolicy
// GET/POST /peer-lists, PATCH/DELETE /peer-lists/:id
//   PATCH (new peerIds) and DELETE answer 400 `empty_allow_list` (with
//   `usedBy: string[]`) when a policy that allows only this list's sellers
//   would be left with none; resend with `confirmEmpty: true` (PATCH body) or
//   `?confirmEmpty=true` (DELETE).
export interface Peer {
  peerId: string
  displayName: string | null
  services: Array<{
    provider: string
    service: string
    inputUsdPerMillion: number | null
    outputUsdPerMillion: number | null
    cachedInputUsdPerMillion: number | null
    categories: string[]
    /** Wire APIs the seller serves this model on, e.g. "openai-chat-completions", "anthropic-messages". */
    apiProtocols?: string[]
  }>
  trustScore: number | null
  reputationScore: number | null
  verified: boolean
  tee: boolean
  stakeAnts: string | null
  usageShareBps: number | null
  washFlagged: boolean
  lastSeen: number | null
  health: { failureStreak: number; coolingDownUntil: number | null }
  /** Measured by this gateway over its recent requests. */
  latencyMsP50: number | null
  requests24h: number
}

export interface RoutePreview {
  model: string
  /** The policy that applies after combining every level. */
  policy: RoutingPolicy
  /** Which levels contributed, top to bottom. */
  sources: Array<{ level: 'buyer' | 'gateway' | 'workspace-org' | 'workspace' | 'member' | 'key' | 'key-owner' | 'preset'; id: string | null; policy: RoutingPolicy | null }>
  modelAllowed: boolean
  candidates: Array<{
    peerId: string
    displayName: string | null
    rank: number | null
    eligible: boolean
    /** Why it was excluded or how it scored, e.g. "blocked by workspace", "over input price cap". */
    reasons: string[]
    inputUsdPerMillion: number | null
    outputUsdPerMillion: number | null
    trustScore: number | null
  }>
}

export interface PeerList {
  id: string
  name: string
  description: string | null
  peerIds: string[]
  createdAt: number
}

// ── Presets ─────────────────────────────────────────────────────────────

/** Called as `model: "@preset/<slug>"`. */
export interface Preset {
  id: string
  slug: string
  name: string
  workspaceId: string | null
  model: string
  routingPolicy: RoutingPolicy | null
  systemPrompt: string | null
  /** Request parameters merged under the client's own (temperature, max_tokens, …). */
  params: Record<string, unknown>
  createdAt: number
}
// GET /presets?workspace=, POST /presets, PATCH /presets/:id, DELETE /presets/:id

// ── Settings & status ───────────────────────────────────────────────────

// GET   /status                    → GatewayStatus
// POST  /auth/recover              { token } → Enrollment  (public; single-use CLI recovery link)
// GET   /settings                  → Settings
// PATCH /settings/buyer            BuyerSettingsInput → Settings  (restarts the buyer)
// PUT   /settings/observability    ObservabilitySettings → Settings
export interface GatewayStatus {
  version: string
  publicUrl: string | null
  buyer: { reachable: boolean; peers: number; dhtNodes: number; uptimeMs: number | null }
  spendFeed: string
  x402: boolean
  /**
   * Who can reach this gateway. Org admins get every field; other callers
   * get `mode`, `reachableFromInternet` and `personalComputer` only
   * (`listenHost` null, `reasons` empty).
   */
  exposure?: GatewayExposure
}

/**
 * `local`: only this machine can reach the gateway (loopback, no public URL);
 * `lan`: it listens beyond loopback without a public URL; `public`: it has
 * a public URL (a domain or a tunnel). Judged from configuration only.
 */
export type GatewayExposureMode = 'local' | 'lan' | 'public'

export interface GatewayExposure {
  mode: GatewayExposureMode
  publicUrl: string | null
  listenHost: string | null
  /** null when configuration alone cannot tell (e.g. listening on 0.0.0.0). */
  reachableFromInternet: boolean | null
  /** macOS/Windows, or Linux without systemd outside a container: likely a laptop or desktop. */
  personalComputer: boolean
  /** Plain-language reasons behind `mode`, for the console. */
  reasons: string[]
}

export interface Settings {
  publicUrl: string | null
  buyer: {
    proxyPort: number
    maxPricing: { inputUsdPerMillion: number; outputUsdPerMillion: number; cachedInputUsdPerMillion: number | null }
    minPeerReputation: number
    requireVerifier: boolean
  }
  observability: ObservabilitySettings
  auth: AuthConfig
  /**
   * Set by `PATCH /settings/buyer` when the buyer could not restart itself
   * (not supervised, or unreachable): the change is saved but applies only
   * after the operator restarts it. `observability.otlpHeaders` values read
   * "••••" for anyone but org-admin sessions; sending "••••" back keeps the
   * stored value.
   */
  restartRequired?: boolean
}

export interface BuyerSettingsInput {
  maxPricing?: { inputUsdPerMillion?: number; outputUsdPerMillion?: number; cachedInputUsdPerMillion?: number | null }
  minPeerReputation?: number
}

export interface ObservabilitySettings {
  /** OpenTelemetry/HTTP endpoint the gateway sends one trace per request to. */
  otlpEndpoint: string | null
  otlpHeaders: Record<string, string>
  /** Store request and response bodies in the request log. Off by default. */
  logContent: boolean
  /** Days to keep the request log; null keeps it forever. */
  retentionDays: number | null
}
