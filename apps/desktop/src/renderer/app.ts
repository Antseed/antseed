import '@antseed/ui/styles';
import { initChatModule } from './modules/chat/controller';
import { initSettingsModule } from './modules/app/settings';
import { initRuntimeModule } from './modules/app/runtime';
import { initDashboardRenderModule } from './modules/dashboard/render';
import { initDashboardApiModule } from './modules/dashboard/api';
import {
  initPluginSetupModule,
  resolveRouterPackageName,
} from './modules/app/plugin-setup';
import { initAppSetupModule } from './modules/app/setup';
import { initCreditsModule } from './modules/app/credits';
import { mountAppShell } from './ui/mount';
import { initThemeMode } from './ui/lib/theme';
import { registerActions } from './ui/actions';
import {
  DEFAULT_DASHBOARD_PORT,
  POLL_INTERVAL_MS,
  UI_MESSAGES,
} from './core/constants';
import { safeNumber, safeString } from './core/safe';
import type { BadgeTone } from './core/state';
import { createInitialUiState } from './core/state';
import { initStore, notifyUiStateChanged } from './core/store';
import type { DesktopBridge } from './types/bridge';
import { recordUserAction } from './modules/telemetry/actions';

/* ------------------------------------------------------------------ */
/*  Bootstrap                                                          */
/* ------------------------------------------------------------------ */

const bridge = window.antseedDesktop as DesktopBridge | undefined;

// `bridge.platform` comes from `process.platform` in the preload (Node side),
// which is the authoritative source. Fall back to a navigator sniff only when
// the preload didn't load (e.g. running the renderer in a plain browser for
// dev). We need this synchronously so the title bar paints with the correct
// macOS padding on the very first frame.
function detectApplePlatformFromNavigator(): boolean {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const hint = nav.userAgentData?.platform || navigator.platform || navigator.userAgent;
  return /Mac|iPhone|iPad|iPod/i.test(hint);
}

const isMacPlatform = bridge?.platform
  ? bridge.platform === 'darwin'
  : detectApplePlatformFromNavigator();
document.body.classList.toggle('platform-macos', isMacPlatform);

// Paint the persisted light/dark mode before anything renders.
initThemeMode();

// On macOS, when the system UI language is RTL (Hebrew, Arabic, Persian, Urdu),
// the window traffic-light buttons are mirrored to the top-right and would
// cover the title-bar right-side controls. Flip the padding in that case.
//
// We ask Electron's main process for `app.getLocale()` rather than reading
// `navigator.language`/`navigator.languages`. The latter reflect the *web*
// preferred-language list, which can disagree with the OS UI language on
// multilingual machines and produce false positives for LTR users.
const RTL_LANGUAGE_PREFIXES = new Set(['he', 'iw', 'ar', 'fa', 'ur', 'yi', 'ji']);

function isRtlLocale(locale: string | null | undefined): boolean {
  if (!locale) return false;
  const primary = String(locale).toLowerCase().split(/[-_]/)[0];
  return RTL_LANGUAGE_PREFIXES.has(primary);
}

async function applyMacOsRtlClass(): Promise<void> {
  if (!isMacPlatform) return;
  let locale: string | null = null;
  try {
    locale = (await bridge?.getSystemLocale?.()) ?? null;
  } catch {
    locale = null;
  }
  document.body.classList.toggle('platform-macos-rtl', isRtlLocale(locale));
}
void applyMacOsRtlClass();

const uiState = createInitialUiState();
initStore(uiState);

bridge?.onFullscreenChange?.((isFullscreen) => {
  document.body.classList.toggle('platform-fullscreen', isFullscreen);
});
bridge?.onWindowFocusChange?.((isFocused) => {
  document.body.classList.toggle('window-blurred', !isFocused);
});

/* ------------------------------------------------------------------ */
/*  Module initialisation                                              */
/* ------------------------------------------------------------------ */

const {
  appendLog,
  renderLogs,
  isModeRunning,
  renderProcesses,
  renderDaemonState,
  appendSystemLog,
} = initRuntimeModule({ uiState });

