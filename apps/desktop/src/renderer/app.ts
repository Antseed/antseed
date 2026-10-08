import '@antseed/ui/styles';
import { initChatModule } from './modules/chat/controller';
import { initSettingsModule } from './modules/app/settings';
import { initRuntimeModule } from './modules/app/runtime';
import { initDashboardRenderModule } from './modules/dashboard/render';
import { initDashboardApiModule } from './modules/dashboard/api';
import {
  initPluginSetupModule,
  normalizeRouterRuntime,
  resolveRouterPackageName,
} from './modules/app/plugin-setup';
import { initAppSetupModule } from './modules/app/setup';
import { initCreditsModule } from './modules/app/credits';
import { initReminderModule } from './modules/app/reminder';
import { initVprFloatModule } from './modules/app/float';
import {
  loadFloatAutoOpen,
  loadFloatShowRoutedPeer,
  saveFloatAutoOpen,
  saveFloatShowRoutedPeer,
} from './modules/app/float-settings';
import { initModelPickerSync } from './modules/catalog/picker-sync';
import { applyVprRouteToConnectedProxy } from './modules/routing/proxy-sync';
import { createVprRouteSelection, findCatalogEntry } from './modules/catalog/model-catalog';
import { resolveVprChatOption } from './modules/chat/projection';
import {
  applyPeerListing,
  buyerModelRoutingPreferences,
  loadVprRouteSelection,
  loadVprRoutingPreferences,
  saveVprRouteSelection,
  saveVprRoutingPreferences,
} from './modules/routing/preferences';
import {
  clearVprModelPin,
  filterVprModelPins,
  loadVprModelPins,
  saveVprModelPins,
  setVprModelPin,
  vprModelPinFor,
} from './modules/routing/model-pins';
import { isPeerRoutable } from './modules/routing/select';
import { sweepAutoChatsToSeller } from './modules/routing/chat-peer-sweep';
import { buyerConversationsResource } from './modules/app/vpr-resources';
import { routesForSelectedModel } from './modules/catalog/view-models';
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
import { recordUserAction, recordUserActionCoalesced } from './modules/telemetry/actions';

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
uiState.vprRoutingPreferences = loadVprRoutingPreferences(uiState.vprRoutingPreferences);
uiState.vprRouteSelection = loadVprRouteSelection(uiState.vprRouteSelection);
uiState.vprModelPins = loadVprModelPins();
uiState.vprFloatAutoOpen = loadFloatAutoOpen();
uiState.vprFloatShowRoutedPeer = loadFloatShowRoutedPeer();
// Sessions that pinned a seller before pins were stored per model carry the
// pin only on the selection — seed the store from it so the first model
// switch doesn't silently drop it.
{
  const restored = uiState.vprRouteSelection;
  if (restored.mode === 'pinned-peer' && restored.peerId && restored.model) {
    uiState.vprModelPins = setVprModelPin(
      uiState.vprModelPins,
      restored.model.provider,
      restored.model.serviceId,
      restored.peerId,
    );
    saveVprModelPins(uiState.vprModelPins);
  }
}
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

let lastQueuedBuyerRoutingPreferences = '';
let buyerRoutingPreferencesSyncVersion = 0;
function syncBuyerRoutingPreferences(): void {
  if (!bridge?.updateConfig) return;
  const routingPreferences = buyerModelRoutingPreferences(uiState.vprRoutingPreferences);
  const serialized = JSON.stringify(routingPreferences);
  if (serialized === lastQueuedBuyerRoutingPreferences) return;
  lastQueuedBuyerRoutingPreferences = serialized;
  const version = ++buyerRoutingPreferencesSyncVersion;
  void updateDashboardConfig({ buyer: { routingPreferences } }).then((result) => {
    if (result.ok || version !== buyerRoutingPreferencesSyncVersion) return;
    lastQueuedBuyerRoutingPreferences = '';
    appendSystemLog(`Buyer routing preferences were not saved: ${result.error ?? 'unknown error'}`);
  });
}
syncBuyerRoutingPreferences();

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

const reminderApi = initReminderModule({ bridge, uiState });

// Credits API is created after chat, so use late-bound reference.
let creditsApi: ReturnType<typeof initCreditsModule>;

