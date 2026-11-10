import type * as GatewayTypes from '../shared/gateway-types.js';
import { contextBridge, ipcRenderer } from 'electron';
import type { RuntimeMode, RuntimeProcessState } from './runtime/process-manager.js';
import type { ConnectedAppsState } from './connected-apps/patching/connection.js';
import type { TelegramBridgeStatus } from './telegram/bridge.js';
import type { ChatModel, ChatRoutePreview } from '../shared/chat-gateway-types.js';
import type {
  DepositStepSignal,
  FirstModelShownSignal,
  TelemetryStatus,
  TelemetryStatusUpdateResult,
  UserActionSignal,
} from '../shared/telemetry.js';

type LogEvent = {
  mode: RuntimeMode;
  stream: 'stdout' | 'stderr' | 'system';
  line: string;
  timestamp: number;
};

type RuntimeSnapshot = {
  processes: RuntimeProcessState[];
  daemonState: { exists: boolean; state: Record<string, unknown> | null };
  logs: LogEvent[];
};

type RuntimeControlResult = {
  ok: boolean;
  error?: string;
  processes: RuntimeProcessState[];
  daemonState: { exists: boolean; state: Record<string, unknown> | null };
};

type DataEndpoint = 'status' | 'network' | 'peers' | 'config' | 'data-sources';

type DataResult = {
  ok: boolean;
  data: unknown | null;
  error: string | null;
  status: number | null;
};

type RawChatAttachment = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  base64: string;
};

type PreparedChatAttachment = {
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

type UpdateStatus =
  | { status: 'available'; version: string }
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'ready'; version: string }
  | { status: 'installing'; version: string | null }
  | { status: 'error'; version: string | null; message: string; details: string; hint?: string };

type InstallUpdateResult =
  | { ok: true }
  | { ok: false; error: string; details: string; hint?: string };

type ChatPermissionMode = 'manual' | 'full';
type ToolApprovalDecision = 'allow_once' | 'always_allow' | 'deny';
type ToolApprovalRequest = {
  id: string;
  conversationId: string;
  toolCallId: string;
  toolName: string;
  permissionKey: string;
  permissionLabel: string;
  input: Record<string, unknown>;
  workspacePath: string;
  modelId: string | null;
  modelName: string | null;
  title: string;
  description: string;
  subject: string;
  alwaysAllowLabel: string;
  canAlwaysAllow: boolean;
};

