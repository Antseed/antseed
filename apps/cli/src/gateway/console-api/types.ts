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
import type { RouteSelection, ServedSelection } from '../../proxy/route-selection.js'
import type { InstallKind } from '../../update/install-method.js'
import type { RootUpdateProgress } from '../../update/root-updater.js'

export type { RoutingPolicy, ModelRoute, RoutingSort } from '../../routing-policy/policy.js'
export type { RouteSelection, ServedSelection } from '../../proxy/route-selection.js'
export type { OperatorRelation, OperatorState, OperatorAuthorization, WorkspaceOperatorSummary } from './operator-types.js'
export type { FreeTierProgramView, FreeTierSharing, FreeTierStake, FreeTierStakePosition, FreeTierStaker } from './free-tier-types.js'
import type { FreeTierProgramView } from './free-tier-types.js'

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

/** A seller-only dashboard session (`antseed seller dashboard`); sees the Seller page only. */
export interface SellerSessionMe {
  /** The seller data directory the dashboard reads. */
  dataDir: string
  version: string
}

export type MeResponse = { kind: 'member'; me: Me } | { kind: 'key'; me: KeySessionMe } | { kind: 'seller'; me: SellerSessionMe }

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

/** What a plain workspace member sees of the others in their workspace. */
export type MemberSummary = Pick<Member, 'id' | 'label' | 'orgRole' | 'status'>

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
// GET    /workspaces/:id/members        → Array<{ member: Member; role: WorkspaceRole }> (MemberSummary for plain members)
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
export type UsageGroupBy = 'hour' | 'day' | 'model' | 'key' | 'member' | 'peer' | 'router' | 'workspace' | 'user'

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
  groups: Array<UsageSplit & { splits?: UsageSplit[] }>
}

/**
 * One part of a usage group when the report was split (`splitBy`). By end
 * user, the users past the largest 100 come as one group with `others` set
 * to how many it folds.
 */
export type UsageSplit = { group: string; label: string; others?: number } & UsageTotals

export interface UsageTotals {
  requests: number
  failedRequests: number
  spent: Usdc
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
}

/** The routing service that ranked a request. */
export interface RequestRouterInfo {
  peerId: string
  /** The router's service id, e.g. `levanto-router`. */
  service: string | null
  /**
   * The recommendation tried last, 1 = the router's first pick: the one that served the request, or, when the
   * request failed, the last one refused (the ones before it were refused too). Null when the ranking failed.
   */
  rank: number | null
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
  /** The seller that served the request (for a routed request, the one the router picked). */
  sellerPeerId: string | null
  /** The model that answered, when it differs from `model` (a router picked it). */
  servedModel?: string | null
  /** The routing service that ranked the request, when one did. */
  router?: RequestRouterInfo | null
  latencyMs: number | null
  /** Streamed answers: time from sending to the seller's first frame, measured by the buyer. */
  firstTokenMs: number | null
  /** Streamed answers of 20+ output tokens: output tokens per second after the first frame. */
  tokensPerSecond: number | null
  spent: Usdc | null
  /** The part of `spent` that paid the router for its ranking (routed requests only). */
  routingSpent?: Usdc | null
  inputTokens: number
  cachedInputTokens: number
  outputTokens: number
  /** Error code and message from a failed response (gateway, buyer or seller). */
  errorCode: string | null
  errorMessage: string | null
  /** Served by a free seller (all its advertised prices zero): the cost is $0 and no spend is reported. */
  servedFree?: boolean
  /**
   * A model request that did not fail, was not served free and has no spend
   * recorded yet: the buyer reports spend a moment after the response. If it
   * stays pending for minutes the spend was not recorded (lost).
   * Token counts meanwhile come from the response's own usage.
   */
  costPending?: boolean
  /**
   * A native video request. A job is charged once, on the retrieve that
   * delivers its file (`delivery`); its create and status polls cost nothing.
   * `charged` is a create's job charge, null until its video is delivered.
   */
  video?: { action: 'create' | 'poll' | 'delivery'; jobId: string | null; charged: Usdc | null }
}