const chatApi = initChatModule({
  bridge,
  uiState,
  appendSystemLog,
  onPaymentCardShown: () => creditsApi?.notifyPaymentCardVisible(),
  onResponseCompleted: reminderApi.onResponseCompleted,
});

initAppSetupModule({ uiState, bridge: bridge ?? null });

creditsApi = initCreditsModule({
  bridge: bridge as DesktopBridge,
  uiState,
  onBalanceSufficientForPayment: () => chatApi.retryAfterPayment(),
  onPaymentStateChanged: reminderApi.reconcilePayer,
});
creditsApi.startPeriodicRefresh();

// A browser pay page finished (deposit/withdraw/claim/channel close) —
// refresh balances and the payment summary right away, bypassing throttles.
bridge?.onPaymentsCompleted?.(() => {
  void creditsApi.refreshCredits();
  void creditsApi.refreshPaymentSummary(true);
});

/**
 * The seller a model should route to when it is selected without an explicit
 * peer: its remembered pin, as long as that seller is still serving the model
 * and still passes the peer rules. Anything else means auto.
 */
function rememberedPinFor(provider: string, serviceId: string): string | null {
  const peerId = vprModelPinFor(uiState.vprModelPins, provider, serviceId);
  if (!peerId || !isPeerRoutable(peerId, uiState.vprRoutingPreferences)) return null;
  const serves = routesForSelectedModel(uiState.vprRoutableRows, { provider, serviceId })
    .some((route) => route.peerId === peerId);
  return serves ? peerId : null;
}

function actionSelectVprModel(provider: string, serviceId: string, peerId: string | null = null): void {
  const entry = findCatalogEntry(uiState.vprModelCatalog, provider, serviceId);
  if (!entry) return;
  // Image models are internal-chat tools, not AI VPN defaults. Restore a
  // remembered explicit seller pin when the model page hands the model to
  // chat; clearing Auto removes that remembered pin first.
  if (entry.kind === 'image') {
    const pinnedPeerId = peerId ?? rememberedPinFor(entry.provider, entry.serviceId);
    const selection = createVprRouteSelection(entry, pinnedPeerId);
    uiState.chatImageRouteSelection = selection;
    if (selection.peerId) {
      uiState.vprModelPins = setVprModelPin(
        uiState.vprModelPins,
        entry.provider,
        entry.serviceId,
        selection.peerId,
      );
      saveVprModelPins(uiState.vprModelPins);
    }
    notifyUiStateChanged();
    return;
  }
  uiState.chatImageRouteSelection = null;
  // A bare model switch restores that model's own pin instead of dropping to
  // auto — pinning one model then browsing others must not unpin it. Only
  // clearVprPinnedPeer (the "Auto select seller" toggle) forgets a pin.
  const pinnedPeerId = peerId ?? rememberedPinFor(entry.provider, entry.serviceId);
  if (pinnedPeerId) {
    uiState.vprModelPins = setVprModelPin(uiState.vprModelPins, entry.provider, entry.serviceId, pinnedPeerId);
    saveVprModelPins(uiState.vprModelPins);
  }
  const selection = createVprRouteSelection(entry, pinnedPeerId);
  // Auto mode resolves the peer through the routing-preferences scorer, not
  // whichever chat option happens to sort first.
  const option = entry.kind === 'text'
    ? resolveVprChatOption(
        uiState.chatServiceOptions,
        uiState.vprRoutableRows,
        selection,
        uiState.vprRoutingPreferences,
      )
    : null;
  if (option) {
    chatApi.handleServiceChange(
      option.value,
      pinnedPeerId ?? option.peerId,
      false,
      selection.mode === 'auto' ? 'auto' : 'pinned',
    );
  }
  // The text route is persisted and propagated to connected apps after the
  // corresponding chat option has been resolved above.
  uiState.vprRouteSelection = selection;
  // An explicit pick ends the provisional-default window even when no chat
  // option resolved above (handleServiceChange, which also ends it, only runs
  // when one did) and even when the pick is the provisional model itself —
  // otherwise the next refresh would keep re-picking over the user's choice.
  chatApi.endProvisionalDefaultModel();
  saveVprRouteSelection(selection);
  notifyUiStateChanged();
  // The floating pill mirrors the selection — push it now instead of
  // letting it lag behind on its poll tick.
  void vprFloatApi?.refresh();
  // Keep connected app profiles in step with the new route: the system
  // proxy captured its default model and served-models list at connect
  // time, and the buyer is now pinned to the new model's peer — stale
  // profiles would forward models that peer doesn't serve.
  void applyVprRouteToConnectedProxy(bridge, uiState);
  // An explicit seller choice re-points the model's existing auto-routed
  // chats too; a bare model switch (remembered-pin restore) moves nothing.
  if (peerId) sweepChatsForSellerPin(entry.provider, entry.serviceId, peerId);
}

