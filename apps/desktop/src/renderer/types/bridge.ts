import type { FreeTierStakeView } from '@antseed/node/free-tier-program';
export type RuntimeMode = 'gateway';

export type RuntimeProcessState = {
  mode: RuntimeMode;
  running: boolean;
  pid?: number | null;
  startedAt?: number | null;
  lastExitCode?: number | null;
  lastError?: string | null;
  [key: string]: unknown;
};

/** One installed application ("Open with" picker): display name plus the
    launchable path (.app bundle on macOS, Start Menu .lnk on Windows) and
    the OS-provided icon when one could be extracted. */
export type InstalledAppEntry = { name: string; path: string; iconDataUri?: string };

/** An app the desktop can connect to the gateway (its config file is pointed at it). */
export type ConnectedAppProfile = {
  name: string;
  displayName: string;
  appAction?: 'none' | 'open-url' | 'open-tool' | 'restart-app';
  openUrl?: string;
  toolName?: string;
  connected: boolean;
  /** Last connect error for this app, if its (re)connect failed. */
  error: string | null;
  /** Found on this machine (config, install location, binary on PATH, or a picked "Open with" app). */
  installed?: boolean;
  /** Where to get the app when it is not installed. */
  downloadUrl?: string;
  canRestart?: boolean;
  /** Connected, but the running app started before the connection changed. */
  needsRestart?: boolean;
  iconDataUri?: string;
  /** Installed application the user picked as this profile's "Open with"
      target — wins over the packaged open action when launching. */
  launchAppName?: string;
  /** Client names identifying this app's requests on the wire (User-Agent
      product / session-header slugs) — used to attribute conversations to
      the app. User-editable per app. */
  toolSlugs?: string[];
};

export type ConnectedAppsState = {
  connected: string[];
  errors: Record<string, string>;
  connectedAt: number | null;
};

export type GatewayMode = 'local' | 'remote';
export type GatewayKeyMode = 'shared' | 'per-app';

export type GatewayStatus = {
  mode: GatewayMode;
  origin: string | null;
  keyMode: GatewayKeyMode;
  running: boolean;
  reachable: boolean;
  hasKey: boolean;
  lastError: string | null;
};

export type GatewaySettings = {
  mode: GatewayMode;
  remoteUrl: string | null;
  keyMode: GatewayKeyMode;
  hasRemoteKey: boolean;
};

export type GatewayPrivacyMode = 'anonymous' | 'private';

export type GatewayPrivacy = {
  mode: GatewayPrivacyMode;
  editable: boolean;
  requiredAbove: boolean;
};

export type GatewayRewardsSummary = {
  available: boolean;
  address: string;
  pendingAnts: string;
  currentEpoch: number | null;
  transfersEnabled: boolean;
};

export type AgentSkillTarget = {
  id: string;
  label: string;
  detected: boolean;
  installed: boolean;
  skillsDir: string;
};

export type GatewayKeyInfo = {
  label: string | null;
  buyerAddress: string | null;
  requests: number;
  spentUsd: string | null;
  limits: Record<string, { limitUsd: string | null; spentUsd: string | null }>;
};

export type GatewayEndpointInfo = {
  ok: boolean;
  baseUrl?: string;
  origin?: string;
  apiKey?: string;
  mode?: GatewayMode;
  error?: string;
};

export type RuntimeControlResult = {
  ok: boolean;
  error?: string;
  processes: RuntimeProcessState[];
  daemonState: { exists: boolean; state: Record<string, unknown> | null };
};
export type DepositWatchStatus = {
  phase: 'deferred' | 'received' | 'sweeping' | 'credited' | 'error';
  /** USDC base units (6 decimals), bigint string. */
  amountBaseUnits?: string;
  txHash?: string;
  error?: string;
  /** Why a 'deferred' sweep is waiting (absent from older daemons). */
  reason?: 'below-minimum' | 'credit-limit';
  /** below-minimum: the wallet balance a sweep needs, relay fee included. */
  minRequiredBaseUnits?: string;
};