const {
  getDashboardPort,
  getDashboardData,
  updateDashboardConfig,
  scanDhtNow,
  setRefreshHooks,
  refreshDashboardData,
} = initDashboardApiModule({
  bridge,
  uiState,
  defaultDashboardPort: DEFAULT_DASHBOARD_PORT,
});


const {
  clearRouterPluginHint,
  updatePluginHintFromLog,
  renderPluginSetupState,
  refreshPluginInventory,
  installPluginPackage,
} = initPluginSetupModule({
  bridge,
  uiState,
  appendSystemLog,
});

const { populateSettingsForm, saveConfig } = initSettingsModule({
  uiState,
  getDashboardData: getDashboardData as (
    endpoint: string,
    query?: Record<string, string | number | boolean>,
  ) => Promise<{ ok: boolean; data: unknown; error?: string | null }>,
  updateDashboardConfig: updateDashboardConfig as (
    config: Record<string, unknown>,
  ) => Promise<{ ok: boolean; data: unknown; error?: string | null; status?: number | null }>,
  setDebugLogs: (enabled: boolean) => bridge?.setDebugLogs?.(enabled) ?? Promise.resolve(),
});

const {
  renderDashboardData,
  renderOfflineState,
} = initDashboardRenderModule({
  uiState,
  isModeRunning,
  appendSystemLog,
  populateSettingsForm,
});

// Credits API is created after chat, so use late-bound reference.
let creditsApi: ReturnType<typeof initCreditsModule>;

const chatApi = initChatModule({
  bridge,
  uiState,
  appendSystemLog,
});

initAppSetupModule({ uiState, bridge: bridge ?? null });

creditsApi = initCreditsModule({
  bridge: bridge as DesktopBridge,
  uiState,
});
creditsApi.startPeriodicRefresh();

// A browser pay page finished (deposit/withdraw/authorize) —
// refresh balances and the payment summary right away, bypassing throttles.
bridge?.onPaymentsCompleted?.(() => {
  void creditsApi.refreshCredits();
});


/* ------------------------------------------------------------------ */
/*  Runtime activity helpers                                           */
/* ------------------------------------------------------------------ */

let runtimeActivityHoldUntil = 0;

function setRuntimeActivity(tone: BadgeTone, message: string, holdMs = 0): void {
  if (holdMs > 0) {
    runtimeActivityHoldUntil = Math.max(runtimeActivityHoldUntil, Date.now() + holdMs);
  }
  const text = safeString(message, '').trim() || 'Idle';
  if (uiState.runtimeActivity.message === text && uiState.runtimeActivity.tone === tone) {
    return;
  }
  uiState.runtimeActivity = { tone, message: text };
  notifyUiStateChanged();
}

function setRuntimeSteadyActivity(tone: BadgeTone, message: string): void {
  if (Date.now() < runtimeActivityHoldUntil) return;
  setRuntimeActivity(tone, message);
}

function syncRuntimeActivityFromProcesses(processes = uiState.processes): void {
  const buyerConnected = isModeRunning('gateway', processes);
  setRuntimeSteadyActivity(
    buyerConnected ? 'active' : 'idle',
    buyerConnected
      ? 'Ready'
      : 'Buyer runtime offline. Waiting for local runtime start...',
  );
}

function syncBuyerRuntimeOverview(processes = uiState.processes): void {
  const buyerConnected = isModeRunning('gateway', processes);
  uiState.ovNodeState = buyerConnected ? 'connected' : 'offline';

  if (!uiState.refreshing) {
    const badgeLabel = uiState.overviewBadge.label.toLowerCase();
    if (buyerConnected) {
      if (badgeLabel.includes('offline') || badgeLabel.includes('idle')) {
        uiState.overviewBadge = { tone: 'active', label: 'CONNECTED • Refreshing DHT status...' };
      }
    } else {
      uiState.overviewBadge = { tone: 'idle', label: 'OFFLINE' };
    }
  }

  notifyUiStateChanged();
}