// NOTE: Source of truth lives in apps/desktop/src/main/chat/stream-stop.ts
// (`ChatStreamStopReason`). This preload runs in a sandboxed context and
// cannot import from main, so the shape is mirrored here for IPC. Keep the
// `kind`, `source`, and field set in sync with the source-of-truth type —
// and with the renderer copy in apps/desktop/src/renderer/types/bridge.ts.
// Mirrors ChatModel in apps/desktop/src/main/chat/gateway-model.ts.
type ChatAiStreamStopReason = {
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

const api = {
  // Synchronous platform info from the Node side of the preload. Renderer
  // code can use this without a round-trip to the main process — useful for
  // the title bar which needs to apply macOS padding before first paint.
  platform: process.platform as NodeJS.Platform,

  // Authoritative macOS UI language as seen by Electron. Use this (not
  // `navigator.language`) to decide whether to swap the title-bar padding
  // for RTL traffic-light placement.
  getSystemLocale(): Promise<string> {
    return ipcRenderer.invoke('app:get-system-locale') as Promise<string>;
  },
  getAppVersion(): Promise<string> {
    return ipcRenderer.invoke('app:get-version') as Promise<string>;
  },
  getState(): Promise<RuntimeSnapshot> {
    return ipcRenderer.invoke('runtime:get-state') as Promise<RuntimeSnapshot>;
  },
  /** Starts the local gateway (no-op for a remote one) and resolves once it serves. */
  start(): Promise<RuntimeControlResult> {
    return ipcRenderer.invoke('runtime:start') as Promise<RuntimeControlResult>;
  },
  restart(): Promise<RuntimeControlResult> {
    return ipcRenderer.invoke('runtime:restart') as Promise<RuntimeControlResult>;
  },
  clearLogs(): Promise<{ ok: true }> {
    return ipcRenderer.invoke('runtime:clear-logs') as Promise<{ ok: true }>;
  },
  getData(endpoint: DataEndpoint): Promise<DataResult> {
    return ipcRenderer.invoke('runtime:get-data', endpoint) as Promise<DataResult>;
  },
  updateConfig(
    config: Record<string, unknown>,
  ): Promise<DataResult> {
    return ipcRenderer.invoke('runtime:update-config', config) as Promise<DataResult>;
  },
  onLog(handler: (event: LogEvent) => void): () => void {
    const listener = (_: unknown, event: LogEvent) => handler(event);
    ipcRenderer.on('runtime:log', listener);
    return () => ipcRenderer.off('runtime:log', listener);
  },
  onPeersChanged(handler: () => void): () => void {
    const listener = () => handler();
    ipcRenderer.on('peers:changed', listener);
    return () => ipcRenderer.off('peers:changed', listener);
  },
  onState(handler: (states: RuntimeProcessState[]) => void): () => void {
    const listener = (_: unknown, states: RuntimeProcessState[]) => handler(states);
    ipcRenderer.on('runtime:state', listener);
    return () => ipcRenderer.off('runtime:state', listener);
  },

  // AI Chat API
  chatAiListConversations(): Promise<{ ok: boolean; data: unknown[] }> {
    return ipcRenderer.invoke('chat:ai-list-conversations');
  },
  chatAiGetConversation(id: string): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    return ipcRenderer.invoke('chat:ai-get-conversation', id);
  },
  chatAiCreateConversation(model: string): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    return ipcRenderer.invoke('chat:ai-create-conversation', model);
  },
  chatListModels(options?: { force?: boolean }): Promise<{ ok: boolean; data: ChatModel[]; error?: string }> {
    return ipcRenderer.invoke('chat:list-models', options ?? {});
  },
  chatRoutePreview(model: string, options?: { force?: boolean }): Promise<{ ok: boolean; data?: ChatRoutePreview; error?: string }> {
    return ipcRenderer.invoke('chat:route-preview', { model, force: options?.force === true });
  },
  chatAiSetModel(conversationId: string | null, model: string): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke('chat:ai-set-model', conversationId, model);
  },
  chatAiDeleteConversation(id: string): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('chat:ai-delete-conversation', id);
  },
  chatAiRenameConversation(id: string, title: string): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke('chat:ai-rename-conversation', id, title);
  },
  chatAiSetConversationFlags(
    id: string,
    flags: { pinned?: boolean; archived?: boolean },
  ): Promise<{ ok: boolean; data?: { pinnedAt?: number; archivedAt?: number }; error?: string }> {
    return ipcRenderer.invoke('chat:ai-set-conversation-flags', id, flags);
  },
  chatPrepareAttachments(conversationId: string, attachments: RawChatAttachment[]): Promise<{ ok: boolean; data?: PreparedChatAttachment[]; error?: string }> {
    return ipcRenderer.invoke('chat:prepare-attachments', conversationId, attachments);
  },
  attachmentDownload(conversationId: string, attachmentId: string, suggestedName: string): Promise<{ ok: boolean; path?: string; error?: string }> {
    return ipcRenderer.invoke('attachment:download', conversationId, attachmentId, suggestedName);
  },
  chatGenerateImage(payload: { conversationId: string; prompt: string; model: string; moderation?: 'auto' | 'low'; sourceImageAttachmentId?: string }): Promise<{ ok: boolean; user?: unknown; assistant?: unknown; error?: string; stopReason?: { kind: string; message: string; errorCode?: string } }> {
    return ipcRenderer.invoke('chat:generate-image', payload);
  },
  chatAiSendStream(conversationId: string, message: string, model?: string, attachments?: PreparedChatAttachment[], permissionMode?: ChatPermissionMode): Promise<{ ok: boolean; error?: string; stopReason?: ChatAiStreamStopReason }> {
    return ipcRenderer.invoke('chat:ai-send-stream', conversationId, message, model, attachments, permissionMode);
  },
  chatPermissionModeGet(modelId: string): Promise<{ ok: boolean; mode?: ChatPermissionMode; error?: string }> {
    return ipcRenderer.invoke('chat:permission-mode-get', modelId);
  },
  chatPermissionModeSet(modelId: string, mode: ChatPermissionMode): Promise<{ ok: boolean; mode?: ChatPermissionMode; error?: string }> {
    return ipcRenderer.invoke('chat:permission-mode-set', { modelId, mode });
  },
  chatToolApprovalDecision(id: string, decision: ToolApprovalDecision): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke('chat:tool-approval-decision', { id, decision });
  },
  chatAiAbort(conversationId?: string): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('chat:ai-abort', conversationId);
  },
  chatAiGetWorkspace(): Promise<{ ok: boolean; data?: { current: string; default: string }; error?: string }> {
    return ipcRenderer.invoke('chat:ai-get-workspace');
  },
  chatAiSetWorkspace(workspacePath: string): Promise<{ ok: boolean; data?: { current: string; default: string }; error?: string }> {
    return ipcRenderer.invoke('chat:ai-set-workspace', workspacePath);
  },
  pickDirectory(): Promise<{ ok: boolean; path: string | null }> {
    return ipcRenderer.invoke('desktop:pick-directory');
  },
  openExternalUrl(url: string): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke('desktop:open-external-url', url) as Promise<{ ok: boolean; error?: string }>;
  },
  openTool(toolName: string): Promise<{ ok: boolean; error?: string; fallback?: string }> {
    return ipcRenderer.invoke('desktop:open-tool', toolName) as Promise<{ ok: boolean; error?: string; fallback?: string }>;
  },
  listInstalledApps(): Promise<{ ok: boolean; apps: Array<{ name: string; path: string; iconDataUri?: string }>; error?: string }> {
    return ipcRenderer.invoke('desktop:list-installed-apps') as Promise<{ ok: boolean; apps: Array<{ name: string; path: string; iconDataUri?: string }>; error?: string }>;
  },
  appsSetAppLaunch(opts: { name: string; app: { name: string; path: string } | null }): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke('apps:set-app-launch', opts) as Promise<{ ok: boolean; error?: string }>;
  },
  voiceTranscribe(audio: ArrayBuffer): Promise<{ ok: boolean; text?: string; error?: string }> {
    return ipcRenderer.invoke('voice:transcribe', audio) as Promise<{ ok: boolean; text?: string; error?: string }>;
  },
  voiceGetStatus(): Promise<unknown> {
    return ipcRenderer.invoke('voice:get-status') as Promise<unknown>;
  },
  voiceSetModel(modelId: string): Promise<unknown> {
    return ipcRenderer.invoke('voice:set-model', modelId) as Promise<unknown>;
  },
  voiceInstallModel(modelId: string): Promise<unknown> {
    return ipcRenderer.invoke('voice:install-model', modelId) as Promise<unknown>;
  },
  onChatAiDone(handler: (data: { conversationId: string; message: { role: string; content: unknown; createdAt?: number; meta?: Record<string, unknown> } }) => void): () => void {
    const listener = (_: unknown, data: { conversationId: string; message: { role: string; content: unknown; createdAt?: number; meta?: Record<string, unknown> } }) => handler(data);
    ipcRenderer.on('chat:ai-done', listener);
    return () => ipcRenderer.off('chat:ai-done', listener);
  },
  onChatAiUserPersisted(handler: (data: { conversationId: string; message: { role: string; content: unknown; createdAt?: number } }) => void): () => void {
    const listener = (_: unknown, data: { conversationId: string; message: { role: string; content: unknown; createdAt?: number } }) => handler(data);
    ipcRenderer.on('chat:ai-user-persisted', listener);
    return () => ipcRenderer.off('chat:ai-user-persisted', listener);
  },
  onChatConversationTitleUpdated(handler: (data: { conversationId: string; title: string }) => void): () => void {
    const listener = (_: unknown, data: { conversationId: string; title: string }) => handler(data);
    ipcRenderer.on('chat:conversation-title-updated', listener);
    return () => ipcRenderer.off('chat:conversation-title-updated', listener);
  },
  // Streaming events
  onChatAiReplyMeta(handler: (data: { conversationId: string; meta: Record<string, unknown> }) => void): () => void {
    const listener = (_: unknown, data: { conversationId: string; meta: Record<string, unknown> }) => handler(data);
    ipcRenderer.on('chat:ai-reply-meta', listener);
    return () => ipcRenderer.off('chat:ai-reply-meta', listener);
  },
  onChatAiStreamStart(handler: (data: { conversationId: string; turn: number }) => void): () => void {
    const listener = (_: unknown, data: { conversationId: string; turn: number }) => handler(data);
    ipcRenderer.on('chat:ai-stream-start', listener);
    return () => ipcRenderer.off('chat:ai-stream-start', listener);
  },
  onChatAiStreamDelta(handler: (data: { conversationId: string; index: number; blockType: string; text: string }) => void): () => void {
    const listener = (_: unknown, data: { conversationId: string; index: number; blockType: string; text: string }) => handler(data);
    ipcRenderer.on('chat:ai-stream-delta', listener);
    return () => ipcRenderer.off('chat:ai-stream-delta', listener);
  },
  onChatAiStreamBlockStart(handler: (data: { conversationId: string; index: number; blockType: string; toolId?: string; toolName?: string }) => void): () => void {
    const listener = (_: unknown, data: { conversationId: string; index: number; blockType: string; toolId?: string; toolName?: string }) => handler(data);
    ipcRenderer.on('chat:ai-stream-block-start', listener);
    return () => ipcRenderer.off('chat:ai-stream-block-start', listener);
  },
  onChatAiStreamBlockStop(handler: (data: { conversationId: string; index: number; blockType: string; toolId?: string; toolName?: string; input?: Record<string, unknown> }) => void): () => void {
    const listener = (_: unknown, data: { conversationId: string; index: number; blockType: string; toolId?: string; toolName?: string; input?: Record<string, unknown> }) => handler(data);
    ipcRenderer.on('chat:ai-stream-block-stop', listener);
    return () => ipcRenderer.off('chat:ai-stream-block-stop', listener);
  },
  onChatAiStreamDone(handler: (data: { conversationId: string }) => void): () => void {
    const listener = (_: unknown, data: { conversationId: string }) => handler(data);
    ipcRenderer.on('chat:ai-stream-done', listener);
    return () => ipcRenderer.off('chat:ai-stream-done', listener);
  },
  onChatAiStreamError(handler: (data: { conversationId: string; error: string; stopReason?: ChatAiStreamStopReason }) => void): () => void {
    const listener = (_: unknown, data: { conversationId: string; error: string; stopReason?: ChatAiStreamStopReason }) => handler(data);
    ipcRenderer.on('chat:ai-stream-error', listener);
    return () => ipcRenderer.off('chat:ai-stream-error', listener);
  },
  onChatAiToolExecuting(handler: (data: { conversationId: string; toolUseId: string; name: string; input: Record<string, unknown> }) => void): () => void {
    const listener = (_: unknown, data: { conversationId: string; toolUseId: string; name: string; input: Record<string, unknown> }) => handler(data);
    ipcRenderer.on('chat:ai-tool-executing', listener);
    return () => ipcRenderer.off('chat:ai-tool-executing', listener);
  },
  onChatAiToolUpdate(handler: (data: { conversationId: string; toolUseId: string; name: string; input: Record<string, unknown>; output: string; details?: Record<string, unknown> }) => void): () => void {
    const listener = (_: unknown, data: { conversationId: string; toolUseId: string; name: string; input: Record<string, unknown>; output: string; details?: Record<string, unknown> }) => handler(data);
    ipcRenderer.on('chat:ai-tool-update', listener);
    return () => ipcRenderer.off('chat:ai-tool-update', listener);
  },
  onChatAiToolResult(handler: (data: { conversationId: string; toolUseId: string; output: string; isError: boolean; details?: Record<string, unknown> }) => void): () => void {
    const listener = (_: unknown, data: { conversationId: string; toolUseId: string; output: string; isError: boolean; details?: Record<string, unknown> }) => handler(data);
    ipcRenderer.on('chat:ai-tool-result', listener);
    return () => ipcRenderer.off('chat:ai-tool-result', listener);
  },
  onChatToolApprovalRequested(handler: (data: ToolApprovalRequest) => void): () => void {
    const listener = (_: unknown, data: ToolApprovalRequest) => handler(data);
    ipcRenderer.on('chat:tool-approval-requested', listener);
    return () => ipcRenderer.off('chat:tool-approval-requested', listener);
  },
  onChatToolApprovalCleared(handler: (data: { id: string; conversationId: string }) => void): () => void {
    const listener = (_: unknown, data: { id: string; conversationId: string }) => handler(data);
    ipcRenderer.on('chat:tool-approval-cleared', listener);
    return () => ipcRenderer.off('chat:tool-approval-cleared', listener);
  },
  onBrowserPreviewOpen(handler: (data: { url: string }) => void): () => void {
    const listener = (_: unknown, data: { url: string }) => handler(data);
    ipcRenderer.on('browser-preview:open', listener);
    return () => ipcRenderer.off('browser-preview:open', listener);
  },
  sendBrowserPreviewElementSelected(data: { selector: string; tagName: string; text: string; attributes: Record<string, string> }): void {
    ipcRenderer.send('browser-preview:element-selected', data);
  },
  onFullscreenChange(handler: (isFullscreen: boolean) => void): () => void {
    const listener = (_: unknown, isFullscreen: boolean) => handler(isFullscreen);
    ipcRenderer.on('fullscreen-change', listener);
    return () => ipcRenderer.off('fullscreen-change', listener);
  },
  onWindowFocusChange(handler: (isFocused: boolean) => void): () => void {
    const listener = (_: unknown, isFocused: boolean) => handler(isFocused);
    ipcRenderer.on('window-focus-change', listener);
    return () => ipcRenderer.off('window-focus-change', listener);
  },
  getAppSetupStatus(): Promise<{ needed: boolean; complete: boolean }> {
    return ipcRenderer.invoke('app:get-setup-status') as Promise<{ needed: boolean; complete: boolean }>;
  },
  getTelemetryStatus(): Promise<TelemetryStatus> {
    return ipcRenderer.invoke('telemetry:get-status') as Promise<TelemetryStatus>;
  },
  setTelemetryEnabled(enabled: boolean): Promise<TelemetryStatusUpdateResult> {
    return ipcRenderer.invoke('telemetry:set-enabled', enabled) as Promise<TelemetryStatusUpdateResult>;
  },
  telemetryRecordUserAction(payload: UserActionSignal): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('telemetry:record-user-action', payload) as Promise<{ ok: boolean }>;
  },
  telemetryRecordFirstModelShown(payload: FirstModelShownSignal): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('telemetry:first-model-shown', payload) as Promise<{ ok: boolean }>;
  },
  telemetryRecordDepositStep(payload: DepositStepSignal): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('telemetry:deposit-step', payload) as Promise<{ ok: boolean }>;
  },
  onAppSetupStep(handler: (data: { step: string; label: string }) => void): () => void {
    const listener = (_: unknown, data: { step: string; label: string }) => handler(data);
    ipcRenderer.on('app:setup-step', listener);
    return () => ipcRenderer.off('app:setup-step', listener);
  },
  onAppSetupComplete(handler: () => void): () => void {
    const listener = () => handler();
    ipcRenderer.on('app:setup-complete', listener);
    return () => ipcRenderer.off('app:setup-complete', listener);
  },

  // Auto-update
  onUpdateStatus(handler: (data: UpdateStatus) => void): () => void {
    const listener = (_: unknown, data: UpdateStatus) => handler(data);
    ipcRenderer.on('app:update-status', listener);
    return () => ipcRenderer.off('app:update-status', listener);
  },
  installUpdate(): Promise<InstallUpdateResult> {
    return ipcRenderer.invoke('app:install-update') as Promise<InstallUpdateResult>;
  },
  downloadUpdate(): Promise<InstallUpdateResult> {
    return ipcRenderer.invoke('app:download-update') as Promise<InstallUpdateResult>;
  },
  getUpdateStatus(): Promise<UpdateStatus | null> {
    return ipcRenderer.invoke('app:get-update-status') as Promise<UpdateStatus | null>;
  },
  setDebugLogs(enabled: boolean): Promise<{ ok: true }> {
    return ipcRenderer.invoke('desktop:set-debug-logs', enabled) as Promise<{ ok: true }>;
  },
  creditsGetInfo(opts?: { fresh?: boolean }) {
    return ipcRenderer.invoke('credits:get-info', opts);
  },
  identityExportKey: () => ipcRenderer.invoke('identity:export-key'),
  identityImportKey: (privateKeyHex: string) => ipcRenderer.invoke('identity:import-key', privateKeyHex),
  freeTierList: () => ipcRenderer.invoke('freeTier:list'),
  freeTierAdd: (code: string) => ipcRenderer.invoke('freeTier:add', code),
  freeTierRemove: (staker: string) => ipcRenderer.invoke('freeTier:remove', staker),
  freeTierStake: () => ipcRenderer.invoke('freeTier:stake'),
  paymentsOpenPayPage: (opts: { kind?: string; amountUsdc?: string }) => ipcRenderer.invoke('payments:open-pay-page', opts),
  paymentsOpenCardProvider: (opts?: { providerId?: string; amountUsdc?: string }) => ipcRenderer.invoke('payments:open-card-provider', opts),
  onPaymentsCompleted(handler: () => void): () => void {
    const listener = () => handler();
    ipcRenderer.on('payments:completed', listener);
    return () => ipcRenderer.off('payments:completed', listener);
  },
  depositsWatchStart: () => ipcRenderer.invoke('deposits:watch-start'),
  depositsWatchStop: () => ipcRenderer.invoke('deposits:watch-stop'),
  onDepositsWatchStatus(handler: (data: unknown) => void): () => void {
    const listener = (_: unknown, data: unknown) => handler(data);
    ipcRenderer.on('deposits:watch-status', listener);
    return () => ipcRenderer.off('deposits:watch-status', listener);
  },
  appsListProfiles(): Promise<unknown[]> {
    return ipcRenderer.invoke('apps:list-profiles') as Promise<unknown[]>;
  },
  telegramGetStatus(): Promise<{ ok: boolean; data?: TelegramBridgeStatus; error?: string }> {
    return ipcRenderer.invoke('telegram:get-status');
  },
  telegramConnect(botToken: string): Promise<{ ok: boolean; data?: TelegramBridgeStatus; error?: string }> {
    return ipcRenderer.invoke('telegram:connect', botToken);
  },
  telegramDisconnect(): Promise<{ ok: boolean; data?: TelegramBridgeStatus; error?: string }> {
    return ipcRenderer.invoke('telegram:disconnect');
  },
  onTelegramStatusChanged(handler: (data: TelegramBridgeStatus) => void): () => void {
    const listener = (_: unknown, data: TelegramBridgeStatus) => handler(data);
    ipcRenderer.on('telegram:status-changed', listener);
    return () => ipcRenderer.off('telegram:status-changed', listener);
  },
  appsConnect(name: string): Promise<{ ok: boolean; state: ConnectedAppsState; error?: string }> {
    return ipcRenderer.invoke('apps:connect', { name }) as Promise<{ ok: boolean; state: ConnectedAppsState; error?: string }>;
  },
  appsDisconnect(name: string): Promise<{ ok: boolean; state: ConnectedAppsState; error?: string }> {
    return ipcRenderer.invoke('apps:disconnect', { name }) as Promise<{ ok: boolean; state: ConnectedAppsState; error?: string }>;
  },
  appsSetAppIdentity(opts: { name: string; toolSlugs: string[] | null }): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke('apps:set-app-identity', opts) as Promise<{ ok: boolean; error?: string }>;
  },
  appsRestartApp(app: string): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke('apps:restart-app', { app }) as Promise<{ ok: boolean; error?: string }>;
  },
  gatewayGetStatus: (): Promise<GatewayTypes.GatewayStatus> => ipcRenderer.invoke('gateway:get-status'),
  gatewayGetSettings: (): Promise<GatewayTypes.GatewaySettingsView> => ipcRenderer.invoke('gateway:get-settings'),
  gatewayUpdateSettings: (opts: GatewayTypes.GatewaySettingsPatch): Promise<GatewayTypes.GatewaySettingsResult> => ipcRenderer.invoke('gateway:update-settings', opts),
  gatewayRotateKeys: (): Promise<GatewayTypes.GatewayActionResult> => ipcRenderer.invoke('gateway:rotate-keys'),
  gatewayGetEndpoint: (opts?: { app?: string }): Promise<GatewayTypes.GatewayEndpointInfo> => ipcRenderer.invoke('gateway:get-endpoint', opts),
  gatewayGetKeyInfo: (): Promise<GatewayTypes.GatewayKeyInfo | null> => ipcRenderer.invoke('gateway:get-key-info'),
  gatewayOpenConsole: (path?: string): Promise<GatewayTypes.GatewayActionResult> => ipcRenderer.invoke('gateway:open-console', { path }),
  gatewayGetPrivacy: (): Promise<GatewayTypes.GatewayPrivacyResult> => ipcRenderer.invoke('gateway:get-privacy'),
  gatewaySetPrivacy: (mode: GatewayTypes.GatewayPrivacyMode): Promise<GatewayTypes.GatewayPrivacyResult> => ipcRenderer.invoke('gateway:set-privacy', { mode }),
  gatewayGetRewards: (opts?: { force?: boolean }): Promise<GatewayTypes.GatewayRewardsResult> => ipcRenderer.invoke('gateway:get-rewards', opts),
  gatewayGetSavings: (): Promise<GatewayTypes.GatewaySavings | null> => ipcRenderer.invoke('gateway:get-savings'),
  agentSkillsList: (): Promise<GatewayTypes.AgentSkillStatus[]> => ipcRenderer.invoke('agent-skills:list'),
  agentSkillsInstall: (id: string): Promise<GatewayTypes.AgentSkillsResult> => ipcRenderer.invoke('agent-skills:install', { id }),
  agentSkillsRemove: (id: string): Promise<GatewayTypes.AgentSkillsResult> => ipcRenderer.invoke('agent-skills:remove', { id }),
  agentSkillsCopyPrompt: (): Promise<GatewayTypes.GatewayActionResult> => ipcRenderer.invoke('agent-skills:copy-prompt'),
  agentSkillsOpen: (id: string): Promise<GatewayTypes.OpenAgentResult> => ipcRenderer.invoke('agent-skills:open', { id }),
  onGatewayChanged(handler: () => void): () => void {
    const listener = () => handler();
    ipcRenderer.on('gateway:changed', listener);
    return () => ipcRenderer.off('gateway:changed', listener);
  },
};

// The preload runs in the renderer, where `location` exists — this file is
// compiled with the main-process tsconfig (node libs only), which doesn't
// know the DOM globals.
declare const location: { protocol: string; hostname: string };

// Child windows opened via window.open (the Fun checkout popups —
// payments/checkout-window.ts) inherit this preload from the main window but
// load third-party payment pages. The IPC bridge must never reach those
// documents: expose it only on the app's own origins (file:// in packaged
// builds, the localhost dev server / payments portal in dev).
const isAppDocument =
  location.protocol === 'file:' ||
  location.hostname === 'localhost' ||
  location.hostname === '127.0.0.1';
if (isAppDocument) {
  contextBridge.exposeInMainWorld('antseedDesktop', api);
}

export type DesktopBridge = typeof api;
