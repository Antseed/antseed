import type {
  AdminToken, ApiKey, ApiKeyInput, AuditEntry, AuthConfig, BuyerLimits, BuyerSettingsInput, Channel, ChainInfo, DepositWatch, Enrollment,
  GatewayStatus, Invite, InviteInput, Member, MemberInput, MeResponse, ObservabilitySettings, OperatorAuthorization, OperatorState, Peer, PeerList, Preset,
  RequestDetail, RequestLogEntry, Rewards, RoutePreview, RoutingPolicy, Settings, SpendLimits, UsageGroupBy, UsageReport, Wallet, Workspace,
  WorkspaceInput, WorkspaceRole,
} from './types'

export const API_BASE = '/console/api'
export const CSRF_HEADER = 'x-antseed-console'

/** An error response from the console API, `{ error: { code, message } }` plus the HTTP status. */
export class ConsoleApiError extends Error {
  /** The whole error body; some errors carry more than code and message (e.g. 409 `narrowed` returns the effective key). */
  readonly details: Record<string, unknown>
  constructor(readonly status: number, readonly code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ConsoleApiError'
    this.details = details
  }
}

export function isApiError(error: unknown, code?: string): error is ConsoleApiError {
  return error instanceof ConsoleApiError && (code === undefined || error.code === code)
}

/** Clearer copy for API error codes whose server message assumes too much context. */
export const ERROR_COPY: Record<string, string> = {
  buyer_policy_unsupported: 'The buyer behind this gateway cannot apply routing policies yet. Update Antseed on the buyer host and restart it.',
  restart_unsupported: 'The buyer cannot restart itself here. The change is saved; restart the buyer yourself to apply it.',
  reauth_required: 'For this action, sign in again first.',
  config_unreadable: 'The gateway could not read the buyer configuration file, so nothing was changed. Check the file on the gateway host.',
  operator_not_yours: 'That wallet is not one of your sign-in methods. Add it as a sign-in method first, then authorize it.',
  reauth_wrong_member: 'That passkey or wallet belongs to someone else. Confirm with one of your own sign-in methods.',
  reauth_unavailable: 'You are signed in through Cloudflare Access, which cannot confirm this action. Sign in with a passkey or wallet instead (add one under Your sign-in methods first if you have none), then retry.',
  access_reauth_required: 'Your Cloudflare Access sign-in is more than 5 minutes old. Sign out of Cloudflare Access, sign in again, then retry.',
  reauth_other_credential: 'Confirm with a different passkey or wallet than the one you are making the operator, then retry.',
  session_required: 'Only an organization admin signed in to the console can change the export endpoint or content logging. Management tokens cannot.',
  otlp_headers_required: 'You changed the endpoint, so the saved header values are not sent to it. Enter the header values again.',
  empty_allow_list: 'This allow list is empty, so no seller could serve. Confirm to save it anyway.',
  last_credential: 'You cannot remove your only sign-in method, or you could not sign in again. Add another passkey or wallet first.',
  credential_exists: 'This passkey or wallet is already registered.',
  max_keys_reached: 'You already have as many keys as you are allowed. Revoke one, or ask an admin to raise your limit.',
}