function updateRuntimeActivityFromLog(mode: string, lineRaw: string): void {
  const line = safeString(lineRaw, '').toLowerCase();
  if (!line) return;

  if (mode === 'gateway') {
    if (line.includes('connecting to p2p network')) {
      setRuntimeActivity('warn', 'Connecting to P2P network...', 6_000);
      return;
    }
    if (line.includes('connected to p2p network')) {
      setRuntimeActivity('active', 'Connected to P2P network.', 3_000);
      return;
    }
    if (line.includes('discovering peers')) {
      setRuntimeActivity('warn', 'Searching DHT for peers...', 6_000);
      return;
    }
    if (line.includes('/v1/models')) {
      setRuntimeActivity('warn', 'Loading service catalog from peers...', 8_000);
      return;
    }
    if (line.includes('proxy listening on')) {
      setRuntimeActivity('active', 'Buyer proxy online.', 4_000);
      return;
    }
    if (line.includes('no peers available')) {
      setRuntimeActivity('warn', 'No peers available for this request.', 8_000);
      return;
    }
    if (line.includes('timed out')) {
      setRuntimeActivity('bad', 'Peer request timed out. Retrying another route...', 10_000);
      return;
    }
  }

}

/* ------------------------------------------------------------------ */
/*  Refresh                                                            */
/* ------------------------------------------------------------------ */

type RefreshReason = 'poll' | 'manual' | 'startup';

async function refreshAll(reason: RefreshReason = 'poll'): Promise<void> {
  if (!bridge?.getState || uiState.refreshing) return;

  uiState.refreshing = true;
  uiState.overviewBadge = { tone: 'warn', label: 'Refreshing runtime and peers...' };
  uiState.peersMessage = 'Refreshing peers and runtime status...';
  notifyUiStateChanged();

  if (reason !== 'poll') {
    setRuntimeActivity('warn', 'Refreshing runtime and peer snapshots...', 8_000);
  }

  try {
    const snapshot = await bridge.getState();
    renderLogs(snapshot.logs);
    renderProcesses(snapshot.processes);
    syncBuyerRuntimeOverview(snapshot.processes);
    renderDaemonState(snapshot.daemonState);
    await refreshDashboardData(snapshot.processes);
    syncRuntimeActivityFromProcesses(snapshot.processes);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendSystemLog(`Refresh failed: ${message}`);
    uiState.peersMessage = `Unable to refresh runtime and peers: ${message}`;
    notifyUiStateChanged();
    setRuntimeActivity('bad', `Refresh failed: ${message}`, 10_000);
  } finally {
    uiState.refreshing = false;
    notifyUiStateChanged();
  }
}

/* ------------------------------------------------------------------ */
/*  Actions                                                            */
/* ------------------------------------------------------------------ */

function requireBridgeMethod<K extends keyof DesktopBridge>(
  key: K,
  unavailableMessage: string,
): NonNullable<DesktopBridge[K]> {
  const method = bridge?.[key];
  if (typeof method !== 'function') {
    throw new Error(unavailableMessage);
  }
  return method as NonNullable<DesktopBridge[K]>;
}

/** The local gateway starts with the app; this only covers a renderer that
    finished plugin setup after main's own start attempt failed. */
async function ensureConnectRuntimeStarted(): Promise<void> {
  if (!bridge?.start || isModeRunning('gateway')) return;
  // Don't start until plugin setup is resolved — starting without the router
  // plugin makes the buyer exit with "plugin not found".
  if (uiState.appSetupStatusKnown && uiState.appSetupNeeded && !uiState.appSetupComplete) return;
  setRuntimeActivity('warn', 'Starting your gateway...', 8_000);
  const result = await bridge.start();
  if (result.ok) {
    setRuntimeActivity('active', 'Gateway ready.', 4_000);
    return;
  }
  appendSystemLog(`Gateway start failed: ${result.error ?? 'unknown error'}`);
  setRuntimeActivity('bad', `Gateway start failed: ${result.error ?? 'unknown error'}`, 10_000);
}