export type LogEvent = {
  mode: RuntimeMode | string;
  stream: 'stdout' | 'stderr' | 'system' | string;
  line: string;
  timestamp: number;
};

export type DaemonStateSnapshot = {
  exists: boolean;
  state: Record<string, unknown> | null;
};

export type RuntimeSnapshot = {
  processes: RuntimeProcessState[];
  daemonState: DaemonStateSnapshot;
  logs: LogEvent[];
};

export type DataEndpoint =
  | 'status'
  | 'network'
  | 'peers'
  | 'config'
  | 'data-sources';

export type DataResult<T = unknown> = {
  ok: boolean;
  data: T | null;
  error: string | null;
  status: number | null;
};

export type UpdateStatus =
  | { status: 'available'; version: string }
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'ready'; version: string }
  | { status: 'installing'; version: string | null }
  | { status: 'error'; version: string | null; message: string; details: string; hint?: string };

export type InstallUpdateResult =
  | { ok: true }
  | { ok: false; error: string; details: string; hint?: string };

// NOTE: Source of truth lives in apps/desktop/src/main/chat/stream-stop.ts
// (`ChatStreamStopReason`). The renderer cannot import from main, so the
// shape is mirrored here for IPC. Keep in sync with that file and with
// apps/desktop/src/main/preload.cts when fields change.
export type ChatAiStreamStopReason = {
  kind: 'payment_required' | 'aborted' | 'timeout' | 'http_error' | 'network_error' | 'stream_error' | 'unknown';
  source: 'billing' | 'user' | 'transport' | 'upstream' | 'unknown';
  retryable: boolean;
  message: string;
  statusCode?: number;
  errorCode?: string;
  /** Set when a seller's free tier ran out: its limit and staked tiers (only stake in that seller's pool counts). */
  freeTier?: {
    peerId: string | null;
    /** `stake_required`: the model is free on that seller only for its stakers. */
    limitedBy: 'address' | 'ip' | 'stake' | 'stake_required';
    limit: number | null;
    windowMs: number | null;
    retryAfterSeconds: number | null;
    stakeTiers: Array<{ minPower: number; multiplier: number | 'unlimited' }>;
    stakePower: number;
    /** Requests per window the tier multipliers apply to; null from sellers that don't send it. */
    baseLimit: number | null;
    stakersOnly: boolean;
  };
};

export type RawChatAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  base64: string;
};

export type ChatPermissionMode = 'manual' | 'full';

/** One gateway model in the chat picker. Mirrors ChatModel in main/chat/gateway-model.ts. */
export type ChatModel = {
  id: string;
  label: string;
  /** `text`, `image`, `video`, `speech`, … as the gateway reports it. */
  type: string;
  /** Chat protocol for text models; null for models the chat cannot talk to. */
  protocol: 'anthropic-messages' | 'openai-responses' | 'openai-chat-completions' | null;
  supportsImages: boolean;
  contextWindow?: number;
  /** Sellers offering it, as the gateway lists them (before routing policy). */
  sellers: number;
  /** Some seller serves it for $0 to everyone. */
  free: boolean;
  /** Some seller's free tier is for its stakers only. */
  freeForStakers: boolean;
  /** Some seller runs it in a verified TEE. */
  tee: boolean;
  toolUse: boolean;
  reasoning: boolean;
  /** Cheapest advertised prices, USD per million tokens. */
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
};
/** A seller for one model under the key's routing policy, as the gateway's route preview ranks it. */
export type ChatRouteCandidate = {
  peerId: string;
  name: string | null;
  /** Auto-routing order among eligible sellers (1 = first choice); null when ineligible. */
  rank: number | null;
  /** Allowed by the routing policy; an ineligible seller cannot be pinned either. */
  eligible: boolean;
  /** Why it was excluded, or how it scored ("free", "success ~98%", …). */
  reasons: string[];
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  trustScore: number | null;
  successRate: number | null;
  firstTokenMs: number | null;
  tokensPerSecond: number | null;
  failing: boolean;
};
export type ChatRoutePreview = {
  model: string;
  /** The key's policy allows this model at all. */
  modelAllowed: boolean;
  /** How Auto orders eligible sellers (balanced, price, …). */
  sort: string | null;
  candidates: ChatRouteCandidate[];
};
export type ToolApprovalDecision = 'allow_once' | 'always_allow' | 'deny';
export type ToolApprovalRequest = {
  id: string;
  conversationId: string;
  toolCallId: string;
  toolName: string;
  permissionKey: string;
  permissionLabel: string;
  input: Record<string, unknown>;
  workspacePath: string;
  /** Model the approval is scoped to: "always allow" is remembered per model. */
  modelId: string | null;
  modelName: string | null;
  title: string;
  description: string;
  subject: string;
  alwaysAllowLabel: string;
  canAlwaysAllow: boolean;
};