export function errorMessage(error: unknown): string {
  if (error instanceof ConsoleApiError && ERROR_COPY[error.code]) return ERROR_COPY[error.code]!
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : 'Something went wrong.'
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * Policy writes: an allow list that lets no seller serve is refused (400
 * `empty_allow_list`) unless `confirmEmpty`; a policy or limit asking for
 * more than the levels above allow is refused (409 `narrowed`, nothing
 * stored) unless `acceptNarrowed`.
 */
export interface SaveOptions { confirmEmpty?: boolean; acceptNarrowed?: boolean }

export function withConfirm<T extends object>(body: T, options?: SaveOptions): T {
  return {
    ...body,
    ...(options?.confirmEmpty ? { confirmEmpty: true } : {}),
    ...(options?.acceptNarrowed ? { acceptNarrowed: true } : {}),
  }
}
type QueryValue = string | number | boolean | null | undefined
type Query = { [key: string]: QueryValue } | object

export function buildQuery(query: Query | undefined): string {
  if (!query) return ''
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(query) as Array<[string, QueryValue]>) {
    if (value === undefined || value === null || value === '') continue
    params.set(key, String(value))
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

async function readError(response: Response): Promise<ConsoleApiError> {
  let code = `http_${response.status}`
  let message = response.statusText || `Request failed (${response.status})`
  let details: Record<string, unknown> = {}
  try {
    const body = await response.json() as { error?: { code?: unknown; message?: unknown } }
    if (body?.error && typeof body.error.code === 'string') code = body.error.code
    if (body?.error && typeof body.error.message === 'string') message = body.error.message
    if (body && typeof body === 'object') details = { ...(body.error as object), ...body }
  } catch { /* not JSON */ }
  return new ConsoleApiError(response.status, code, message, details)
}

export interface RequestOptions {
  query?: Query
  body?: unknown
}

/** One typed client for every console API route. Mutations carry the CSRF header. */
export function createApiClient(fetchImpl: FetchLike = (input, init) => fetch(input, init), base = API_BASE) {
  async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' }
    const mutating = method !== 'GET' && method !== 'HEAD'
    if (mutating) headers[CSRF_HEADER] = '1'
    let body: string | undefined
    if (options.body !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(options.body)
    }
    let response: Response
    try {
      response = await fetchImpl(`${base}${path}${buildQuery(options.query)}`, { method, headers, body, credentials: 'same-origin' })
    } catch {
      throw new ConsoleApiError(0, 'network_error', 'Could not reach the gateway.')
    }
    if (!response.ok) throw await readError(response)
    if (response.status === 204) return undefined as T
    const type = response.headers.get('content-type') ?? ''
    if (!type.includes('json')) return await response.text() as T
    return await response.json() as T
  }

  const get = <T>(path: string, query?: Query) => request<T>('GET', path, { query })
  const post = <T>(path: string, body?: unknown) => request<T>('POST', path, { body: body ?? {} })
  const patch = <T>(path: string, body: unknown) => request<T>('PATCH', path, { body })
  const put = <T>(path: string, body: unknown) => request<T>('PUT', path, { body })
  const del = (path: string) => request<void>('DELETE', path)
  const id = encodeURIComponent

  return {
    request,
    auth: {
      config: () => get<AuthConfig>('/auth/config'),
      me: () => get<MeResponse>('/auth/me'),
      setup: (token: string) => post<Enrollment>('/auth/setup', { token }),
      invite: (token: string) => post<Enrollment>('/auth/invite', { token }),
      passkeyRegisterOptions: (enrollment?: string) => post<unknown>('/auth/passkey/register/options', { enrollment }),
      passkeyRegisterVerify: (response: unknown, enrollment?: string) => post<MeResponse>('/auth/passkey/register/verify', { enrollment, response }),
      passkeyLoginOptions: () => post<unknown>('/auth/passkey/login/options', {}),
      passkeyLoginVerify: (response: unknown) => post<MeResponse>('/auth/passkey/login/verify', { response }),
      walletNonce: (address: string) => post<{ message: string }>('/auth/wallet/nonce', { address }),
      walletVerify: (message: string, signature: string, enrollment?: string) => post<MeResponse>('/auth/wallet/verify', { message, signature, enrollment }),
      oidcStartUrl: (enrollment?: string) => `${base}/auth/oidc/start${buildQuery({ enrollment })}`,
      /** Links the provider account to the signed-in member (needs a fresh sign-in; errors come back as /console/login?error=). */
      oidcLinkUrl: () => `${base}/auth/oidc/start?link=1`,
      reauthPasskeyOptions: () => post<unknown>('/auth/reauth/passkey/options', {}),
      reauthPasskeyVerify: (response: unknown) => post<MeResponse>('/auth/reauth/passkey/verify', { response }),
      reauthWalletNonce: (address: string) => post<{ message: string }>('/auth/reauth/wallet/nonce', { address }),
      reauthWalletVerify: (message: string, signature: string) => post<MeResponse>('/auth/reauth/wallet/verify', { message, signature }),
      apiKey: (key: string) => post<MeResponse>('/auth/api-key', { key }),
      logout: () => post<void>('/auth/logout'),
    },
    members: {
      list: () => get<Member[]>('/members'),
      update: (memberId: string, input: Partial<MemberInput>, options?: SaveOptions) => patch<Member>(`/members/${id(memberId)}`, withConfirm(input, options)),
      disable: (memberId: string) => post<Member>(`/members/${id(memberId)}/disable`),
      enable: (memberId: string) => post<Member>(`/members/${id(memberId)}/enable`),
      removeCredential: (memberId: string, credentialId: string) => del(`/members/${id(memberId)}/credentials/${id(credentialId)}`),
    },
    invites: {
      list: () => get<Invite[]>('/invites'),
      create: (input: InviteInput) => post<Invite>('/invites', input),
      revoke: (inviteId: string) => del(`/invites/${id(inviteId)}`),
    },
    workspaces: {
      list: () => get<Workspace[]>('/workspaces'),
      get: (workspaceId: string) => get<Workspace>(`/workspaces/${id(workspaceId)}`),
      create: (input: WorkspaceInput, options?: SaveOptions) => post<Workspace>('/workspaces', withConfirm(input, options)),
      update: (workspaceId: string, input: WorkspacePatch, options?: SaveOptions) => patch<Workspace>(`/workspaces/${id(workspaceId)}`, withConfirm(input, options)),
      remove: (workspaceId: string) => del(`/workspaces/${id(workspaceId)}`),
      members: (workspaceId: string) => get<Array<{ member: Member; role: WorkspaceRole }>>(`/workspaces/${id(workspaceId)}/members`),
      setMember: (workspaceId: string, memberId: string, role: WorkspaceRole) => put<void>(`/workspaces/${id(workspaceId)}/members/${id(memberId)}`, { role }),
      removeMember: (workspaceId: string, memberId: string) => del(`/workspaces/${id(workspaceId)}/members/${id(memberId)}`),
    },
    keys: {
      list: (filter: { workspace?: string; member?: string } = {}) => get<ApiKey[]>('/keys', filter),
      create: (input: ApiKeyCreate, options?: SaveOptions) => post<{ key: ApiKey; secret: string }>('/keys', withConfirm(input, options)),
      /** May fail with 409 `narrowed` (details carry the effective key) when an owner's change was only partly applied. */
      update: (keyId: string, input: ApiKeyPatch, options?: SaveOptions) => patch<ApiKey>(`/keys/${id(keyId)}`, withConfirm(input, options)),
      rotate: (keyId: string) => post<{ key: ApiKey; secret: string }>(`/keys/${id(keyId)}/rotate`),
      revoke: (keyId: string) => post<ApiKey>(`/keys/${id(keyId)}/revoke`),
    },
    adminTokens: {
      list: () => get<AdminToken[]>('/admin-tokens'),
      /** `expiresInDays` defaults to 90 on the gateway; null (never) is owners only. */
      create: (label: string, scope: AdminToken['scope'], expiresInDays?: number | null) =>
        post<{ token: AdminToken; secret: string }>('/admin-tokens', { label, scope, ...(expiresInDays !== undefined ? { expiresInDays } : {}) }),
      revoke: (tokenId: string) => del(`/admin-tokens/${id(tokenId)}`),
    },
    usage: {
      /** `splitBy` adds per-group splits (e.g. per day, per model) in the same request. */
      report: (filter: UsageFilter & { groupBy?: UsageGroupBy; splitBy?: UsageGroupBy }) => get<UsageReport>('/usage', filter),
      requests: (filter: RequestQuery & { before?: string; limit?: number }) =>
        get<{ requests: RequestLogEntry[]; nextBefore: string | null }>('/requests', filter),
      request: (tag: string) => get<RequestDetail>(`/requests/${id(tag)}`),
      exportUrl: (filter: RequestQuery & { groupBy?: UsageGroupBy }) => `${base}/usage/export.csv${buildQuery(filter)}`,
    },
    audit: {
      list: (filter: AuditQuery & { before?: string; limit?: number }) => get<{ entries: AuditEntry[]; nextBefore: string | null }>('/audit', filter),
    },
    wallet: {
      get: (workspaceId: string) => get<Wallet>(`/workspaces/${id(workspaceId)}/wallet`),
      cardLink: (workspaceId: string, amountUsd: number, provider: 'crossmint' | 'stripe') =>
        post<{ url: string }>(`/workspaces/${id(workspaceId)}/wallet/card-link`, { amountUsd, provider }),
      watch: (workspaceId: string, mode: 'active' | 'background') => post<DepositWatch>(`/workspaces/${id(workspaceId)}/wallet/watch`, { mode }),
      /** The authorized wallet (AntseedDeposits operator); `fresh` re-reads the chain (the gateway throttles it). */
      operator: (workspaceId: string, fresh = false) =>
        get<OperatorState>(`/workspaces/${id(workspaceId)}/wallet/operator`, { fresh: fresh ? 1 : undefined }),
      /** Re-read after a confirmed transaction; the gateway audits a change the chain confirms. */
      operatorSync: (workspaceId: string, txHash?: string | null) =>
        post<OperatorState>(`/workspaces/${id(workspaceId)}/wallet/operator/sync`, txHash ? { txHash } : {}),
      /** Org owners only, after a fresh sign-in (`reauth_required` otherwise). */
      operatorAuth: (workspaceId: string, operator: string) =>
        post<OperatorAuthorization>(`/workspaces/${id(workspaceId)}/wallet/operator-auth`, { operator }),
      channels: (workspaceId: string, all = false) => get<Channel[]>(`/workspaces/${id(workspaceId)}/channels`, { all: all ? 1 : undefined }),
      closeChannel: (workspaceId: string, peerId: string) => post<{ ok: true }>(`/workspaces/${id(workspaceId)}/channels/close`, { peerId }),
      rewards: (workspaceId: string) => get<Rewards>(`/workspaces/${id(workspaceId)}/rewards`),
      chain: () => get<ChainInfo>('/chain'),
    },
    network: {
      peers: () => get<Peer[]>('/peers'),
      routePreview: (query: { model: string; workspace?: string; key?: string; member?: string; preset?: string }) => get<RoutePreview>('/route-preview', query),
      gatewayPolicy: () => get<RoutingPolicy>('/routing'),
      buyerLimits: () => get<BuyerLimits>('/routing/buyer-limits'),
      /** The body is the policy itself, so save flags go in the query string. */
      setGatewayPolicy: (policy: RoutingPolicy, options?: SaveOptions) => request<RoutingPolicy>('PUT', '/routing', {
        body: policy, query: { confirmEmpty: options?.confirmEmpty ? 1 : undefined, acceptNarrowed: options?.acceptNarrowed ? 1 : undefined },
      }),
      peerLists: () => get<PeerList[]>('/peer-lists'),
      createPeerList: (input: PeerListInput) => post<PeerList>('/peer-lists', input),
      updatePeerList: (listId: string, input: Partial<PeerListInput>) => patch<PeerList>(`/peer-lists/${id(listId)}`, input),
      removePeerList: (listId: string) => del(`/peer-lists/${id(listId)}`),
    },
    presets: {
      list: (workspace?: string) => get<Preset[]>('/presets', { workspace }),
      create: (input: PresetInput, options?: SaveOptions) => post<Preset>('/presets', withConfirm(input, options)),
      update: (presetId: string, input: Partial<PresetInput>, options?: SaveOptions) => patch<Preset>(`/presets/${id(presetId)}`, withConfirm(input, options)),
      remove: (presetId: string) => del(`/presets/${id(presetId)}`),
    },
    settings: {
      status: () => get<GatewayStatus>('/status'),
      get: () => get<Settings>('/settings'),
      updateBuyer: (input: BuyerSettingsInput) => patch<SettingsResult>('/settings/buyer', input),
      setObservability: (input: ObservabilitySettings) => put<SettingsResult>('/settings/observability', input),
    },
  }
}

export interface UsageFilter {
  workspace?: string
  key?: string
  member?: string
  from?: number
  to?: number
}

export interface RequestQuery extends UsageFilter {
  model?: string
  status?: string
  /** Free-text search over model, key, end user, path and error. */
  q?: string
}

export interface AuditQuery {
  actor?: string
  action?: string
}

/** PATCH /workspaces/:id. `orgRoutingPolicy` and `limits` are set by org admins only. */
export type WorkspacePatch = Partial<WorkspaceInput>

/** Settings writes may report that the buyer needs a restart to pick the change up. */
export type SettingsResult = Settings & { restartRequired?: boolean }

export interface PeerListInput {
  name: string
  description: string | null
  peerIds: string[]
}

export type PresetInput = Pick<Preset, 'slug' | 'name' | 'workspaceId' | 'model' | 'routingPolicy' | 'systemPrompt' | 'params'>

/**
 * A key has two restriction layers: the admin layer (`limits`,
 * `routingPolicy`; workspace admins) and the owner layer (`ownerLimits`,
 * `ownerRoutingPolicy`; the key's owner). Both apply. Gateways without the
 * owner layer omit those fields.
 */
export interface KeyOwnerLayer {
  ownerLimits?: SpendLimits
  ownerRoutingPolicy?: RoutingPolicy | null
}
export type KeyWithLayers = ApiKey & KeyOwnerLayer
export type ApiKeyCreate = ApiKeyInput & KeyOwnerLayer
export type ApiKeyPatch = Partial<ApiKeyInput> & KeyOwnerLayer

export function hasOwnerLayer(key: ApiKey | null | undefined): key is KeyWithLayers {
  return !!key && 'ownerRoutingPolicy' in key
}

export type ApiClient = ReturnType<typeof createApiClient>
