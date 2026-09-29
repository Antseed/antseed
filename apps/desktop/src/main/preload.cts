import { contextBridge, ipcRenderer } from 'electron';
import type { RuntimeMode, RuntimeProcessState, StartOptions } from './runtime/process-manager.js';
import type {
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

type RuntimeActivityTone = 'active' | 'idle' | 'warn' | 'bad';

type RuntimeActivityEvent = {
  mode: RuntimeMode;
  tone: RuntimeActivityTone;
  stage: string;
  message: string;
  holdMs: number;
  timestamp: number;
  requestId?: string;
  peerId?: string;
};

type RuntimeSnapshot = {
  processes: RuntimeProcessState[];
  daemonState: { exists: boolean; state: Record<string, unknown> | null };
  logs: LogEvent[];
};

type NetworkPeer = {
  peerId: string;
  host: string;
  port: number;
  providers: string[];
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  capacityMsgPerHour: number;
  reputation: number;
  lastSeen: number;
  source: 'dht' | 'daemon';
};

type NetworkStats = {
  totalPeers: number;
  dhtNodeCount: number;
  dhtHealthy: boolean;
  lastScanAt: number | null;
  totalLookups?: number;
  successfulLookups?: number;
  lookupSuccessRate?: number;
  averageLookupLatencyMs?: number;
  healthReason?: string;
};

type NetworkSnapshot = {
  ok: boolean;
  peers: NetworkPeer[];
  stats: NetworkStats;
  error: string | null;
};

type DataEndpoint = 'status' | 'network' | 'peers' | 'config' | 'data-sources';

type DataResult = {
  ok: boolean;
  data: unknown | null;
  error: string | null;
  status: number | null;
};

type PluginInfo = {
  package: string;
  version: string;
};

type PluginListResult = {
  ok: boolean;
  plugins: PluginInfo[];
  error: string | null;
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
  kind: 'image' | 'text' | 'archive' | 'error';
  status: 'ready' | 'error';
  text?: string;
  image?: { type: 'image'; data: string; mimeType: string };
  error?: string;
  truncated?: boolean;
  native?: { provider?: string; payload?: unknown };
};

type PluginInstallResult = {
  ok: boolean;
  package: string;
  plugins: PluginInfo[];
  error: string | null;
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
type ToolApprovalDecision = 'allow_once' | 'always_allow_peer' | 'deny';
type ToolApprovalRequest = {
  id: string;
  conversationId: string;
  toolCallId: string;
  toolName: string;
  permissionKey: string;
  permissionLabel: string;
  input: Record<string, unknown>;
  workspacePath: string;
  peerId: string | null;
  peerName: string | null;
  title: string;
  description: string;
  subject: string;
  alwaysAllowLabel: string;
  canAlwaysAllow: boolean;
};

// Mirrors TelegramBridgeStatus in apps/desktop/src/main/telegram/bridge.ts
// (sandboxed preload cannot import from main). Keep in sync — and with the
// renderer copy in apps/desktop/src/renderer/types/bridge.ts.
type TelegramBridgeStatus = {
  configured: boolean;
  running: boolean;
  botUsername: string | null;
  paired: boolean;
  ownerName: string | null;
  pairingLink: string | null;
  lastError: string | null;
};

// NOTE: Source of truth lives in apps/desktop/src/main/chat/stream-stop.ts
// (`ChatStreamStopReason`). This preload runs in a sandboxed context and
// cannot import from main, so the shape is mirrored here for IPC. Keep the
// `kind`, `source`, and field set in sync with the source-of-truth type —
// and with the renderer copy in apps/desktop/src/renderer/types/bridge.ts.
type ChatAiStreamStopReason = {
  kind: 'payment_required' | 'aborted' | 'timeout' | 'http_error' | 'network_error' | 'stream_error' | 'unknown';
  source: 'billing' | 'user' | 'transport' | 'upstream' | 'unknown';
  retryable: boolean;
  message: string;
  statusCode?: number;
  errorCode?: string;
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
  getOpenRouterReferencePrices(): Promise<Record<string, { input: number | null; output: number | null }>> {
    return ipcRenderer.invoke('openrouter:reference-prices') as Promise<
      Record<string, { input: number | null; output: number | null }>
    >;
  },
  getState(): Promise<RuntimeSnapshot> {
    return ipcRenderer.invoke('runtime:get-state') as Promise<RuntimeSnapshot>;
  },
  start(options: StartOptions): Promise<{ state: RuntimeProcessState; processes: RuntimeProcessState[]; daemonState: { exists: boolean; state: Record<string, unknown> | null } }> {
    return ipcRenderer.invoke('runtime:start', options) as Promise<{ state: RuntimeProcessState; processes: RuntimeProcessState[]; daemonState: { exists: boolean; state: Record<string, unknown> | null } }>;
  },
  stop(mode: RuntimeMode): Promise<{ state: RuntimeProcessState; processes: RuntimeProcessState[]; daemonState: { exists: boolean; state: Record<string, unknown> | null } }> {
    return ipcRenderer.invoke('runtime:stop', mode) as Promise<{ state: RuntimeProcessState; processes: RuntimeProcessState[]; daemonState: { exists: boolean; state: Record<string, unknown> | null } }>;
  },
  openDashboard(port?: number): Promise<{ ok: true }> {
    return ipcRenderer.invoke('runtime:open-dashboard', port) as Promise<{ ok: true }>;
  },
  clearLogs(): Promise<{ ok: true }> {
    return ipcRenderer.invoke('runtime:clear-logs') as Promise<{ ok: true }>;
  },
  pluginsList(): Promise<PluginListResult> {
    return ipcRenderer.invoke('plugins:list') as Promise<PluginListResult>;
  },
  pluginsInstall(packageName: string): Promise<PluginInstallResult> {
    return ipcRenderer.invoke('plugins:install', packageName) as Promise<PluginInstallResult>;
  },
  getNetwork(port?: number): Promise<NetworkSnapshot> {
    return ipcRenderer.invoke('runtime:get-network', port) as Promise<NetworkSnapshot>;
  },
  getData(
    endpoint: DataEndpoint,
    options?: { port?: number; query?: Record<string, string | number | boolean> },
  ): Promise<DataResult> {
    return ipcRenderer.invoke('runtime:get-data', endpoint, options) as Promise<DataResult>;
  },
  updateConfig(
    config: Record<string, unknown>,
  ): Promise<DataResult> {
    return ipcRenderer.invoke('runtime:update-config', config) as Promise<DataResult>;
  },
  scanNetwork(): Promise<DataResult> {
    return ipcRenderer.invoke('runtime:scan-network') as Promise<DataResult>;
  },
  lookupPeer(peerId: string): Promise<{ ok: boolean; peer: unknown; error: string | null }> {
    return ipcRenderer.invoke('runtime:lookup-peer', peerId) as Promise<{ ok: boolean; peer: unknown; error: string | null }>;
  },
  touchPeer(peerId: string): void {
    void ipcRenderer.invoke('runtime:touch-peer', peerId);
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
  onRuntimeActivity(handler: (event: RuntimeActivityEvent) => void): () => void {
    const listener = (_: unknown, event: RuntimeActivityEvent) => handler(event);
    ipcRenderer.on('runtime:activity', listener);
    return () => ipcRenderer.off('runtime:activity', listener);
  },

  // AI Chat API
  chatAiListConversations(): Promise<{ ok: boolean; data: unknown[] }> {
    return ipcRenderer.invoke('chat:ai-list-conversations');
  },
  chatAiGetConversation(id: string): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    return ipcRenderer.invoke('chat:ai-get-conversation', id);
  },
  chatAiCreateConversation(service: string, provider?: string, peerId?: string, routeMode?: 'auto' | 'pinned'): Promise<{ ok: boolean; data?: unknown; error?: string }> {
    return ipcRenderer.invoke('chat:ai-create-conversation', service, provider, peerId, routeMode);
  },
  chatAiListDiscoverRows(): Promise<{ ok: boolean; data?: unknown[]; error?: string }> {
    return ipcRenderer.invoke('chat:ai-list-discover-rows');
  },
  chatAiDeleteConversation(id: string): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('chat:ai-delete-conversation', id);
  },
  chatAiRenameConversation(id: string, title: string): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke('chat:ai-rename-conversation', id, title);
  },
  chatPrepareAttachments(conversationId: string, attachments: RawChatAttachment[]): Promise<{ ok: boolean; data?: PreparedChatAttachment[]; error?: string }> {
    return ipcRenderer.invoke('chat:prepare-attachments', conversationId, attachments);
  },
  attachmentDownload(conversationId: string, attachmentId: string, suggestedName: string): Promise<{ ok: boolean; path?: string; error?: string }> {
    return ipcRenderer.invoke('attachment:download', conversationId, attachmentId, suggestedName);
  },
  chatGenerateImage(payload: { conversationId: string; prompt: string; peerId?: string; moderation?: 'auto' | 'low'; service: string; sourceImageAttachmentId?: string }): Promise<{ ok: boolean; user?: unknown; assistant?: unknown; error?: string }> {
    return ipcRenderer.invoke('chat:generate-image', payload);
  },
  chatAiSend(conversationId: string, message: string, service?: string, provider?: string, attachments?: PreparedChatAttachment[], peerId?: string, permissionMode?: ChatPermissionMode): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke('chat:ai-send', conversationId, message, service, provider, attachments, peerId, permissionMode);
  },
  chatAiSendStream(conversationId: string, message: string, service?: string, provider?: string, attachments?: PreparedChatAttachment[], peerId?: string, permissionMode?: ChatPermissionMode): Promise<{ ok: boolean; error?: string; stopReason?: ChatAiStreamStopReason }> {
    return ipcRenderer.invoke('chat:ai-send-stream', conversationId, message, service, provider, attachments, peerId, permissionMode);
  },
  chatPeerPermissionModeGet(peerId: string): Promise<{ ok: boolean; mode?: ChatPermissionMode; error?: string }> {
    return ipcRenderer.invoke('chat:peer-permission-mode-get', peerId);
  },
  chatPeerPermissionModeSet(peerId: string, mode: ChatPermissionMode): Promise<{ ok: boolean; mode?: ChatPermissionMode; error?: string }> {
    return ipcRenderer.invoke('chat:peer-permission-mode-set', { peerId, mode });
  },
  chatToolApprovalDecision(id: string, decision: ToolApprovalDecision): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke('chat:tool-approval-decision', { id, decision });
  },
  chatAiAbort(conversationId?: string): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('chat:ai-abort', conversationId);
  },
  chatAiSelectPeer(payload: { conversationId?: string | null; peerId?: string | null; service?: string | null; provider?: string | null; routeMode?: 'auto' | 'pinned' | null }): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke('chat:ai-select-peer', payload);
  },
  chatSetBuyerDefaultRoute(payload: { peerId?: string; service: string }): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke('chat:set-buyer-default-route', payload);
  },
  chatSyncModelPicker(payload: unknown): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('chat:sync-model-picker', payload);
  },
  chatAiGetProxyStatus(): Promise<{ ok: boolean; data: { running: boolean; port: number } }> {
    return ipcRenderer.invoke('chat:ai-get-proxy-status');
  },
  apiTryProxyRequest(params: {
    port: number;
    path: string;
    method: string;
    headers: Record<string, string>;
    body: string;
  }): Promise<{ ok: boolean; status: number; body: string; error: string | null }> {
    return ipcRenderer.invoke('api:try-proxy-request', params);
  },
  chatAiGetWorkspace(): Promise<{ ok: boolean; data?: { current: string; default: string }; error?: string }> {
    return ipcRenderer.invoke('chat:ai-get-workspace');
  },
  chatAiGetWorkspaceGitStatus(): Promise<{
    ok: boolean;
    data?: {
      available: boolean;
      rootPath: string | null;
      branch: string | null;
      isDetached: boolean;
      ahead: number;
      behind: number;
      stagedFiles: number;
      modifiedFiles: number;
      untrackedFiles: number;
      error: string | null;
    };
    error?: string;
  }> {
    return ipcRenderer.invoke('chat:ai-get-workspace-git-status');
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
  openToolSession(tool: string, sessionKey: string, target?: 'terminal' | 'app'): Promise<{ ok: boolean; command?: string; error?: string }> {
    return ipcRenderer.invoke('desktop:open-tool-session', tool, sessionKey, target ?? 'terminal') as Promise<{ ok: boolean; command?: string; error?: string }>;
  },
  listInstalledApps(): Promise<{ ok: boolean; apps: Array<{ name: string; path: string; iconDataUri?: string }>; error?: string }> {
    return ipcRenderer.invoke('desktop:list-installed-apps') as Promise<{ ok: boolean; apps: Array<{ name: string; path: string; iconDataUri?: string }>; error?: string }>;
  },
  systemProxySetAppLaunch(opts: { name: string; app: { name: string; path: string } | null }): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke('system-proxy:set-app-launch', opts) as Promise<{ ok: boolean; error?: string }>;
  },
  applyWindowView(viewName: string): Promise<{ ok: true; skipped?: string }> {
    return ipcRenderer.invoke('window:apply-view', viewName) as Promise<{ ok: true; skipped?: string }>;
  },
  applyWindowPreset(presetName: string): Promise<{ ok: true; skipped?: string }> {
    return ipcRenderer.invoke('window:apply-preset', presetName) as Promise<{ ok: true; skipped?: string }>;
  },
  onNavigateView(handler: (viewName: string) => void): () => void {
    const listener = (_: unknown, viewName: string) => handler(viewName);
    ipcRenderer.on('desktop:navigate-view', listener);
    return () => ipcRenderer.off('desktop:navigate-view', listener);
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
  onChatAiError(handler: (data: { conversationId: string; error: string }) => void): () => void {
    const listener = (_: unknown, data: { conversationId: string; error: string }) => handler(data);
    ipcRenderer.on('chat:ai-error', listener);
    return () => ipcRenderer.off('chat:ai-error', listener);
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
  onChatDefaultRouteChanged(handler: (data: { peerId: string; service: string; provider: string | null }) => void): () => void {
    const listener = (_: unknown, data: { peerId: string; service: string; provider: string | null }) => handler(data);
    ipcRenderer.on('chat:default-route-changed', listener);
    return () => ipcRenderer.off('chat:default-route-changed', listener);
  },
  // Streaming events
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
  getTeeStatus(): Promise<unknown> {
    return ipcRenderer.invoke('tee:status');
  },
  checkSellerTee(peerId: string): Promise<unknown> {
    return ipcRenderer.invoke('tee:check', peerId);
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
  creditsGetInfo() {
    return ipcRenderer.invoke('credits:get-info');
  },
  identityExportKey: () => ipcRenderer.invoke('identity:export-key'),
  identityImportKey: (privateKeyHex: string) => ipcRenderer.invoke('identity:import-key', privateKeyHex),
  paymentsSignSpendingAuth: (params: unknown) => ipcRenderer.invoke('payments:sign-spending-auth', params),
  paymentsGetPeerInfo: (peerId: string) => ipcRenderer.invoke('payments:get-peer-info', peerId),
  stakingOpen: (options?: { page?: 'stake' | 'rewards' }) => ipcRenderer.invoke('staking:open', options),
  stakingCopyLink: (options?: { page?: 'stake' | 'rewards' }) => ipcRenderer.invoke('staking:copyLink', options),
  paymentsOpenPayPage: (opts: { kind?: string; amountUsdc?: string; channelId?: string }) => ipcRenderer.invoke('payments:open-pay-page', opts),
  paymentsCardProviders: () => ipcRenderer.invoke('payments:card-providers'),
  paymentsOpenCardProvider: (opts?: { providerId?: string; amountUsdc?: string }) => ipcRenderer.invoke('payments:open-card-provider', opts),
  paymentsCloseCheckoutWindows: (): Promise<{ ok: boolean }> => ipcRenderer.invoke('payments:close-checkout-windows') as Promise<{ ok: boolean }>,
  paymentsGetBuyerUsage: () => ipcRenderer.invoke('payments:get-buyer-usage'),
  paymentsGetBuyerSpendHistory: () => ipcRenderer.invoke('payments:get-buyer-spend-history'),
  paymentsGetChannels: () => ipcRenderer.invoke('payments:get-channels'),
  paymentsRequestCooperativeClose: (opts: { peerId: string }) => ipcRenderer.invoke('payments:request-cooperative-close', opts),
  paymentsGetRewardsSummary: () => ipcRenderer.invoke('payments:get-rewards-summary'),
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
  systemProxyStart(opts: { peerId: string; port?: number; profiles?: string[]; defaultModel?: string; servedModels?: string[]; toolRoutes?: Record<string, { peerId: string; model: string }>; profileSwitch?: boolean }): Promise<{ ok: boolean; state?: RuntimeProcessState; error?: string }> {
    return ipcRenderer.invoke('system-proxy:start', opts) as Promise<{ ok: boolean; state?: RuntimeProcessState; error?: string }>;
  },
  systemProxyListProfiles() {
    return ipcRenderer.invoke('system-proxy:list-profiles');
  },
  systemProxyAddCustomApp(opts: { apiUrl: string; app?: { name: string; path: string } | null; force?: boolean }): Promise<{ ok: boolean; name?: string; unverified?: boolean; error?: string }> {
    return ipcRenderer.invoke('system-proxy:add-custom-app', opts) as Promise<{ ok: boolean; name?: string; unverified?: boolean; error?: string }>;
  },
  systemProxySetAppIdentity(opts: { name: string; toolSlugs: string[] | null }): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke('system-proxy:set-app-identity', opts) as Promise<{ ok: boolean; error?: string }>;
  },
  systemProxyRemoveCustomApp(name: string): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke('system-proxy:remove-custom-app', { name }) as Promise<{ ok: boolean; error?: string }>;
  },
  systemProxyStop(): Promise<{ ok: boolean; state?: RuntimeProcessState; error?: string }> {
    return ipcRenderer.invoke('system-proxy:stop') as Promise<{ ok: boolean; state?: RuntimeProcessState; error?: string }>;
  },
  systemProxyGetState(): Promise<RuntimeProcessState | null> {
    return ipcRenderer.invoke('system-proxy:get-state') as Promise<RuntimeProcessState | null>;
  },
  systemProxyInstallCa(): Promise<{ ok: boolean; warning?: string; error?: string }> {
    return ipcRenderer.invoke('system-proxy:install-ca') as Promise<{ ok: boolean; warning?: string; error?: string }>;
  },
  systemProxyCaExists(): Promise<boolean> {
    return ipcRenderer.invoke('system-proxy:ca-exists') as Promise<boolean>;
  },
  systemProxyCaInfo(): Promise<{ path: string; exists: boolean }> {
    return ipcRenderer.invoke('system-proxy:ca-info') as Promise<{ path: string; exists: boolean }>;
  },
  systemProxyRevealCa(): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke('system-proxy:reveal-ca') as Promise<{ ok: boolean; error?: string }>;
  },
  systemProxyCaTrustState(): Promise<{ ok: boolean; exists: boolean; trust: 'trusted' | 'stale' | 'absent' | 'unknown'; error?: string }> {
    return ipcRenderer.invoke('system-proxy:ca-trust-state') as Promise<{ ok: boolean; exists: boolean; trust: 'trusted' | 'stale' | 'absent' | 'unknown'; error?: string }>;
  },
  systemProxyTestGui(opts?: { port?: number }) {
    return ipcRenderer.invoke('system-proxy:test-gui', opts);
  },
  systemProxyRestartApp(app: string): Promise<{ ok: boolean; error?: string }> {
    return ipcRenderer.invoke('system-proxy:restart-app', { app }) as Promise<{ ok: boolean; error?: string }>;
  },
  publicTunnelGetStatus: () => ipcRenderer.invoke('public-tunnel:get-status'),
  publicTunnelConfigure: (settings: { provider: 'cloudflare' | 'ngrok'; tunnelToken: string; publicUrl: string }) => ipcRenderer.invoke('public-tunnel:configure', settings),
  publicTunnelStart: (settings?: { provider?: 'cloudflare' | 'ngrok' }) => ipcRenderer.invoke('public-tunnel:start', settings),
  publicTunnelStop: () => ipcRenderer.invoke('public-tunnel:stop'),
  publicTunnelGetApiKey: () => ipcRenderer.invoke('public-tunnel:get-api-key'),

  /* Floating always-on-top pill window */
  vprFloatOpen(data: unknown): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('vpr-float:open', data) as Promise<{ ok: boolean }>;
  },
  vprFloatClose(): Promise<{ ok: boolean }> {
    return ipcRenderer.invoke('vpr-float:close') as Promise<{ ok: boolean }>;
  },
  vprFloatIsOpen(): Promise<boolean> {
    return ipcRenderer.invoke('vpr-float:is-open') as Promise<boolean>;
  },
  vprFloatGetCompact(): Promise<boolean> {
    return ipcRenderer.invoke('vpr-float:get-compact') as Promise<boolean>;
  },
  vprFloatUpdate(data: unknown): void {
    ipcRenderer.send('vpr-float:update', data);
  },
  vprFloatAction(action: unknown): void {
    ipcRenderer.send('vpr-float:action', action);
  },
  vprFloatSetExpanded(expanded: boolean): void {
    ipcRenderer.send('vpr-float:set-expanded', expanded);
  },
  buyerConversationsList(): Promise<unknown[] | null> {
    return ipcRenderer.invoke('buyer:conversations-list') as Promise<unknown[] | null>;
  },
  buyerConversationsUpdate(opts: { id: string; label?: string | null; pinnedModel?: string; peerSource?: 'auto' | 'user'; delete?: boolean }): Promise<{ ok: boolean; conversation?: unknown; error?: string }> {
    return ipcRenderer.invoke('buyer:conversations-update', opts) as Promise<{ ok: boolean; conversation?: unknown; error?: string }>;
  },
  onVprFloatData(handler: (data: unknown) => void): () => void {
    const listener = (_: unknown, data: unknown) => handler(data);
    ipcRenderer.on('vpr-float:data', listener);
    return () => ipcRenderer.off('vpr-float:data', listener);
  },
  onVprFloatCompact(handler: (compact: boolean) => void): () => void {
    const listener = (_: unknown, compact: boolean) => handler(Boolean(compact));
    ipcRenderer.on('vpr-float:compact', listener);
    return () => ipcRenderer.off('vpr-float:compact', listener);
  },
  onVprFloatClosed(handler: () => void): () => void {
    const listener = () => handler();
    ipcRenderer.on('vpr-float:closed', listener);
    return () => ipcRenderer.off('vpr-float:closed', listener);
  },
  onVprFloatAction(handler: (action: unknown) => void): () => void {
    const listener = (_: unknown, action: unknown) => handler(action);
    ipcRenderer.on('vpr-float:action', listener);
    return () => ipcRenderer.off('vpr-float:action', listener);
  },
  onDesktopOpenFloatingWindow(handler: () => void): () => void {
    const listener = () => handler();
    ipcRenderer.on('desktop:open-floating-window', listener);
    return () => ipcRenderer.off('desktop:open-floating-window', listener);
  },
  onDesktopConnectMain(handler: () => void): () => void {
    const listener = () => handler();
    ipcRenderer.on('desktop:connect-main', listener);
    return () => ipcRenderer.off('desktop:connect-main', listener);
  },
  onDesktopDisconnectMain(handler: () => void): () => void {
    const listener = () => handler();
    ipcRenderer.on('desktop:disconnect-main', listener);
    return () => ipcRenderer.off('desktop:disconnect-main', listener);
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