/** GET /requests/:tag → one entry, with bodies when content logging was on for it. */
export interface RequestDetail extends RequestLogEntry {
  /** Model-routed requests: why automatic routing picked the seller that served it. Null for pinned or older requests. */
  routeSelection: ServedSelection | null
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
// GET  /workspaces/:id/channels?all=1&fresh=1 → Channel[]  (fresh: re-read the chain now)
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

// Workspace admins: deposits credited to the workspace wallet, with who approved each (deposit confirmations).
// GET    /workspaces/:id/deposits                 → DepositConfirmation[] (newest first; new ones the buyer recorded are verified first)
// POST   /workspaces/:id/deposits { txHash }      → DepositConfirmation (adds a deposit by its transaction, e.g. one made before this was recorded)
// PUT    /workspaces/:id/deposits/:tx/approval { note? } → DepositConfirmation
// DELETE /workspaces/:id/deposits/:tx/approval   → DepositConfirmation
export interface DepositConfirmation {
  txHash: string
  /** A short reference for the confirmation, from the transaction hash. */
  reference: string
  /**
   * transfer: USDC sent to the workspace wallet; direct: deposited by a connected wallet. Both are listed.
   * relay: the wallet swept into the credits by a relayer, which keeps a fixed fee: a move inside the workspace, not listed.
   */
  kind: 'transfer' | 'relay' | 'direct'
  wallet: string
  workspaceId: string
  workspaceName: string
  /** What left the payer's side: credited + fee. */
  sent: Usdc
  credited: Usdc
  fee: Usdc
  blockNumber: number
  /** Epoch ms of the block. */
  time: number
  /** Where the USDC came from; empty when the chain could not be searched. `minted`: the USDC issuer minted it into the wallet (an exchange withdrawal or a card purchase). */
  sources: Array<{ from: string; amount: Usdc; txHash: string; minted: boolean }>
  approval: { by: string; at: number; note: string | null } | null
}

// Workspace admins: the company a workspace buys for, printed on its purchase statements.
// GET    /workspaces/:id/billing-profile → BillingProfile | null
// PUT    /workspaces/:id/billing-profile BillingProfileInput → BillingProfile (stored as entered, nothing is checked)
// DELETE /workspaces/:id/billing-profile → { ok: true }
export interface BillingProfileInput {
  companyName: string
  /** Street, postal code and city, one per line. */
  address: string
  /** As entered; empty when not given. */
  country: string
  /** The company's tax ID (VAT, GST, EIN…), as entered. */
  vatNumber: string | null
  /** A company register number (e.g. KvK). */
  registrationNumber: string | null
  /** Anything else the buyer wants on its statements (a PO number, cost centre, contact), one item per line. */
  notes: string | null
}

export interface BillingProfile extends BillingProfileInput {
  updatedAt: number
}

// Workspace admins: monthly purchase statements, a record of what the workspace bought from which sellers.
// GET /workspaces/:id/statements          → StatementSummary[] (newest first: every month since its first paid request)
// GET /workspaces/:id/statements/:period  → PurchaseStatement (period "YYYY-MM", UTC)
export interface StatementSummary {
  period: string
  status: PurchaseStatement['status']
  reference: string
  purchases: Usdc
  issuedAt: number | null
}

export interface PurchaseStatement {
  /** "YYYY-MM", a calendar month in UTC. */
  period: string
  /** Epoch ms; `to` is exclusive. */
  from: number
  to: number
  /**
   * final: kept as issued on `issuedAt`, never changes.
   * open: a draft computed now; the month is not over (or ended less than a day ago), or the workspace has no billing details.
   */
  status: 'open' | 'final'
  reference: string
  issuedAt: number | null
  generatedAt: number
  workspace: { id: string; name: string; wallet: string | null }
  /** The buyer's details as they were when issued; null when not set yet (a draft). */
  buyer: BillingProfile | null
  suppliers: StatementSupplier[]
  total: Usdc
  requests: number
  /** The month's money in (deposits and transfers into the workspace wallet, and the relay fees of moving them into the credits) as recorded at `asOf`: read again on every view, also of a final statement (a transfer is recorded once swept, which can be after the month). */
  funding: { deposits: Array<{ txHash: string; reference: string; kind: DepositConfirmation['kind']; time: number; amount: Usdc }>; total: Usdc; relayFees: Usdc; asOf: number }
  /** Where the payment records came from: the chain explorer, or null when they could not be read (each supplier's `settlements` is then null). */
  settlementsSource: string | null
  /**
   * How many other workspaces paid from the same wallet by the month's end (not named: a reader may not see them).
   * Settlements are the wallet's: with a shared wallet a seller's settlements also pay the other workspaces' purchases.
   */
  sharedWallet: number
}

export interface StatementSupplier {
  peerId: string
  /** The seller's name on the network when known. */
  name: string | null
  /** Ownership claims (domain, GitHub) the seller proved. */
  verificationLinks: PeerVerificationLink[]
  lines: Array<{
    /** The model, or the routing service for a routing fee. */
    service: string | null
    kind: 'inference' | 'routing'
    requests: number
    inputTokens: number
    cachedInputTokens: number
    outputTokens: number
    amount: Usdc
  }>
  total: Usdc
  /** Settlement transactions on Base that paid this seller from the workspace's credits during the month; null when not read. */
  settlements: Array<{ txHash: string; time: number; amount: Usdc }> | null
}

export interface DepositWatch {
  mode: 'active' | 'background' | 'off'
  status: string
  lastTxHash: string | null
  /**
   * The watcher's latest event, for a live status line: received → sweeping →
   * credited (or deferred / error). `seq` grows with every event, so a client
   * can tell a new one from the last it showed. Null before the first event.
   */
  event: { seq: number; phase: 'received' | 'sweeping' | 'credited' | 'deferred' | 'error'; amount: Usdc | null; txHash: string | null; error: string | null; at: number } | null
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
  /**
   * When the authorized wallet requested an on-chain close (ms), or null. The
   * unused reserve can be withdrawn `CHANNEL_CLOSE_GRACE_MS` later (status
   * 'closing', then 'withdrawable').
   */
  closeRequestedAt: number | null
  /** Already settled to the seller on chain; null when the chain was not read. `spent - settled` is authorized but not yet charged. */
  settled: Usdc | null
}

/** AntseedChannels' grace period between an on-chain close request and the withdrawal. */
export const CHANNEL_CLOSE_GRACE_MS = 15 * 60_000

export interface Rewards {
  address: string
  /** Everything claimable: the current program's epochs plus legacy emissions. */
  pendingAnts: string
  /** Not readable per epoch (a claimed epoch reads as 0 pending); always '0'. */
  claimedAnts: string
  /** The current (usage rewards) program, claimed per epoch with claimBuyerReward. */
  epochs: Array<{ epoch: number; pendingAnts: string; claimed: boolean }>
  /**
   * Buyer emissions from the legacy program, claimed in one
   * claimBuyerEmissions(buyer, epochs) call on `contract` (epochs already
   * claimed or empty are skipped on chain). Null when there is none.
   */
  legacy: { pendingAnts: string; contract: string; epochs: number[] } | null
  /** Claiming needs the operator wallet connected in the browser. */
  operator: string | null
  /** Last known values: the chain RPC is unreachable or rate limiting right now. */
  stale?: boolean
}

export interface ChainInfo {
  chainId: number
  name: string
  /** The chain's public default RPC; null for a chain without one (never the operator's configured URL). */
  rpcUrl: string | null
  explorerUrl: string | null
  contracts: Record<string, string>
}

// ── Chat ────────────────────────────────────────────────────────────────

// Members (their "Web chat" key pays) and API-key sessions (`antseed chat`; that key pays):
// GET    /chat/models?workspace=<id>  → ChatModel[]
// POST   /chat  { id, messages, model, peerId?, workspaceId? } → AI SDK UI message stream (SSE)
//   id names the conversation; the stored conversation plus the last message is what the model sees.
//   peerId pins the seller (sent to the buyer as `peerId@model`); without it the buyer routes.
//   Each assistant message's metadata is a ChatMessageMetadata: the model and the peer(s) that answered.
// GET    /chat/threads?workspace=<id> → ChatThread[]  (the caller's, newest first)
// GET    /chat/threads/:id            → ChatThreadDetail
// DELETE /chat/threads/:id            → 204
export interface ChatThread {
  id: string
  title: string
  model: string | null
  /** The peer the conversation was pinned to, or null. */
  peerId: string | null
  createdAt: number
  updatedAt: number
}

export interface ChatThreadDetail extends ChatThread {
  /** AI SDK UIMessages; assistant messages carry ChatMessageMetadata. */
  messages: unknown[]
}

export interface ChatModelPeer {
  peerId: string
  name: string | null
  toolUse: boolean
  reasoning: boolean
  /** Takes images as input. */
  vision: boolean
  /** Advertises the TEE verifier (attested hardware). */
  tee: boolean
  inputUsdPerMillion: number | null
  outputUsdPerMillion: number | null
  /** Null when the peer advertises no cached-input price (cached tokens then cost the input price). */
  cachedInputUsdPerMillion: number | null
  reputation: number | null
  /** The free-tier program this offer is served under; on a priced offer, its free allowance. */
  freeTier: FreeTierProgramView | null
}

export interface ChatMessageMetadata {
  model: string
  /** The peer the user pinned, or null for automatic routing. */
  pinnedPeerId: string | null
  /** The peer(s) that served the answer, one per model call (tool rounds can reach different peers when not pinned). */
  peers: Array<{ peerId: string; name: string | null }>
  /** Tokens over every model call of the answer so far. */
  usage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number }
  /**
   * Estimated cost in USD: each call's tokens at the serving peer's advertised
   * prices. Null when a serving peer's price is unknown. The signed amount is
   * in the request log once the buyer reports it.
   */
  costUsd?: number | null
}

