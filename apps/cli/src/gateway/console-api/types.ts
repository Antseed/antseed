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
  /** Antseed Points of the buyer wallet (`address`); null when the explorer cannot be read. */
  points?: RewardsPoints | null
  /** Last known values: the chain RPC is unreachable or rate limiting right now. */
  stale?: boolean
}

/** A buyer's Antseed Points: paid $ × the provider's boost, converted to ANTS when the epoch ends. */
export interface RewardsPoints {
  epoch: number
  /** When this epoch's points convert to ANTS (ms since 1970); null when unknown. */
  endsAt: number | null
  points: number
  /** This epoch's points at the live rate, capped at 5% of the buyer pot; null when the pot cannot be read. */
  estimatedAnts: number | null
  capped: boolean
  /** This epoch's buyer ANTS pot and everyone's points so far, for the spend calculator; null when unavailable. */
  potAnts: number | null
  totalPoints: number | null
  /** When this epoch started (ms since 1970), to pace the end-of-week projection; null when unknown. */
  startsAt: number | null
  /** Everyone's points per day on a busy day (the projection's low end); null when unknown. */
  busyPointsPerDay: number | null
  /** Points per epoch with any, newest first. */
  history: Array<{ epoch: number; points: number }>
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
  /**
   * Antseed Points boost of the seller's pool (pool power ÷ 10,000 ANTS × 104 epochs):
   * points per $1 spent with it. 0 earns nothing; null when Antscan is unreachable.
   */
  boost: number | null
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
