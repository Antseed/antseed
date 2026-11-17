import type { FreeTierStakeView } from '@antseed/node/free-tier-program';
import type {
  AgentSkillStatus as AgentSkillTarget,
  AgentSkillsResult,
  OpenAgentResult,
  GatewayEndpointInfo,
  GatewayKeyInfo,
  GatewayKeyMode,
  GatewayMode,
  GatewayPrivacy,
  GatewayPrivacyMode,
  GatewayPrivacyResult,
  GatewayRewardsSummary,
  GatewaySavings,
  GatewaySettingsPatch,
  GatewaySettingsResult,
  GatewaySettingsView as GatewaySettings,
  GatewayStatus,
} from '../../shared/gateway-types.js';
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
  /** App name → when Antseed last changed its config. */
  configChangedAt: Record<string, number>;
};

export type {
  GatewaySettingsPatch,
  GatewayEndpointInfo,
  GatewayKeyInfo,
  GatewayKeyMode,
  GatewayMode,
  GatewayPrivacy,
  GatewayPrivacyMode,
  GatewayRewardsSummary,
  GatewaySavings,
  GatewayStatus,
} from '../../shared/gateway-types.js';
export type { AgentSkillStatus as AgentSkillTarget, AgentSkillsResult, GatewaySettingsView as GatewaySettings } from '../../shared/gateway-types.js';

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

import type { ChatModel, ChatRoutePreview, ConversationFlags, OutgoingPrivacy } from '../../shared/chat-gateway-types.js';
export type { ChatModel, ChatRouteCandidate, ChatRoutePreview, ConversationFlags } from '../../shared/chat-gateway-types.js';