// GET    /chat/context?workspace=<id> → ChatContext  (the key that pays for the caller's chat)
export interface ChatContext {
  /** The caller's "Web chat" key in the workspace (or, for a key session, that key), with its limits and usage. */
  key: ApiKey
  workspaceName: string
}

/**
 * A chat turn a seller refused because its free tier is used up. The chat
 * stream's error text is this object as JSON; `freeTier.peerId` names the
 * seller whose pool raises the limit.
 */
export interface ChatFreeTierError {
  code: 'free_tier_exhausted'
  message: string
  freeTier: {
    peerId: string | null
    limitedBy: 'address' | 'ip' | 'stake' | 'stake_required'
    limit: number | null
    windowMs: number | null
    retryAfterSeconds: number | null
    stakeTiers: Array<{ minPower: number; multiplier: number | 'unlimited' }>
    /** The buyer's counted power in that seller's pool, in ANTS-epochs. */
    stakePower: number
    /** Requests per window the tier multipliers apply to; null from sellers that don't send it. */
    baseLimit: number | null
    /** The model is served only to buyers whose stake reaches a tier. */
    stakersOnly: boolean
  }
}

export interface ChatModel {
  id: string
  name: string
  /** At least one offer supports tool calls (the agent's web and file tools). */
  toolUse: boolean
  reasoning: boolean
  /** At least one offer takes images as input. */
  vision: boolean
  /** At least one offer is free to everyone (no input or output price, not stakers-only). */
  free: boolean
  /** At least one offer is free only to buyers staked on its seller. */
  freeForStakers: boolean
  /** At least one offer advertises the TEE verifier. */
  tee: boolean
  offers: number
  /** Cheapest offer's prices, USD per million tokens; null when not advertised. */
  inputUsdPerMillion: number | null
  outputUsdPerMillion: number | null
  /** The sellers offering it, best reputation first. */
  peers: ChatModelPeer[]
}

// ── Network & routing ───────────────────────────────────────────────────

// GET  /peers                     → Peer[]
// GET  /models                    → NetworkModel[]   (the buyer's `/v1/models`, unfiltered)
// GET  /route-preview?model=&workspace=&key=&member=&preset=   → RoutePreview
// GET  /routing/buyer-limits      → BuyerLimits
// GET  /routing                   → RoutingPolicy   (gateway default)
// PUT  /routing                   RoutingPolicy     → RoutingPolicy
// GET/POST /peer-lists, PATCH/DELETE /peer-lists/:id
//   PATCH (new peerIds) and DELETE answer 400 `empty_allow_list` (with
//   `usedBy: string[]`) when a policy that allows only this list's sellers
//   would be left with none; resend with `confirmEmpty: true` (PATCH body) or
//   `?confirmEmpty=true` (DELETE).
/** A seller ownership claim the buyer verified, as a display-safe link. */
export interface PeerVerificationLink {
  kind: 'domain' | 'github'
  /** `example.com`, `@user` or `@user/repo`. */
  label: string
  /** `https://<domain>` or `https://github.com/<user>[/<repo>]`. */
  href: string
}

/** Mirrors `TeeScope` in `@antseed/node/tee-status`, which the console cannot import. */
export type PeerTeeScope = 'end-to-end' | 'seller-node'

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
    /** The service has a listed price, per token or per unit (image, video). Older gateways omit it. */
    paid?: boolean
    /** The free-tier program this service is served under: its own, else the seller-wide one. */
    freeTier?: FreeTierProgramView | null
  }>
  trustScore: number | null
  reputationScore: number | null
  verified: boolean
  /** Verified domain and GitHub claims; empty when none checked out. */
  verificationLinks: PeerVerificationLink[]
  tee: boolean
  /**
   * How far a current TEE attestation reaches: 'end-to-end' (seller node and its model
   * provider) or 'seller-node' (the provider behind it is not TEE-attested). Null when the
   * seller is not TEE-capable or the buyer has not verified it yet.
   */
  teeScope: PeerTeeScope | null
  stakeAnts: string | null
  /** The seller's pool in the seller pools (its ERC-8004 agent id); null when it has none. */
  agentId: number | null
  /** The seller-wide free-tier program; null when it has none. Services may have their own (`services[].freeTier`). */
  freeTier: FreeTierProgramView | null
  usageShareBps: number | null
  washFlagged: boolean
  lastSeen: number | null
  health: { failureStreak: number; coolingDownUntil: number | null }
  /** Medians over this gateway's recent requests: total time, time to first token, and output tokens per second. */
  latencyMsP50: number | null
  firstTokenMsP50: number | null
  tokensPerSecondP50: number | null
  requests24h: number
}

export type NetworkModelType = 'text' | 'image' | 'decision' | 'video'

/** A feature at least one seller of the model advertises. */
export type NetworkModelCapability = 'toolUse' | 'reasoning' | 'structuredOutput' | 'vision'