async function actionRestartConnect(): Promise<void> {
  const restart = requireBridgeMethod('restart', 'Gateway restart is unavailable in this build');
  clearRouterPluginHint();
  uiState.connectBadge = { tone: 'idle', label: 'Restarting...' };
  notifyUiStateChanged();
  setRuntimeActivity('warn', 'Restarting your gateway...', 8_000);
  const result = await restart();
  if (!result.ok) {
    appendSystemLog(`Gateway restart failed: ${result.error ?? 'unknown error'}`);
    setRuntimeActivity('bad', `Gateway restart failed: ${result.error ?? 'unknown error'}`, 8_000);
  }
  await refreshAll('manual');
}

async function actionScanDht(): Promise<void> {
  uiState.peersMessage = 'Scanning DHT for peers...';
  uiState.overviewBadge = { tone: 'warn', label: 'Scanning DHT for peers...' };
  notifyUiStateChanged();
  setRuntimeActivity('warn', 'Scanning DHT for peers...', 12_000);
  try {
    const result = await scanDhtNow();
    if (!result.ok) {
      throw new Error(result.error ?? 'DHT scan failed');
    }
    appendSystemLog('Triggered immediate DHT scan.');
    setRuntimeActivity('active', 'DHT scan completed.', 4_000);
    await refreshAll('manual');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendSystemLog(`DHT scan failed: ${message}`);
    setRuntimeActivity('bad', `DHT scan failed: ${message}`, 8_000);
  }
}

async function actionClearLogs(): Promise<void> {
  const clearLogs = requireBridgeMethod('clearLogs', 'Log clearing is unavailable in this build');
  try {
    await clearLogs();
    await refreshAll('manual');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendSystemLog(`Clear logs failed: ${message}`);
  }
}

/* ------------------------------------------------------------------ */
/*  Register actions for React                                         */
/* ------------------------------------------------------------------ */

registerActions({
  restartConnect: () => { recordUserAction('runtime_start', 'connection'); return actionRestartConnect(); },
  refreshAll: () => { recordUserAction('discovery_refresh', 'unknown'); return refreshAll('manual'); },
  clearLogs: actionClearLogs,
  scanDht: () => { recordUserAction('discovery_refresh', 'connection'); return actionScanDht(); },
  saveConfig: (formData) => { recordUserAction('settings_save', 'config'); return saveConfig(formData); },
  createNewConversation: () => { recordUserAction('chat_new', 'chat'); return chatApi.createNewConversation(); },
  startNewChat: () => { recordUserAction('chat_new', 'chat'); chatApi.startNewChat(); },
  openConversation: (id) => { recordUserAction('chat_open', 'chats'); return chatApi.openConversation(id); },
  sendMessage: (text, attachments) => {
    recordUserAction('chat_send', 'chat');
    if ((attachments?.length ?? 0) > 0) recordUserAction('attachment_add', 'chat');
    chatApi.sendMessage(text, attachments);
  },
  sendMessageToConversation: (id, text, attachments) => {
    recordUserAction('chat_send', 'chat');
    if ((attachments?.length ?? 0) > 0) recordUserAction('attachment_add', 'chat');
    chatApi.sendMessageToConversation(id, text, attachments);
  },
  generateImage: (prompt) => { recordUserAction('image_generate', 'chat'); chatApi.generateImage(prompt); },
  abortChat: () => { recordUserAction('chat_stop', 'chat'); return chatApi.abortChat(); },
  deleteConversation: (id) => { recordUserAction('conversation_delete', 'chats'); return chatApi.deleteConversation(id); },
  renameConversation: (id, title) => { recordUserAction('conversation_rename', 'chats'); chatApi.renameConversation(id, title); },
  selectChatModel: (modelId) => chatApi.selectChatModel(modelId),
  refreshChatModels: (force) => {
    if (!force) recordUserAction('model_picker_open', 'chat');
    return chatApi.refreshChatModels(force ? { force: true } : {});
  },
  setChatPermissionMode: (mode) => { recordUserAction('chat_permission_change', 'chat'); chatApi.setChatPermissionMode(mode); },
  decideToolApproval: (decision, id) => { recordUserAction('tool_approval_decision', 'chat'); chatApi.decideToolApproval(decision, id); },
  retryAfterPayment: () => { recordUserAction('chat_retry', 'chat'); chatApi.retryAfterPayment(); },
  dismissFundsNotice: chatApi.dismissFundsNotice,
  refreshCredits: () => creditsApi.refreshCredits(),
  refreshWorkspace: chatApi.refreshWorkspace,
  chooseWorkspace: () => { recordUserAction('workspace_change', 'chat'); return chatApi.chooseWorkspace(); },
  refreshPlugins: refreshPluginInventory,
  installPlugin: () => {
    recordUserAction('plugin_install', 'setup');
    const packageName = resolveRouterPackageName(
      uiState.pluginHints.router || uiState.connectRouterValue,
    );
    return installPluginPackage(packageName);
  },
});