export type PreparedChatAttachment = {
  id: string;
  /** Stable server-generated ID for the on-disk copy; used by the
   *  `antseed-attachment://` preview protocol. */
  attachmentId?: string;
  name: string;
  mimeType: string;
  size: number;
  kind: 'image' | 'video' | 'text' | 'archive' | 'error';
  status: 'ready' | 'error';
  text?: string;
  image?: { type: 'image'; data: string; mimeType: string };
  error?: string;
  truncated?: boolean;
  native?: { provider?: string; payload?: unknown };
};

export type DesktopBridge = {
  /** `process.platform` from the preload (Node side). */
  platform?:
    | 'aix' | 'android' | 'darwin' | 'freebsd' | 'haiku' | 'linux'
    | 'openbsd' | 'sunos' | 'win32' | 'cygwin' | 'netbsd';
  /** Authoritative macOS UI locale (Electron `app.getLocale()`). */
  getSystemLocale?: () => Promise<string>;
  /** Current app version from Electron `app.getVersion()`. */
  getAppVersion?: () => Promise<string>;
  getState?: () => Promise<RuntimeSnapshot>;
  /** Starts the local gateway (no-op for a remote one) and resolves once it serves. */
  start?: () => Promise<RuntimeControlResult>;
  restart?: () => Promise<RuntimeControlResult>;
  clearLogs?: () => Promise<{ ok: true }>;

  getData?: (endpoint: DataEndpoint) => Promise<DataResult>;
  updateConfig?: (
    config: Record<string, unknown>,
  ) => Promise<DataResult>;

  onLog?: (handler: (event: LogEvent) => void) => () => void;
  onState?: (handler: (states: RuntimeProcessState[]) => void) => () => void;
  onPeersChanged?: (handler: () => void) => () => void;

  chatAiListConversations?: () => Promise<{ ok: boolean; data: unknown[] }>;
  chatAiGetConversation?: (id: string) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
  chatAiCreateConversation?: (model: string) => Promise<{ ok: boolean; data?: unknown; error?: string }>;
  /** The gateway's models, one row per model id. `ok: false` carries a readable error (gateway unreachable, 401, not configured). */
  chatListModels?: (options?: { force?: boolean }) => Promise<{ ok: boolean; data: ChatModel[]; error?: string }>;
  chatRoutePreview?: (model: string, options?: { force?: boolean }) => Promise<{ ok: boolean; data?: ChatRoutePreview; error?: string }>;
  /** Remembers the model a conversation uses (null conversation: telemetry only). */
  chatAiSetModel?: (conversationId: string | null, model: string) => Promise<{ ok: boolean; error?: string }>;
  chatAiDeleteConversation?: (id: string) => Promise<{ ok: boolean }>;
  chatAiRenameConversation?: (id: string, title: string) => Promise<{ ok: boolean; error?: string }>;
  chatPrepareAttachments?: (conversationId: string, attachments: RawChatAttachment[]) => Promise<{ ok: boolean; data?: PreparedChatAttachment[]; error?: string }>;
  attachmentDownload?: (conversationId: string, attachmentId: string, suggestedName: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
  chatGenerateImage?: (payload: { conversationId: string; prompt: string; model: string; moderation?: 'auto' | 'low'; sourceImageAttachmentId?: string }) => Promise<{ ok: boolean; user?: { role: string; content: unknown; createdAt?: number }; assistant?: { role: string; content: unknown; createdAt?: number; meta?: Record<string, unknown> }; error?: string }>;
  chatAiSendStream?: (conversationId: string, message: string, model?: string, attachments?: PreparedChatAttachment[], permissionMode?: ChatPermissionMode) => Promise<{ ok: boolean; error?: string; stopReason?: ChatAiStreamStopReason }>;
  chatPermissionModeGet?: (modelId: string) => Promise<{ ok: boolean; mode?: ChatPermissionMode; error?: string }>;
  chatPermissionModeSet?: (modelId: string, mode: ChatPermissionMode) => Promise<{ ok: boolean; mode?: ChatPermissionMode; error?: string }>;
  chatToolApprovalDecision?: (id: string, decision: ToolApprovalDecision) => Promise<{ ok: boolean; error?: string }>;
  chatAiAbort?: (conversationId?: string) => Promise<{ ok: boolean }>;
  chatAiGetWorkspace?: () => Promise<{ ok: boolean; data?: { current: string; default: string }; error?: string }>;
  chatAiSetWorkspace?: (workspacePath: string) => Promise<{ ok: boolean; data?: { current: string; default: string }; error?: string }>;
  pickDirectory?: () => Promise<{ ok: boolean; path: string | null }>;
  openExternalUrl?: (url: string) => Promise<{ ok: boolean; error?: string }>;
  openTool?: (toolName: string) => Promise<{ ok: boolean; error?: string; fallback?: string }>;
  voiceTranscribe?: (audio: ArrayBuffer) => Promise<{ ok: boolean; text?: string; error?: string }>;
  voiceGetStatus?: () => Promise<unknown>;
  voiceSetModel?: (modelId: string) => Promise<unknown>;
  voiceInstallModel?: (modelId: string) => Promise<unknown>;
  onChatAiDone?: (handler: (data: { conversationId: string; message: { role: string; content: unknown; createdAt?: number; meta?: Record<string, unknown> } }) => void) => () => void;
  onChatAiUserPersisted?: (handler: (data: { conversationId: string; message: { role: string; content: unknown; createdAt?: number } }) => void) => () => void;
  onChatConversationTitleUpdated?: (handler: (data: { conversationId: string; title: string }) => void) => () => void;
  onChatAiStreamStart?: (handler: (data: { conversationId: string; turn: number }) => void) => () => void;
  onChatAiStreamDelta?: (handler: (data: { conversationId: string; index: number; blockType: string; text: string }) => void) => () => void;
  onChatAiStreamBlockStart?: (handler: (data: { conversationId: string; index: number; blockType: string; toolId?: string; toolName?: string }) => void) => () => void;
  onChatAiStreamBlockStop?: (handler: (data: { conversationId: string; index: number; blockType: string; toolId?: string; toolName?: string; input?: Record<string, unknown> }) => void) => () => void;
  onChatAiStreamDone?: (handler: (data: { conversationId: string }) => void) => () => void;
  onChatAiStreamError?: (handler: (data: { conversationId: string; error: string; stopReason?: ChatAiStreamStopReason }) => void) => () => void;
  onChatAiToolExecuting?: (handler: (data: { conversationId: string; toolUseId: string; name: string; input: Record<string, unknown> }) => void) => () => void;
  onChatAiToolUpdate?: (handler: (data: { conversationId: string; toolUseId: string; name: string; input: Record<string, unknown>; output: string; details?: Record<string, unknown> }) => void) => () => void;
  onChatAiToolResult?: (handler: (data: { conversationId: string; toolUseId: string; output: string; isError: boolean; details?: Record<string, unknown> }) => void) => () => void;
  onChatToolApprovalRequested?: (handler: (data: ToolApprovalRequest) => void) => () => void;
  onChatToolApprovalCleared?: (handler: (data: { id: string; conversationId: string }) => void) => () => void;
  onBrowserPreviewOpen?: (handler: (data: { url: string }) => void) => () => void;
  sendBrowserPreviewElementSelected?: (data: { selector: string; tagName: string; text: string; attributes: Record<string, string> }) => void;
  onFullscreenChange?: (handler: (isFullscreen: boolean) => void) => () => void;
  onWindowFocusChange?: (handler: (isFocused: boolean) => void) => () => void;
  getAppSetupStatus?: () => Promise<{ needed: boolean; complete: boolean }>;
  getTelemetryStatus?: () => Promise<import('../../shared/telemetry.js').TelemetryStatus>;
  setTelemetryEnabled?: (enabled: boolean) => Promise<import('../../shared/telemetry.js').TelemetryStatusUpdateResult>;
  telemetryRecordUserAction?: (payload: import('../../shared/telemetry.js').UserActionSignal) => Promise<{ ok: boolean }>;
  telemetryRecordFirstModelShown?: (payload: import('../../shared/telemetry.js').FirstModelShownSignal) => Promise<{ ok: boolean }>;
  onAppSetupStep?: (handler: (data: { step: string; label: string }) => void) => () => void;
  onAppSetupComplete?: (handler: () => void) => () => void;
  onUpdateStatus?: (handler: (data: UpdateStatus) => void) => () => void;
  installUpdate?: () => Promise<InstallUpdateResult>;
  downloadUpdate?: () => Promise<InstallUpdateResult>;
  getUpdateStatus?: () => Promise<UpdateStatus | null>;
  setDebugLogs?: (enabled: boolean) => Promise<{ ok: true }>;
  creditsGetInfo?: (opts?: { fresh?: boolean }) => Promise<{ ok: boolean; data: { evmAddress: string | null; operatorAddress: string | null; balanceUsdc: string; reservedUsdc: string; availableUsdc: string; pendingUsdc: string; spendableUsdc: string; walletUsdc: string; totalOwnedUsdc: string; creditLimitUsdc: string; minFirstDepositUsdc?: string; depositFeeUsdc?: string; balanceKnown?: boolean } | null; error: string | null }>;
  /** Prompts a native save dialog and writes the signer private key to the chosen file. */
  identityExportKey?: () => Promise<{ ok: boolean; canceled?: boolean; path?: string; error?: string | null }>;
  /** Replaces the signer private key (the current one is backed up on disk first). */
  identityImportKey?: (privateKeyHex: string) => Promise<{ ok: boolean; address?: string; backupPath?: string | null; error?: string }>;


  freeTierList?: () => Promise<{ ok: boolean; data?: FreeTierSharing; error?: string }>;
  freeTierAdd?: (code: string) => Promise<{ ok: boolean; data?: FreeTierSharing; error?: string }>;
  freeTierRemove?: (staker: string) => Promise<{ ok: boolean; data?: FreeTierSharing; error?: string }>;
  /** This buyer's counted seller-pool stake (its own plus shared), by pool. */
  freeTierStake?: () => Promise<{ ok: boolean; data?: FreeTierStakeView & { buyer: string }; error?: string }>;
  paymentsOpenPayPage?: (opts: { kind?: 'deposit' | 'withdraw' | 'authorize'; amountUsdc?: string }) => Promise<{ ok: boolean; url?: string; error?: string }>;
  paymentsOpenCardProvider?: (opts?: { providerId?: string; amountUsdc?: string }) => Promise<{ ok: boolean; url?: string; error?: string }>;
  /** Fired when a browser pay page reports a completed payment action. */
  onPaymentsCompleted?: (handler: () => void) => () => void;
  depositsWatchStart?: () => Promise<{ ok: boolean; data?: { address: string; walletUsdcBaseUnits: string; usdcAddress: string; chainId: number }; error?: string }>;
  depositsWatchStop?: () => Promise<{ ok: boolean }>;
  onDepositsWatchStatus?: (handler: (data: DepositWatchStatus) => void) => () => void;

  appsListProfiles?: () => Promise<ConnectedAppProfile[]>;
  appsConnect?: (name: string) => Promise<{ ok: boolean; state: ConnectedAppsState; error?: string }>;
  appsDisconnect?: (name: string) => Promise<{ ok: boolean; state: ConnectedAppsState; error?: string }>;
  /** Installed applications for the "Open with" picker (macOS .app bundles,
      Windows Start Menu shortcuts). */
  listInstalledApps?: () => Promise<{ ok: boolean; apps: InstalledAppEntry[]; error?: string }>;
  appsSetAppLaunch?: (opts: { name: string; app: InstalledAppEntry | null }) => Promise<{ ok: boolean; error?: string }>;
  /** Override the client names that attribute requests to an app profile;
      null resets to the profile's defaults. */
  appsSetAppIdentity?: (opts: { name: string; toolSlugs: string[] | null }) => Promise<{ ok: boolean; error?: string }>;
  appsRestartApp?: (app: string) => Promise<{ ok: boolean; error?: string }>;

  gatewayGetStatus?: () => Promise<GatewayStatus>;
  gatewayGetSettings?: () => Promise<GatewaySettings>;
  gatewayUpdateSettings?: (opts: { mode?: GatewayMode; remoteUrl?: string | null; remoteApiKey?: string | null; keyMode?: GatewayKeyMode }) => Promise<{ ok: boolean; settings?: GatewaySettings; error?: string }>;
  gatewayRotateKeys?: () => Promise<{ ok: boolean; error?: string }>;
  /** Base URL (with /v1) + the desktop key, for pasting into any OpenAI- or Anthropic-compatible tool. */
  gatewayGetEndpoint?: () => Promise<GatewayEndpointInfo>;
  gatewayGetKeyInfo?: () => Promise<GatewayKeyInfo | null>;
  /** Opens the gateway console in the browser at `path` (e.g. `/keys`, `/wallet?fund=1`). */
  gatewayOpenConsole?: (path?: string) => Promise<{ ok: boolean; error?: string }>;
  /** Anonymous (any allowed seller) or Private (TEE sellers only), from the desktop key's routing policy. */
  gatewayGetPrivacy?: () => Promise<{ ok: boolean; privacy?: GatewayPrivacy; error?: string }>;
  gatewaySetPrivacy?: (mode: GatewayPrivacyMode) => Promise<{ ok: boolean; privacy?: GatewayPrivacy; error?: string }>;
  /** $ANTS the gateway's wallet earned from usage, read from the chain. */
  gatewayGetRewards?: (opts?: { force?: boolean }) => Promise<{ ok: boolean; data?: GatewayRewardsSummary; error?: string }>;
  /** Agents that can take the Antseed skills, and where they stand. */
  agentSkillsList?: () => Promise<AgentSkillTarget[]>;
  agentSkillsInstall?: (id: string) => Promise<{ ok: boolean; targets?: AgentSkillTarget[]; error?: string }>;
  agentSkillsRemove?: (id: string) => Promise<{ ok: boolean; targets?: AgentSkillTarget[]; error?: string }>;
  /** Copies setup instructions (gateway URL + key) for any other agent to the clipboard. */
  agentSkillsCopyPrompt?: () => Promise<{ ok: boolean; error?: string }>;
  /** The gateway, its key or the key mode changed. */
  onGatewayChanged?: (handler: () => void) => () => void;
};

/** Stakers sharing their seller-pool stake with this buyer (staked free tier). */
export interface FreeTierSharing {
  buyer: string;
  stakers: Array<{ staker: string; expiresAt: number; expired: boolean }>;
}