/** A setting a router accepts in a request's `routing` object, as its routing protocol defines it. */
export type NetworkRouterOption = {
  key: string
  label: string
  description?: string
} & (
  | { type: 'integer' | 'number'; minimum?: number; maximum?: number; default?: number }
  | { type: 'boolean'; default?: boolean }
  | { type: 'string'; values?: string[]; default?: string }
)

/**
 * A routing service on the network: sent as the model, it picks the model
 * (and seller) for each request among the ones the caller's policy allows.
 */
export interface NetworkRouter {
  /** `<peerId>@<serviceId>`: the model to send to route through it. */
  id: string
  peerId: string
  serviceId: string
  provider: string
  /** The router's name, e.g. "Levanto Router". */
  name: string
  /** The seller offering it, by its display name. */
  sellerName: string | null
  /** Its routing protocol, e.g. `irp-suggest`. */
  protocol: string
  options: NetworkRouterOption[]
  /** USD per ranking; null when not advertised. */
  priceUsdPerRequest: number | null
  free: boolean
  /** Models it can rank, by the router's own names (`*`: any model); null when its list is unavailable. */
  models: string[] | null
  trustScore: number | null
  verified: boolean
  verificationLinks: PeerVerificationLink[]
}

/** `GET /favorites`: the model and router ids the caller starred, oldest first. */
export interface FavoriteModels {
  models: string[]
}

/** One seller's offer of a network model. */
export interface NetworkModelOffer {
  peerId: string
  displayName: string | null
  /** The seller's own name for the model; pin it as `<peerId>@<serviceId>`. */
  serviceId: string
  provider: string
  /** Wire APIs the seller serves the model on. */
  protocols: string[]
  inputUsdPerMillion: number | null
  outputUsdPerMillion: number | null
  cachedInputUsdPerMillion: number | null
  /** Image models: price per image, cheapest to dearest; null when not advertised. */
  usdPerImage: { min: number; max: number } | null
  contextLength: number | null
  free: boolean
  /**
   * The seller's pool (agent id) and the free-tier program this offer is
   * served under; see `Peer`. On a priced offer it is a free allowance: the
   * requests it covers are free, the rest are paid.
   */
  agentId: number | null
  freeTier: FreeTierProgramView | null
  /** The reputation routing ranks this offer by (0-100); null when unscored. */
  reputationScore: number | null
  trustScore: number | null
  verified: boolean
  /** The seller's verified domain and GitHub claims. */
  verificationLinks: PeerVerificationLink[]
  tee: boolean
  /**
   * How far a current TEE attestation reaches: 'end-to-end' (seller node and its model
   * provider) or 'seller-node' (the provider behind it is not TEE-attested). Null when the
   * seller is not TEE-capable or the buyer has not verified it yet.
   */
  teeScope: PeerTeeScope | null
  /** Medians over this gateway's recent requests: total time, time to first token, and output tokens per second. */
  latencyMsP50: number | null
  firstTokenMsP50: number | null
  tokensPerSecondP50: number | null
}

/** A model on the network, merged across the sellers that offer it (aliases included). */
export interface NetworkModel {
  id: string
  name: string
  aliases: string[]
  type: NetworkModelType
  /** Release-owned tags for the model (Coding, Reasoning, Vision, Open weights…); sellers cannot add any. */
  tags: string[]
  /** Largest context window a seller advertises; null when none does. */
  contextLength: number | null
  capabilities: NetworkModelCapability[]
  sellers: number
  /** Cheapest to dearest across offers, USD per million tokens; null when no offer advertises one. */
  inputUsdPerMillion: { min: number; max: number } | null
  outputUsdPerMillion: { min: number; max: number } | null
  /** At least one offer is free to everyone. */
  free: boolean
  /** At least one offer is free only to buyers staked on its seller (others pay, or are not served). */
  freeForStakers: boolean
  /** At least one priced offer has a free allowance before its price applies. */
  freeAllowance: boolean
  teeSellers: number
  /** Sellers whose TEE attestation reaches end to end, through their model provider. */
  fullTeeSellers: number
  verifiedSellers: number
  /** In the buyer's routing order. */
  offers: NetworkModelOffer[]
}

/**
 * The buyer's own config, the top level of every routing policy chain.
 * Hard limits (`minPeerReputation`, `requireVerifier`, `maxPricing`) apply
 * to every request, pinned ones included. `routingPreferences` (trust
 * minimum, allow and block lists, free-first) apply to automatic routing:
 * gateway levels narrow them like any other level and can never loosen
 * them. `maxPricing` is null when the config cannot be read;
 * `routingPreferences` is null when neither the buyer nor the config says.
 */
export interface BuyerLimits {
  minPeerReputation: number
  requireVerifier: boolean
  maxPricing: { inputUsdPerMillion: number; outputUsdPerMillion: number; cachedInputUsdPerMillion: number | null } | null
  routingPreferences: BuyerRoutingPreferences | null
}

export interface BuyerRoutingPreferences {
  minTrustScore: number
  allowedPeerIds: string[]
  blockedPeerIds: string[]
  preferFreePeers: boolean
}