export type ToolApprovalDecision = 'allow_once' | 'always_allow' | 'deny';
// Mirrors TelegramBridgeStatus in apps/desktop/src/main/telegram/bridge.ts
export type TelegramBridgeStatus = {
  configured: boolean;
  running: boolean;
  botUsername: string | null;
  paired: boolean;
  ownerName: string | null;
  pairingLink: string | null;
  lastError: string | null;
};

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
  /** Pin or archive a chat (pinning unarchives it, archiving unpins it). */
  chatAiSetConversationFlags?: (
    id: string,
    flags: ConversationFlags,
  ) => Promise<{ ok: boolean; data?: { pinnedAt?: number; archivedAt?: number }; error?: string }>;
  chatPrepareAttachments?: (conversationId: string, attachments: RawChatAttachment[]) => Promise<{ ok: boolean; data?: PreparedChatAttachment[]; error?: string }>;
  attachmentDownload?: (conversationId: string, attachmentId: string, suggestedName: string) => Promise<{ ok: boolean; path?: string; error?: string }>;
  chatGenerateImage?: (payload: { conversationId: string; prompt: string; model: string; moderation?: 'auto' | 'low'; sourceImageAttachmentId?: string } & OutgoingPrivacy) => Promise<{ ok: boolean; user?: { role: string; content: unknown; createdAt?: number }; assistant?: { role: string; content: unknown; createdAt?: number; meta?: Record<string, unknown> }; error?: string; stopReason?: { kind: string; message: string; errorCode?: string } }>;
  chatAiSendStream?: (conversationId: string, message: string, model?: string, attachments?: PreparedChatAttachment[], permissionMode?: ChatPermissionMode, options?: OutgoingPrivacy) => Promise<{ ok: boolean; error?: string; stopReason?: ChatAiStreamStopReason }>;
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
  onChatAiDone?: (handler: (data: { conversationId: string; message: { role: string; content: unknown; createdAt?: number; meta?: Record<string, unknown> }; sendId?: number }) => void) => () => void;
  onChatAiUserPersisted?: (handler: (data: { conversationId: string; message: { role: string; content: unknown; createdAt?: number }; sendId?: number }) => void) => () => void;
  onChatConversationTitleUpdated?: (handler: (data: { conversationId: string; title: string; sendId?: number }) => void) => () => void;
  onChatAiReplyMeta?: (handler: (data: { conversationId: string; sendId?: number; meta: Record<string, unknown> }) => void) => () => void;
  onChatAiStreamStart?: (handler: (data: { conversationId: string; sendId?: number; turn: number }) => void) => () => void;
  onChatAiStreamDelta?: (handler: (data: { conversationId: string; sendId?: number; index: number; blockType: string; text: string }) => void) => () => void;
  onChatAiStreamBlockStart?: (handler: (data: { conversationId: string; sendId?: number; index: number; blockType: string; toolId?: string; toolName?: string }) => void) => () => void;
  onChatAiStreamBlockStop?: (handler: (data: { conversationId: string; sendId?: number; index: number; blockType: string; toolId?: string; toolName?: string; input?: Record<string, unknown> }) => void) => () => void;
  onChatAiStreamDone?: (handler: (data: { conversationId: string; sendId?: number }) => void) => () => void;
  onChatAiStreamError?: (handler: (data: { conversationId: string; error: string; stopReason?: ChatAiStreamStopReason; sendId?: number }) => void) => () => void;
  onChatAiToolExecuting?: (handler: (data: { conversationId: string; sendId?: number; toolUseId: string; name: string; input: Record<string, unknown> }) => void) => () => void;
  onChatAiToolUpdate?: (handler: (data: { conversationId: string; sendId?: number; toolUseId: string; name: string; input: Record<string, unknown>; output: string; details?: Record<string, unknown> }) => void) => () => void;
  onChatAiToolResult?: (handler: (data: { conversationId: string; sendId?: number; toolUseId: string; output: string; isError: boolean; details?: Record<string, unknown> }) => void) => () => void;
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
  telemetryRecordDepositStep?: (payload: import('../../shared/telemetry.js').DepositStepSignal) => Promise<{ ok: boolean }>;
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
  paymentsOpenGoodDollar?: () => Promise<{ ok: boolean; url?: string; error?: string }>;
  /** Fired when a browser pay page reports a completed payment action. */
  onPaymentsCompleted?: (handler: () => void) => () => void;
  depositsWatchStart?: () => Promise<{ ok: boolean; data?: { address: string; walletUsdcBaseUnits: string; usdcAddress: string; chainId: number }; error?: string }>;
  depositsWatchStop?: () => Promise<{ ok: boolean }>;
  onDepositsWatchStatus?: (handler: (data: DepositWatchStatus) => void) => () => void;

  appsListProfiles?: () => Promise<ConnectedAppProfile[]>;
  telegramGetStatus?: () => Promise<{ ok: boolean; data?: TelegramBridgeStatus; error?: string }>;
  telegramConnect?: (botToken: string) => Promise<{ ok: boolean; data?: TelegramBridgeStatus; error?: string }>;
  telegramDisconnect?: () => Promise<{ ok: boolean; data?: TelegramBridgeStatus; error?: string }>;
  onTelegramStatusChanged?: (handler: (data: TelegramBridgeStatus) => void) => () => void;
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
  gatewayUpdateSettings?: (opts: GatewaySettingsPatch) => Promise<GatewaySettingsResult>;
  gatewayRotateKeys?: () => Promise<{ ok: boolean; error?: string }>;
  /** Base URL (with /v1) + the desktop key, for pasting into any OpenAI- or Anthropic-compatible tool. */
  gatewayGetEndpoint?: (opts?: { app?: string }) => Promise<GatewayEndpointInfo>;
  gatewayGetKeyInfo?: () => Promise<GatewayKeyInfo | null>;
  /** Opens the gateway console in the browser at `path` (e.g. `/keys`, `/wallet?fund=1`). */
  gatewayOpenConsole?: (path?: string) => Promise<{ ok: boolean; error?: string }>;
  /** Anonymous (any allowed seller) or Private (TEE sellers only), from the desktop key's routing policy. */
  gatewayGetPrivacy?: () => Promise<GatewayPrivacyResult>;
  gatewaySetPrivacy?: (mode: GatewayPrivacyMode) => Promise<GatewayPrivacyResult>;
  /** $ANTS the gateway's wallet earned from usage, read from the chain. */
  gatewayGetRewards?: () => Promise<{ ok: boolean; data?: GatewayRewardsSummary; error?: string }>;
  /** Retail vs paid on this app's buyer; null with no retail baseline, no matched usage, or a remote gateway. */
  gatewayGetSavings?: () => Promise<GatewaySavings | null>;
  /** Agents that can take the Antseed skills, and where they stand. */
  agentSkillsList?: () => Promise<AgentSkillTarget[]>;
  agentSkillsInstall?: (id: string) => Promise<AgentSkillsResult>;
  agentSkillsRemove?: (id: string) => Promise<AgentSkillsResult>;
  /** Copies setup instructions (gateway URL + key) for any other agent to the clipboard. */
  agentSkillsCopyPrompt?: () => Promise<{ ok: boolean; error?: string }>;
  /** Opens the agent: its desktop app if it has one, else a terminal running its CLI. */
  agentSkillsOpen?: (id: string) => Promise<OpenAgentResult>;
  /** The gateway, its key or the key mode changed. */
  onGatewayChanged?: (handler: () => void) => () => void;
};

/** Stakers sharing their seller-pool stake with this buyer (staked free tier). */
export interface FreeTierSharing {
  buyer: string;
  stakers: Array<{ staker: string; expiresAt: number; expired: boolean }>;
}