const vprFloatApi = initVprFloatModule({
  bridge,
  uiState,
  onSelectModel: (provider, serviceId) => actionSelectVprModel(provider, serviceId),
  refreshUsage: (force?: boolean) => creditsApi.refreshPaymentSummary(force),
});

/** Deliberate seller pin for a model: re-point that model's auto-affine chats
    to the chosen seller (chats whose seller the user picked stay put), then
    refresh the surfaces that show chat routes. */
function sweepChatsForSellerPin(provider: string, serviceId: string, peerId: string): void {
  void sweepAutoChatsToSeller(bridge, uiState.vprRoutableRows, { provider, serviceId }, peerId)
    .then((changed) => {
      if (!changed) return;
      void buyerConversationsResource.refresh();
      void vprFloatApi.refresh();
    });
}

// Keep the main process fed with the curated model list (favorites +
// recommended) so the Telegram /model picker matches the app's dropdown.
initModelPickerSync({ bridge, uiState });

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
  const buyerConnected = isModeRunning('connect', processes);
  setRuntimeSteadyActivity(
    buyerConnected ? 'active' : 'idle',
    buyerConnected
      ? 'Ready'
      : 'Buyer runtime offline. Waiting for local runtime start...',
  );
}

function syncBuyerRuntimeOverview(processes = uiState.processes): void {
  const buyerConnected = isModeRunning('connect', processes);
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

  if (mode === 'connect') {
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

  // Run proxy + service check independently so it isn't blocked by slow dashboard HTTP calls.
  void chatApi.refreshChatProxyStatus();

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

async function ensureConnectRuntimeStarted(): Promise<void> {
  if (!bridge?.start || isModeRunning('connect')) return;
  // Don't start until plugin setup is resolved — starting without the router
  // plugin causes the CLI to exit immediately with "plugin not found".
  if (uiState.appSetupStatusKnown && uiState.appSetupNeeded && !uiState.appSetupComplete) return;

  try {
    setRuntimeActivity('warn', 'Starting buyer runtime...', 8_000);
    await bridge.start({
      mode: 'connect',
      router: normalizeRouterRuntime(uiState.connectRouterValue),
    });
    appendSystemLog(UI_MESSAGES.buyerAutoStarted);
    setRuntimeActivity('active', 'Buyer runtime auto-started.', 4_000);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.toLowerCase().includes('already running')) return;
    appendSystemLog(`Buyer auto-start failed: ${message}`);
    setRuntimeActivity('bad', `Buyer auto-start failed: ${message}`, 10_000);
  }
}

async function actionStartConnect(): Promise<void> {
  const start = requireBridgeMethod('start', 'Runtime start is unavailable in this build');
  clearRouterPluginHint();
  uiState.connectBadge = { tone: 'idle', label: 'Starting...' };
  notifyUiStateChanged();
  setRuntimeActivity('warn', 'Starting buyer runtime...', 8_000);
  try {
    await start({
      mode: 'connect',
      router: normalizeRouterRuntime(uiState.connectRouterValue),
    });
    await refreshAll('manual');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendSystemLog(`Action failed: ${message}`);
    setRuntimeActivity('bad', `Action failed: ${message}`, 8_000);
  }
}

async function actionStopConnect(): Promise<void> {
  const stop = requireBridgeMethod('stop', 'Runtime stop is unavailable in this build');
  uiState.connectBadge = { tone: 'idle', label: 'Stopping...' };
  notifyUiStateChanged();
  setRuntimeActivity('warn', 'Stopping buyer runtime...', 8_000);
  try {
    // Stopping the buyer is an offline state, not a disconnect: connected
    // apps keep their configs and rows and pick the buyer back up when it
    // returns. App configs are only removed when the user disconnects the
    // app itself (issue #1016).
    await stop('connect');
    await refreshAll('manual');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    appendSystemLog(`Action failed: ${message}`);
    setRuntimeActivity('bad', `Action failed: ${message}`, 8_000);
  }
}

async function actionRestartConnect(): Promise<void> {
  try {
    await actionStopConnect();
  } catch { /* may not be running */ }
  await actionStartConnect();
}

async function actionStartAll(): Promise<void> {
  if (isModeRunning('connect')) return;
  await actionStartConnect();
}

async function actionStopAll(): Promise<void> {
  if (!isModeRunning('connect')) return;
  await actionStopConnect();
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
  startConnect: () => { recordUserAction('runtime_start', 'connection'); return actionStartConnect(); },
  stopConnect: () => { recordUserAction('runtime_stop', 'connection'); return actionStopConnect(); },
  restartConnect: actionRestartConnect,
  startAll: () => { recordUserAction('runtime_start', 'home'); return actionStartAll(); },
  stopAll: () => { recordUserAction('runtime_stop', 'home'); return actionStopAll(); },
  refreshAll: () => { recordUserAction('discovery_refresh', 'unknown'); return refreshAll('manual'); },
  clearLogs: actionClearLogs,
  scanDht: () => { recordUserAction('discovery_refresh', 'peers'); return actionScanDht(); },
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
  handleServiceChange: (value, peerId) => {
    chatApi.handleServiceChange(value, peerId);
  },
  handleServiceFocus: () => { recordUserAction('model_picker_open', 'chat'); chatApi.handleServiceFocus(); },
  handleServiceBlur: chatApi.handleServiceBlur,
  clearPinnedPeer: () => { recordUserAction('route_mode_change', 'chat'); chatApi.clearPinnedPeer(); },
  selectVprModel: (provider, serviceId, peerId) => {
    actionSelectVprModel(provider, serviceId, peerId);
  },
  clearVprPinnedPeer: () => {
    recordUserAction('route_mode_change', 'model');
    // Forgetting the pin has to reach the per-model store too, or selecting
    // the model again would restore the pin the user just cleared.
    const model = uiState.vprRouteSelection.model;
    if (model) {
      uiState.vprModelPins = clearVprModelPin(uiState.vprModelPins, model.provider, model.serviceId);
      saveVprModelPins(uiState.vprModelPins);
    }
    uiState.vprRouteSelection = { ...uiState.vprRouteSelection, mode: 'auto', peerId: null };
    saveVprRouteSelection(uiState.vprRouteSelection);
    notifyUiStateChanged();
  },
  setVprModelSellerPin: (provider, serviceId, peerId) => {
    recordUserAction('route_mode_change', 'model');
    uiState.vprModelPins = peerId
      ? setVprModelPin(uiState.vprModelPins, provider, serviceId, peerId)
      : clearVprModelPin(uiState.vprModelPins, provider, serviceId);
    saveVprModelPins(uiState.vprModelPins);
    // Pinning re-points the model's auto-affine chats; clearing moves
    // nothing — chats keep their current peer as affinity.
    if (peerId) sweepChatsForSellerPin(provider, serviceId, peerId);
    notifyUiStateChanged();
  },
  updateVprRoutingPreferences: (patch) => {
    recordUserActionCoalesced('routing_preferences_change', 'preferences');
    uiState.vprRoutingPreferences = { ...uiState.vprRoutingPreferences, ...patch };
    saveVprRoutingPreferences(uiState.vprRoutingPreferences);
    syncBuyerRoutingPreferences();
    // Peer rules gate which sellers and models are visible at all, so a patch
    // touching them has to re-derive the catalog, not just repaint.
    if (patch.allowedPeerIds || patch.blockedPeerIds) {
      chatApi.applyPeerAccessRules();
    }
    notifyUiStateChanged();
  },
  setVprPeerListing: (peerId, listing) => {
    recordUserAction('peer_access_change', 'peers');
    uiState.vprRoutingPreferences = applyPeerListing(uiState.vprRoutingPreferences, peerId, listing);
    saveVprRoutingPreferences(uiState.vprRoutingPreferences);
    syncBuyerRoutingPreferences();
    chatApi.applyPeerAccessRules();

    // A pin the new lists rule out would keep routing to a peer the user just
    // blocked (the pinned path bypasses scoring), so drop it back to auto —
    // for every model that remembers this peer, not only the active one.
    uiState.vprModelPins = filterVprModelPins(
      uiState.vprModelPins,
      (pinnedPeerId) => isPeerRoutable(pinnedPeerId, uiState.vprRoutingPreferences),
    );
    saveVprModelPins(uiState.vprModelPins);
    const pinned = uiState.vprRouteSelection.peerId;
    if (
      uiState.vprRouteSelection.mode === 'pinned-peer'
      && pinned
      && !isPeerRoutable(pinned, uiState.vprRoutingPreferences)
    ) {
      uiState.vprRouteSelection = { ...uiState.vprRouteSelection, mode: 'auto', peerId: null };
      saveVprRouteSelection(uiState.vprRouteSelection);
    }

    notifyUiStateChanged();
    void applyVprRouteToConnectedProxy(bridge, uiState);
  },
  setChatPermissionMode: (mode) => { recordUserAction('chat_permission_change', 'chat'); chatApi.setChatPermissionMode(mode); },
  decideToolApproval: (decision, id) => { recordUserAction('tool_approval_decision', 'chat'); chatApi.decideToolApproval(decision, id); },
  acceptReminderHome: reminderApi.acceptHome,
  dismissReminderHome: reminderApi.dismissHome,
  rejectPaymentSession: () => {
    uiState.chatPaymentApprovalVisible = false;
    uiState.chatPaymentApprovalPeerName = null;
    uiState.chatPaymentApprovalPeerInfo = null;
    uiState.chatPaymentApprovalLoading = false;
    uiState.chatPaymentApprovalError = null;
    notifyUiStateChanged();
  },
  retryAfterPayment: () => { recordUserAction('chat_retry', 'chat'); chatApi.retryAfterPayment(); },
  refreshCredits: () => creditsApi.refreshCredits(),
  refreshPaymentSummary: (force?: boolean) => creditsApi.refreshPaymentSummary(force),
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
  openVprFloat: (profileName?: string) => {
    recordUserAction('floating_window_open', 'floating_window');
    return vprFloatApi.openFloat(profileName);
  },
  closeVprFloat: () => {
    recordUserAction('floating_window_close', 'floating_window');
    return vprFloatApi.closeFloat();
  },
  setVprFloatAutoOpen: (enabled: boolean) => {
    uiState.vprFloatAutoOpen = enabled;
    saveFloatAutoOpen(enabled);
    vprFloatApi.setAutoOpen(enabled);
    notifyUiStateChanged();
  },
  setVprFloatShowRoutedPeer: (enabled: boolean) => {
    uiState.vprFloatShowRoutedPeer = enabled;
    saveFloatShowRoutedPeer(enabled);
    // The pill reads the flag from its data payload — push it right away so
    // an open pill reflects the toggle without waiting out the poll tick.
    void vprFloatApi.refresh();
    notifyUiStateChanged();
  },
});

bridge?.onDesktopOpenFloatingWindow?.(() => { void vprFloatApi.openFloat(); });
bridge?.onDesktopConnectMain?.(() => { void actionStartAll(); });
bridge?.onDesktopDisconnectMain?.(() => { void actionStopAll(); });

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
  refreshChatProxyStatus: chatApi.refreshChatProxyStatus,
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
    if (event.mode === 'connect') {
      chatApi.handleLogLineForThinkingPhase(event.line);
    }
    renderPluginSetupState();
    if (!hasStructuredRuntimeActivity) {
      updateRuntimeActivityFromLog(event.mode, event.line);
    }
  });

  bridge.onPeersChanged?.(() => {
    void chatApi.refreshChatServiceOptions();
  });

  bridge.onState?.((processes) => {
    renderProcesses(processes);
    syncBuyerRuntimeOverview(processes);
    syncRuntimeActivityFromProcesses(processes);

    if (isModeRunning('connect', processes)) {
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