export interface RoutePreview {
  model: string
  /** The policy that applies after combining every level. */
  policy: RoutingPolicy
  /**
   * Which levels contributed, top to bottom. The `buyer` entry holds the
   * buyer's config (`BuyerLimits` as a policy); the buyer applies it on top
   * of `policy`, which is the gateway levels only.
   */
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
    /** Eligible sellers: the numbers automatic routing ranks them by. Null when ineligible. */
    selection: RouteSelection | null
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
// PUT   /settings/telemetry        { enabled: boolean } → Settings
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

// GET   /update                    → GatewayUpdate  (org admins)
// POST  /update/check              → GatewayUpdate  (asks npm now)
// POST  /update                    → GatewayUpdate  (installer servers and the desktop app; body {action: 'download' | 'install'}:
//                                     download fetches the latest version, install switches to it and restarts; default install)
export interface GatewayUpdate {
  /**
   * What updates: `cli` is @antseed/cli from npm; `desktop` is the desktop
   * app running this gateway, whose own updater reports the versions below.
   */
  product: 'cli' | 'desktop'
  /** The running version (of the CLI, or of the desktop app). */
  current: string
  /** The newest version at the last check (npm's `latest`, or the app's newest release); null before the first answer. */
  latest: string | null
  available: boolean
  /** When npm was last asked (ms); null when never. */
  checkedAt: number | null
  /** Why the last check failed; null when it worked. */
  checkError: string | null
  /** `NO_UPDATE_NOTIFIER`, `ANTSEED_NO_UPDATE_CHECK` or `CI` turned background checks off. */
  checksDisabled: boolean
  /**
   * `console`: `POST /update` downloads and installs it (servers set up by the gateway
   * installer, and the desktop app); `command`: run `command` on the gateway
   * host; `none`: it updates some other way.
   */
  apply: 'console' | 'command' | 'none'
  install: InstallKind
  command: string | null
  /** One line on how this install updates. */
  note: string
  /** The update service's pending request or last run; null when `apply` is not `console` or it never ran. */
  progress: RootUpdateProgress | null
  /**
   * A version downloaded and waiting for Restart & update: newer than
   * `current`, whatever npm's `latest` has moved on to since. Null when none.
   */
  downloaded: string | null
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
  buyer: BuyerSettings
  observability: ObservabilitySettings
  /** Anonymous product telemetry: this gateway's setup funnel and the buyer it runs (docs/telemetry.md). */
  telemetry: TelemetrySettings
  auth: AuthConfig
  /**
   * Set by `PATCH /settings/buyer` when a change needs a buyer restart and
   * the buyer could not restart itself (not supervised, or unreachable): the
   * change is saved but applies only after the operator restarts it.
   * `observability.otlpHeaders` values read "••••" for anyone but org-admin
   * sessions; sending "••••" back keeps the stored value.
   */
  restartRequired?: boolean
}

/**
 * Every buyer setting in the config file the buyer behind the gateway
 * runs with. `routingPreferences` apply at once (the buyer reloads them);
 * everything else needs a buyer restart, which `PATCH /settings/buyer`
 * requests. `proxyPort` is read only: the gateway forwards to it.
 */
export interface BuyerSettings {
  proxyPort: number
  /** Hard price caps (defaults for every provider), USD per million tokens. */
  maxPricing: { inputUsdPerMillion: number; outputUsdPerMillion: number; cachedInputUsdPerMillion: number | null }
  /** Minimum seller reputation, 0–100, for every request (pins included). */
  minPeerReputation: number
  /** Automatic routing preferences; the top level of every routing policy. */
  routingPreferences: {
    minTrustScore: number
    /** Soft input-price limit: sellers above it rank lower, never excluded. */
    maxInputUsdPerMillion: number
    allowedPeerIds: string[]
    blockedPeerIds: string[]
    preferFreePeers: boolean
  }
  /** Seller verification by verifier SDKs (e.g. TEE attestation). */
  verifier: { enabled: boolean; prefer: string[]; require: boolean }
  /** Kept for older clients: `verifier.require`. */
  requireVerifier: boolean
  payments: {
    /** Sweep USDC arriving in the buyer wallets into deposits automatically. */
    autoSweep: boolean
    /** Most USDC authorized for a single request. */
    maxPerRequestUsdc: number
    /** Most USDC reserved for one payment channel. */
    maxReserveUsdc: number
    /** Base RPC endpoint; null uses the chain default. Path and query (API keys) are masked unless revealed. */
    rpcUrl: string | null
    fallbackRpcUrls: string[]
  }
  network: {
    peerRefreshIntervalMs: number
    metadataFetchTimeoutMs: number
    requestTimeoutMs: number
    maxStreamDurationMs: number
    /** Leave per-service attribution out of signed request metadata. */
    disableMetadataV2Services: boolean
  }
  /** Response-auth evidence sampling. */
  evidence: { sampleRate: number | null; maxSampleBytes: number | null }
  /**
   * Setting paths (e.g. "maxPricing.inputUsdPerMillion", "verifier") the
   * running buyer takes from its environment or start flags instead: editing
   * them here is saved but has no effect until that override is removed.
   * Empty when the buyer is unreachable.
   */
  overrides: string[]
}

/** A partial `BuyerSettings`: only the fields sent change. Lists replace the saved list. */
export interface BuyerSettingsInput {
  maxPricing?: { inputUsdPerMillion?: number; outputUsdPerMillion?: number; cachedInputUsdPerMillion?: number | null }
  minPeerReputation?: number
  routingPreferences?: Partial<BuyerSettings['routingPreferences']>
  verifier?: Partial<BuyerSettings['verifier']>
  payments?: Partial<BuyerSettings['payments']>
  network?: Partial<BuyerSettings['network']>
  evidence?: Partial<BuyerSettings['evidence']>
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

/**
 * The same switch as the desktop's Preferences → Privacy and
 * `antseed telemetry enable|disable`: `telemetry.enabled` in the config
 * file. The gateway and its buyer re-read it, so a change applies at once.
 */
export interface TelemetrySettings {
  /** False when this build has no PostHog project, or the environment turns it off (ANTSEED_TELEMETRY=0, DO_NOT_TRACK=1, CI). */
  available: boolean
  enabled: boolean
  /** Turned off in the config file (here, in the CLI or in the desktop). */
  userDisabled: boolean
}

// ── Seller monitoring ────────────────────────────────────────────────────
// Read-only views of a seller on this host, from its data directory:
// daemon.state.json (written every second while it runs), seller-events.jsonl
// and metering.db. Served by the gateway console to org admins when the host
// runs a seller, and by `antseed seller dashboard`.
//
// GET /seller/status            → SellerStatus  ({ available: false } when no seller is found)
// GET /seller/events?limit=     → { events: SellerEventView[] }  (newest first, limit ≤ 500)
// GET /seller/usage?days=       → SellerUsage   (UTC days, days ≤ 30)

export interface SellerModelHealth {
  provider: string
  /** The seller config's provider name; tells apart upstreams that share a plugin. Older sellers: same as `provider`. */
  providerId: string
  service: string
  /** False when the seller withdrew the service after failing health probes. */
  advertised: boolean
  consecutiveFailures: number
  lastProbeAt: number | null
  lastStatusCode: number | null
  lastDetail: string | null
}

export interface SellerGas {
  address: string
  depleted: boolean
  balanceEth: number | null
  minBalanceEth: number
  lastCheckedAt: number | null
}

export interface SellerAlertsState {
  /** Configured delivery channels, e.g. ['telegram', 'webhook']; empty when alerts are off. */
  channels: string[]
  lastSentAt: number | null
  lastError: string | null
}

export type SellerStatus =
  | { available: false }
  | {
      available: true
      /** The daemon wrote its state in the last 15 s. */
      running: boolean
      dataDir: string
      peerId: string | null
      provider: string | null
      startedAt: number | null
      updatedAt: number | null
      activeChannels: number
      capacityUsedPercent: number
      notices: string[]
      models: SellerModelHealth[]
      /** Null when the seller runs without payments or predates gas checks. */
      gas: SellerGas | null
      /** Null when the seller predates alerts. */
      alerts: SellerAlertsState | null
      version: string
      /** Chain RPC calls per source, this process's and the seller daemon's (on the API, not the file reader). */
      rpc?: SellerRpcDiagnostics
    }

export type SellerEventSeverity = 'info' | 'warning' | 'critical'

export interface SellerEventView {
  at: number
  kind: string
  severity: SellerEventSeverity
  title: string
  detail?: string
  provider?: string
  service?: string
}

export interface SellerUsageDay {
  /** UTC day start, epoch ms. */
  day: number
  requests: number
  tokens: number
  sessions: number
  revenueUsd: number
}

export interface SellerUsage {
  days: SellerUsageDay[]
  channels: { active: number; settled: number; timeout: number; ghost: number; total: number }
  /** From the local channel ledger. */
  deliveredUsdc: number
  settledUsdc: number
}

// Seller settings (org admins in the gateway console; the seller dashboard session):
// GET   /seller/settings                 → { settings: SellerSettings, alerts: SellerAlertSettings }
// PATCH /seller/settings   SellerSettingsPatch → { settings, alerts, changed: string[] }  (applies when the seller restarts; config.json.bak keeps the previous file)
// PATCH /seller/alerts     SellerAlertsPatch   → { settings, alerts, changed }            (applies live)
// POST  /seller/alerts/test { channel }         → { sent: string[], errors: string[] }
// POST  /seller/alerts/telegram/chats { botToken? } → { chats: TelegramChat[] }  (the saved token when botToken is omitted)
// 409 config_read_only when the config file cannot be written (e.g. a ConfigMap mount).

export interface SellerServicePricing {
  provider: string
  service: string
  inputUsdPerMillion: number | null
  outputUsdPerMillion: number | null
  cachedInputUsdPerMillion: number | null
  /** Priced by the provider's defaults (no price of its own). */
  inherited: boolean
  /** Charges anything (a token price or a priced unit-billing model); free models fall under the seller-wide program. */
  paid: boolean
  /** Its per-unit price (per image, per video) when it bills by unit; its token prices are then usually zero. */
  unitPrice: SellerUnitPrice | null
  /** What it makes, from its billing models and capabilities: buyers call each kind on a different API. */
  kind: SellerServiceKind
  /** Wire APIs it is billed or announced on, when the config says (e.g. "openai-images"); empty otherwise. */
  apiProtocols: string[]
  /**
   * The free tier buyers of this model get, as advertised: its own program,
   * else (on a free model) the seller-wide one. On a paid model it is a free
   * allowance before the price applies. Null: no limit (free model) or none (paid).
   */
  freeTier: FreeTierProgramView | null
  /** This model's own program as written in the config file; null when it has none. */
  ownFreeTier: SellerFreeTierProgramSettings | null
}

/** A unit-billed service's price: the cheapest and dearest of its priced components for one unit. */
export interface SellerUnitPrice {
  /** "output_images", "video_generations", "video_seconds" or "completed_requests". */
  unit: string
  /** What one unit is, for "$0.02 / image": "image", "video", "video second", "request". */
  name: string
  minUsd: number
  maxUsd: number
}

export type SellerServiceKind = 'text' | 'image' | 'video' | 'other'

/** A free-tier program as written in config.json (`seller.freeTier` or a service's `freeTier`). */
export interface SellerFreeTierProgramSettings {
  maxRequestsPerAddress: number | null
  maxRequestsPerIp: number | null
  windowMs: number | null
  stakersOnly: boolean
  /** null: the network default tiers. [] turns staked tiers off. */
  stakeTiers: Array<{ minPower: number; multiplier: number | 'unlimited' }> | null
}

/** Edits one free-tier program; null removes a field (a service's `freeTier: null` removes its program). */
export interface SellerFreeTierProgramPatch {
  maxRequestsPerAddress?: number | null
  maxRequestsPerIp?: number | null
  windowMs?: number | null
  stakersOnly?: boolean
  /** null goes back to the network default; [] turns staked tiers off. */
  stakeTiers?: Array<{ minPower: number; multiplier: number | 'unlimited' }> | null
}

/** Whether the dashboard can restart the seller to apply saved settings. */
export interface SellerRestartView {
  available: boolean
  /** Why not, when it cannot. */
  reason: string | null
}

export interface SellerSettings {
  configPath: string
  writable: boolean
  readOnlyReason: string | null
  /** Where a save goes: the config file, or the data dir's overrides when the file is read-only (or overrides exist). */
  savesTo: 'config' | 'overrides' | null
  /** The overrides file, when saves go there or one exists. */
  overridesPath: string | null
  /** Settings saved as overrides, as dotted config paths (`seller.maxConcurrentBuyers`). */
  overridden: string[]
  displayName: string
  maxConcurrentBuyers: number
  healthCheck: { enabled: boolean; intervalMs: number; failureThreshold: number }
  gasCheck: { enabled: boolean; minBalanceEth: number }
  /** The seller-wide program for free models. */
  freeTier: SellerFreeTierProgramSettings
  /** The network's default staked tiers, used where a program sets none. */
  defaultStakeTiers: Array<{ minPower: number; multiplier: number | 'unlimited' }>
  restrictedCountries: string[]
  /** Not set in the file: the built-in list applies. */
  restrictedCountriesDefault: boolean
  services: SellerSettingsService[]
  /** The configured providers, for adding a model under one. */
  providers: SellerSettingsProvider[]
}

/** A service as the settings edit it: its price and free tier, whether it is offered, and its per-unit prices. */
export interface SellerSettingsService extends SellerServicePricing {
  /** Offered to buyers; a model turned off stays in the config but is not started. */
  enabled: boolean
  /** The model id sent upstream, when it differs from the service id. */
  upstreamModel: string | null
  categories: string[]
  /** Each priced component of its unit billing (per image, per video second…), editable one by one. */
  unitComponents: SellerUnitComponent[]
}

export interface SellerUnitComponent {
  protocol: string
  unit: string
  /** What the component applies to (`{ resolution: '4k' }`); null for every request. */
  match: Record<string, unknown> | null
  priceUsd: number
}

export interface SellerSettingsProvider {
  name: string
  plugin: string
  /** Its services bill per unit (image, video): new models there are added in the config file, with their capabilities. */
  unitBilled: boolean
  /** A routing plugin that offers exactly one service: no model can be added under it. */
  singleService: boolean
  /** Services under it, offered or not. */
  services: number
}

/** A token-billed model added under an existing provider. */
export interface SellerNewService {
  provider: string
  service: string
  upstreamModel?: string
  categories?: string[]
  inputUsdPerMillion: number
  outputUsdPerMillion: number
  cachedInputUsdPerMillion?: number
}

export interface SellerSettingsPatch {
  displayName?: string
  maxConcurrentBuyers?: number
  healthCheck?: { enabled?: boolean; intervalMs?: number; failureThreshold?: number }
  gasCheck?: { enabled?: boolean; minBalanceEth?: number }
  /** The seller-wide program; null removes a limit. */
  freeTier?: SellerFreeTierProgramPatch
  /** null goes back to the built-in list. */
  restrictedCountries?: string[] | null
  /** Prices and each model's own free tier (`freeTier: null` removes it, so a free model falls back to the seller-wide one). */
  pricing?: Array<{
    provider: string
    service: string
    inputUsdPerMillion?: number
    outputUsdPerMillion?: number
    cachedInputUsdPerMillion?: number | null
    freeTier?: SellerFreeTierProgramPatch | null
    /** false turns the model off (kept in the config, not offered); true offers it again. */
    enabled?: boolean
    /** New prices for unit-billing components, each found by its protocol, unit and match. */
    unitPrices?: Array<{ protocol: string; unit: string; match: Record<string, unknown> | null; priceUsd: number }>
  }>
  /** Token-billed models to add under existing providers. */
  addServices?: SellerNewService[]
  /** Models to remove from the config (their own free tier and prices with them). */
  removeServices?: Array<{ provider: string; service: string }>
}

export interface SellerAlertSettings {
  writable: boolean
  readOnlyReason: string | null
  telegram: {
    chatId: string | null
    botTokenEnv: string
    /** Whether a bot token exists; the token itself is never sent to the browser. */
    tokenSet: boolean
    tokenSource: 'env' | 'file' | null
    /** Token and chat id both present: alerts go out. */
    active: boolean
  }
  /** Only the host: the URL itself may carry a secret. */
  webhook: { set: boolean; host: string | null; source: 'file' | 'config' | null }
  idleMinutes: number | null
  cooldownMinutes: number | null
  /** USD under which an upstream that reports its balance is a warning; null is the default ($5), 0 off. */
  lowBalanceUsd: number | null
  minSeverity: 'info' | 'warning' | 'critical' | null
}

/** Each field: a value sets it, null clears it, absent keeps it. */
export interface SellerAlertsPatch {
  telegramChatId?: string | null
  telegramBotToken?: string | null
  webhookUrl?: string | null
  idleMinutes?: number | null
  cooldownMinutes?: number | null
  lowBalanceUsd?: number | null
  minSeverity?: 'info' | 'warning' | 'critical' | null
}

export interface TelegramChat {
  id: string
  title: string
  type: string
}

// Seller market, reputation and promotion (same access as the other /seller routes):
// GET  /seller/market?refresh=1      → SellerMarket       (network snapshot cached ~15 min; refresh=1 starts a background refresh)
// GET  /seller/reputation?refresh=1  → SellerReputation   (trust from the same snapshot; on-chain standing cached ~10 min)
// GET  /seller/promote               → SellerPromote
// POST /seller/promote/check         → SellerPromote      (re-checks the verification claims now)
// PUT  /seller/promote/verifications { domains: [{ domain }], github: [{ username, repository? }] } → SellerPromote
//   (writes seller.verifications through the settings writer; applies when the seller restarts)

/** Where the market and trust numbers come from; never blocks a request. */
export interface SellerNetworkMeta {
  /** e.g. "gateway buyer", "local buyer daemon", "DHT discovery". */
  source: string | null
  refreshedAt: number | null
  refreshing: boolean
  error: string | null
  peers: number
}

export interface SellerMarketOffer {
  peerId: string
  name: string | null
  mine: boolean
  inputUsdPerMillion: number | null
  outputUsdPerMillion: number | null
  cachedInputUsdPerMillion: number | null
  /** (3 × input + output) / 4: a typical chat mix, for ranking; null on a unit-billed offer. */
  blendedUsdPerMillion: number | null
  /** Per-unit price of a unit-billed offer (image, video); null when it bills by token. */
  unitPrice: SellerUnitPrice | null
  trustScore: number | null
  tee: boolean
  /** In-flight requests over capacity, 0-1; null when the seller does not say. */
  load: number | null
}

export interface SellerMarketService {
  provider: string
  service: string
  mine: { inputUsdPerMillion: number | null; outputUsdPerMillion: number | null; cachedInputUsdPerMillion: number | null; blendedUsdPerMillion: number | null; unitPrice: SellerUnitPrice | null }
  /**
   * What the comparison is in: null for token prices (blended), else the unit
   * this seller bills by (say "output_images"): only offers priced in the same
   * unit are compared, by their cheapest per-unit price.
   */
  unit: string | null
  /** Other sellers offering the same model. */
  competitors: number
  /** No one else offers it. */
  unique: boolean
  /** Among comparable offers: token prices, or `unitUsd` in `unit`. */
  cheapest: { inputUsdPerMillion: number | null; outputUsdPerMillion: number | null; unitUsd: number | null } | null
  median: { inputUsdPerMillion: number | null; outputUsdPerMillion: number | null; unitUsd: number | null } | null
  /** 1 = cheapest (blended, or per unit), among every comparable seller of the model (this one included). */
  rank: number | null
  of: number
  /** This seller's price vs the comparable sellers' median, in percent (+ is pricier). */
  deltaPct: number | null
  offers: SellerMarketOffer[]
}

export interface SellerMarket {
  network: SellerNetworkMeta
  /** This seller was found in the snapshot. */
  found: boolean
  services: SellerMarketService[]
  /** Models other sellers offer that this one does not, most widely offered first. `cheapestOutputUsdPerMillion` over token-priced offers; `cheapestUnitPrice` over unit-billed ones (the cheapest in their most common unit). */
  notOffered: Array<{ service: string; sellers: number; cheapestOutputUsdPerMillion: number | null; cheapestUnitPrice: SellerUnitPrice | null }>
}

export interface SellerTrustPart {
  score: number
  max: number
}

export interface SellerTrust {
  score: number
  history: (SellerTrustPart & { channelCount: number; volumeUsdc: number }) | null
  usage: (SellerTrustPart & { shareBps: number; epoch: number }) | null
  power: (SellerTrustPart & { shareBps: number; epoch: number }) | null
  identity: (SellerTrustPart & { kind: 'github' | 'domain'; claim: string }) | null
  freeModels: (SellerTrustPart & { service: string }) | null
  washFlagged: boolean | null
}

export interface SellerStanding {
  address: string
  agentId: number
  identityRegistered: boolean
  registryBound: boolean
  eligible: boolean
  /** ANTS, decimal strings. */
  minPoolStake: string | null
  poolActiveStake: string
  pool: {
    powerShareBps: number
    stakers: number | null
    uniqueBuyers: number | null
    requestCount: string | null
    /** USDC, decimal string. */
    lifetimeVolumeUsdc: string | null
    /** Percent of channels that timed out unsettled. */
    ghostRate: number | null
    lastEpochEmission: string | null
  } | null
  /** Seller usage rewards waiting to be claimed, ANTS. */
  pendingRewards: string | null
}

export interface SellerReputation {
  network: SellerNetworkMeta
  found: boolean
  trust: SellerTrust | null
  /** Position by trust score among the sellers in the snapshot. */
  rank: { position: number; of: number } | null
  /** One plain next step per part that has room to grow. */
  steps: Array<{ part: 'history' | 'usage' | 'power' | 'identity' | 'freeModels' | 'wash' | 'standing'; text: string }>
  standing: SellerStanding | null
  standingError: string | null
  standingRefreshedAt: number | null
}

export interface SellerVerificationStatus {
  verified: boolean
  checkedAt: number
  error: string | null
}

export interface SellerPromote {
  peerId: string | null
  displayName: string
  /** The seller's page on the explorer; null without a peer id or explorer. */
  profileUrl: string | null
  services: Array<{ provider: string; service: string; inputUsdPerMillion: number | null; outputUsdPerMillion: number | null; unitPrice: SellerUnitPrice | null; kind: SellerServiceKind; apiProtocols: string[] }>
  trustScore: number | null
  /** The trust score's first network load or a verification check is still running: read again shortly. */
  pending: boolean
  writable: boolean
  readOnlyReason: string | null
  domains: Array<{ domain: string; txtName: string; txtValue: string; wellKnownUrl: string; wellKnownBody: string; status: SellerVerificationStatus | null }>
  github: Array<{ username: string; repository: string; proofUrl: string; proofBody: string; status: SellerVerificationStatus | null }>
}

export interface SellerVerificationsInput {
  domains: Array<{ domain: string }>
  github: Array<{ username: string; repository?: string }>
}

// GET /seller/logs?cursor=&limit=&service=&buyer=&from=&errors=1 → SellerLogPage (newest first, keyset-paged)

export interface SellerLogEntry {
  id: string
  at: number
  /** Buyer peer id. */
  buyer: string
  sessionId: string
  /** Model the buyer asked for; null on rows recorded before sellers kept it. */
  service: string | null
  provider: string
  inputTokens: number
  outputTokens: number
  /** Tokens as the upstream reported them (true) or estimated from body size. */
  exactTokens: boolean
  /** From the signed usage receipt, in USD; null for free requests or without a receipt. */
  costUsd: number | null
  latencyMs: number
  statusCode: number
  streaming: boolean
  /** Why it failed, from the upstream's error (null when it succeeded or on older rows). */
  error: string | null
  /** Input tokens the upstream served from its prompt cache, when it reported them. */
  cachedInputTokens: number | null
}

/**
 * One request with everything the seller kept about it (GET /seller/logs/:id):
 * the signed usage receipt and the buyer's check of it, the buyer's run of
 * requests it belongs to, and the payment channel that was open for the buyer then.
 */
export interface SellerLogDetail extends SellerLogEntry {
  /** How sure the token count is: high (upstream usage), low (estimated from body size). */
  tokenConfidence: string
  receipt: {
    id: string
    /** Price the receipt was signed at, USD per 1M tokens. */
    usdPerMillionTokens: number
    /** Set once the buyer checked the receipt against its own count. */
    buyerCheck: { signatureValid: boolean; buyerTokens: number; differencePercent: number; disputed: boolean } | null
  } | null
  session: {
    id: string
    /** 1-based position of this request in the session. */
    position: number
    startedAt: number | null
    endedAt: number | null
    requests: number | null
    tokens: number | null
    costUsd: number | null
    avgLatencyMs: number | null
  }
  /** The buyer's payment channel open at the time; null for free requests or when none matches. */
  channel: {
    id: string
    /** A one-off channel pays for this request alone; a regular one covers a buyer's run of requests. */
    oneOff: boolean
    status: string
    openedAt: number
    settledAt: number | null
    /** Most the buyer authorized for the channel, USD. */
    authorizedUsd: number
    /** Delivered (owed) on the channel so far, USD. */
    deliveredUsd: number
    settledUsd: number | null
    requests: number
  } | null
}

export interface SellerLogPage {
  entries: SellerLogEntry[]
  /** Pass as `cursor` for the next (older) page; null at the end. */
  next: string | null
}

export interface SellerLogQuery {
  cursor?: string | null
  limit?: number
  service?: string | null
  buyer?: string | null
  /** Oldest request time to include, Unix ms. */
  from?: number | null
  errorsOnly?: boolean
}

/** RPC calls this process made per source (and the seller daemon's, from its state file). */
export interface SellerRpcDiagnostics {
  process: Record<string, { total: number; lastMinute: number; perMinute: number }>
  daemon: Record<string, { total: number; lastMinute: number; perMinute: number }> | null
}
