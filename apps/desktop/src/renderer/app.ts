import { reloadPrivacyForNewGateway } from './modules/app/vpr-resources';
import '@antseed/ui/styles';
import { initChatModule } from './modules/chat/controller';
import { initSettingsModule } from './modules/app/settings';
import { initRuntimeModule } from './modules/app/runtime';
import { initDashboardRenderModule } from './modules/dashboard/render';
import { initDashboardApiModule } from './modules/dashboard/api';
import { initAppSetupModule } from './modules/app/setup';
import { initCreditsModule } from './modules/app/credits';
import { mountAppShell } from './ui/mount';
import { initThemeMode } from './ui/lib/theme';
import { registerActions } from './ui/actions';
import { createInitialUiState } from './core/state';
import { initStore, notifyUiStateChanged } from './core/store';
import type { DesktopBridge } from './types/bridge';
import { recordUserAction } from './modules/telemetry/actions';

/* ------------------------------------------------------------------ */
/*  Bootstrap                                                          */
/* ------------------------------------------------------------------ */

const POLL_INTERVAL_MS = 5000;

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
  getDashboardData,
  updateDashboardConfig,
  setRefreshHooks,
  refreshDashboardData,
} = initDashboardApiModule({ bridge });

const { populateSettingsForm, saveConfig } = initSettingsModule({
  uiState,
  getDashboardData,
  updateDashboardConfig,
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
/*  Refresh                                                            */
/* ------------------------------------------------------------------ */

let refreshing = false;

async function refreshAll(): Promise<void> {
  if (!bridge?.getState || refreshing) return;
  refreshing = true;

  try {
    const [snapshot, gatewayStatus] = await Promise.all([
      bridge.getState(),
      bridge.gatewayGetStatus?.()?.catch(() => null) ?? null,
    ]);
    uiState.gatewayStatus = gatewayStatus;
    renderLogs(snapshot.logs);
    renderProcesses(snapshot.processes);
    renderDaemonState(snapshot.daemonState);
    await refreshDashboardData();
  } catch (err) {
    appendSystemLog(`Refresh failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    refreshing = false;
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
  const result = await bridge.start();
  if (!result.ok) appendSystemLog(`Gateway start failed: ${result.error ?? 'unknown error'}`);
}

async function actionRestartConnect(): Promise<void> {
  const restart = requireBridgeMethod('restart', 'Gateway restart is unavailable in this build');
  uiState.gatewayStatus = null;
  uiState.connectBadge = { tone: 'idle', label: 'Restarting...' };
  notifyUiStateChanged();
  const result = await restart();
  if (!result.ok) appendSystemLog(`Gateway restart failed: ${result.error ?? 'unknown error'}`);
  await refreshAll();
}

async function actionClearLogs(): Promise<void> {
  const clearLogs = requireBridgeMethod('clearLogs', 'Log clearing is unavailable in this build');
  try {
    await clearLogs();
    await refreshAll();
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
  clearLogs: actionClearLogs,
  saveConfig: (formData) => { recordUserAction('settings_save', 'config'); return saveConfig(formData); },
  startNewChat: () => { recordUserAction('chat_new', 'chat'); chatApi.startNewChat(); },
  startNewChatOnModel: (modelId) => { recordUserAction('chat_new', 'chat'); chatApi.startNewChatOnModel(modelId); },
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
  setConversationFlags: (id, flags) => chatApi.setConversationFlags(id, flags),
  selectChatModel: (modelId) => chatApi.selectChatModel(modelId),
  privacyModeChosen: (mode, choice) => { chatApi?.privacyModeChosen(mode, choice); },
  privacySwitchLanded: (mode) => chatApi?.privacySwitchLanded(mode) ?? Promise.resolve(),
  refreshChatModels: (force) => {
    if (!force) recordUserAction('model_picker_open', 'chat');
    return chatApi.refreshChatModels(force ? { force: true } : {});
  },
  setChatPermissionMode: (mode) => { recordUserAction('chat_permission_change', 'chat'); chatApi.setChatPermissionMode(mode); },
  decideToolApproval: (decision, id) => { recordUserAction('tool_approval_decision', 'chat'); chatApi.decideToolApproval(decision, id); },
  retryAfterPayment: () => { recordUserAction('chat_retry', 'chat'); chatApi.retryAfterPayment(); },
  dismissFundsNotice: chatApi.dismissFundsNotice,
  refreshCredits: () => creditsApi.refreshCredits(),
  chooseWorkspace: () => { recordUserAction('workspace_change', 'chat'); return chatApi.chooseWorkspace(); },
});

bridge?.onGatewayChanged?.(() => {
  void refreshAll();
  void reloadPrivacyForNewGateway();
});

/* ------------------------------------------------------------------ */
/*  Mount React (store + actions both ready)                           */
/* ------------------------------------------------------------------ */

mountAppShell();

/* ------------------------------------------------------------------ */
/*  Refresh hooks (dashboard-api → dashboard-render bridge)            */
/* ------------------------------------------------------------------ */

setRefreshHooks({
  renderDashboardData,
  refreshChatConversations: chatApi.refreshChatConversations,
});

/* ------------------------------------------------------------------ */
/*  Bridge initialisation                                              */
/* ------------------------------------------------------------------ */

function initializeBridge(): void {
  if (!bridge) {
    appendSystemLog('Desktop bridge unavailable: preload failed to inject API. Restart app after main/preload compile.');
    renderOfflineState('Desktop bridge unavailable.');
    return;
  }

  bridge.onLog?.((event) => {
    appendLog(event);
    if (event.mode === 'gateway') {
      chatApi.handleLogLineForThinkingPhase(event.line);
    }
  });

  bridge.onPeersChanged?.(() => {
    void chatApi.refreshChatModels({ force: true });
  });

  bridge.onState?.((processes) => {
    renderProcesses(processes);
  });

  void (async () => {
    await refreshAll();
    await ensureConnectRuntimeStarted();
    await refreshAll();
  })();

  setInterval(() => {
    void refreshAll();
  }, POLL_INTERVAL_MS);
}

/* ------------------------------------------------------------------ */
/*  Start                                                              */
/* ------------------------------------------------------------------ */

initializeBridge();