bridge?.onGatewayChanged?.(() => { void refreshAll('manual'); });

/* ------------------------------------------------------------------ */
/*  Mount React (store + actions both ready)                           */
/* ------------------------------------------------------------------ */

mountAppShell();

/* ------------------------------------------------------------------ */
/*  Refresh hooks (dashboard-api → dashboard-render bridge)            */
/* ------------------------------------------------------------------ */

setRefreshHooks({
  setDashboardRefreshState: (busy: boolean, stage: string) => {
    if (busy) {
      uiState.peersMessage = stage;
      uiState.overviewBadge = { tone: 'active', label: stage };
      notifyUiStateChanged();
      return;
    }
    syncBuyerRuntimeOverview();
    syncRuntimeActivityFromProcesses();
  },
  renderDashboardData,
  refreshChatConversations: chatApi.refreshChatConversations,
  // The chat no longer probes a buyer proxy; its model list follows the gateway.
  refreshChatProxyStatus: () => undefined,
});

/* ------------------------------------------------------------------ */
/*  Bridge initialisation                                              */
/* ------------------------------------------------------------------ */

function initializeBridge(): void {
  if (!bridge) {
    appendSystemLog(UI_MESSAGES.desktopBridgeUnavailable);
    renderOfflineState('Desktop bridge unavailable.');
    setRuntimeActivity('bad', 'Desktop bridge unavailable.', 15_000);
    return;
  }

  let hasStructuredRuntimeActivity = false;

  bridge.onRuntimeActivity?.((activity) => {
    hasStructuredRuntimeActivity = true;
    const holdMs = Math.max(0, safeNumber(activity.holdMs, 0));
    setRuntimeActivity(activity.tone, activity.message, holdMs);
  });

  bridge.onLog?.((event) => {
    updatePluginHintFromLog(event);
    appendLog(event);
    if (event.mode === 'gateway') {
      chatApi.handleLogLineForThinkingPhase(event.line);
    }
    renderPluginSetupState();
    if (!hasStructuredRuntimeActivity) {
      updateRuntimeActivityFromLog(event.mode, event.line);
    }
  });

  bridge.onPeersChanged?.(() => {
    void chatApi.refreshChatModels({ force: true });
  });

  bridge.onState?.((processes) => {
    renderProcesses(processes);
    syncBuyerRuntimeOverview(processes);
    syncRuntimeActivityFromProcesses(processes);

    if (isModeRunning('gateway', processes)) {
      clearRouterPluginHint();
    }

    renderPluginSetupState();
  });

  void (async () => {
    await refreshAll('startup');
    await ensureConnectRuntimeStarted();
    await refreshAll('startup');
  })();

  void refreshPluginInventory().catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    appendSystemLog(`Plugin inventory refresh failed: ${message}`);
  });

  setInterval(() => {
    void refreshAll('poll');
  }, POLL_INTERVAL_MS);
}

/* ------------------------------------------------------------------ */
/*  Start                                                              */
/* ------------------------------------------------------------------ */

renderPluginSetupState();
setRuntimeActivity('idle', 'Initializing desktop runtime...', 6_000);
initializeBridge();
