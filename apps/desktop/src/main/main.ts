import {
  app,
  autoUpdater as nativeAutoUpdater,
  BrowserWindow,
  ipcMain,
  dialog,
} from 'electron';
import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;
import {
  ProcessManager,
  type RuntimeMode,
  type RuntimeProcessState,
  type StartOptions,
} from './runtime/process-manager.js';
import { registerPiChatHandlers } from './chat/engine.js';
import { setClaudeDesktopGatewayModelSource } from './connected-apps/claude-desktop-gateway.js';
import { emitChatEvent } from './chat/event-bus.js';
import { createTelegramBridge } from './telegram/bridge.js';
import { ensureSecureIdentity, getSecureIdentity, hasStoredIdentity, secureIdentityEnv } from './identity.js';
import type { LogEvent, RuntimeActivityEvent } from './runtime/log-parser.js';
import { parseRuntimeActivityFromLog } from './runtime/log-parser.js';
import {
  setPluginAppendLog,
  ensureDefaultPlugin,
} from './runtime/plugins.js';
import {
  onPeersChanged,
} from './runtime/peer-cache.js';
import {
  createWindow,
  createApplicationMenu,
  getMainWindow,
} from './ui/window.js';
import { createDesktopTray } from './ui/tray.js';
import { ensureConfig } from './runtime/config-io.js';
import { registerAttachmentScheme, installAttachmentProtocol } from './chat/attachments/protocol.js';
import { disableSandboxIfAppImageCannotSandbox } from './linux-sandbox.js';
import {
  APP_ICON_PATH,
  APP_NAME,
  INTERNAL_APP_NAME,
  TRAY_ICON_PATH,
  errorDetails,
  errorMessage,
  getAppSetupStatus,
  getMacUpdateInstallHint,
  isDesktopDebugEnabled,
  isDev,
  rendererUrl,
  setAppSetupStatus,
  type InstallUpdateResult,
  type UpdateStatus,
} from './app-context.js';
import {
  buildSystemProxyTrayMenu,
  clearSystemProxySettings,
  clearSystemProxyTransportSettings,
  getActiveSystemProxyState,
  initSystemProxyRuntime,
  loadPersistedSystemProxyState,
  refreshTrayMenu,
  restoreSystemProxyProfilesAtLaunch,
  startSystemProxyWatchdog,
  stopManagedRuntimes,
} from './system-proxy/runtime.js';
import { LOCALHOST_URL } from './constants.js';
import { registerAppIpc } from './ipc/app.js';
import { registerDesktopIpc } from './ipc/desktop.js';
import { registerFloatIpc } from './ipc/float.js';
import { registerStakingIpc } from './ipc/staking.js';
import { stakingSessions } from './staking/portal.js';
import { registerPaymentsIpc } from './ipc/payments.js';
import { registerRuntimeIpc } from './ipc/runtime.js';
import { registerSystemProxyIpc } from './ipc/system-proxy.js';
import { registerTelegramIpc } from './ipc/telegram.js';
import { registerPublicTunnelIpc } from './ipc/public-tunnel.js';
import {
  effectiveLaunchTarget,
} from './connected-apps/profile-targets.js';
import {
  stopPaymentsPortal,
} from './payments/portal.js';
import { ACTIVE_CONFIG_PATH } from './runtime/active-config.js';
import {
  restoreOsSystemProxySync,
} from './system-proxy/os-settings.js';
import {
  DEFAULT_SYSTEM_PROXY_PORT,
} from './system-proxy/profiles.js';
import { resolveBuyerProxyPort } from './runtime/active-config.js';
import { createTelemetryService } from './telemetry/telemetry.js';
import { setTelemetryService } from './telemetry/runtime.js';
import { firstChatDepositSnapshot } from './telemetry/events.js';
import { refreshCreditsInfo } from './payments/credits.js';

// Re-export types that may be used by other main-process modules
export type { LogEvent, RuntimeActivityEvent } from './runtime/log-parser.js';
export type { DashboardNetworkPeer, DashboardNetworkStats, DashboardNetworkResult } from './runtime/peer-cache.js';
export type { InstalledPlugin } from './runtime/plugins.js';

// Internal runtime name — NEVER change this value. On macOS the safeStorage
// encryption key lives in the "<app.setName value> Safe Storage" keychain
// entry, and the default userData path derives from it too. Renaming it
// rotates the key and orphans every existing identity.enc. User-visible
// surfaces use APP_NAME below instead.

let isQuitting = false;
let isInstallingUpdate = false;

let telemetryReady = Promise.resolve<Awaited<ReturnType<typeof createTelemetryService>> | null>(null);

function initializeTelemetry(hadExistingIdentity: boolean): Promise<Awaited<ReturnType<typeof createTelemetryService>> | null> {
  return createTelemetryService({
    userDataDir: app.getPath('userData'),
    isDev,
    appVersion: app.getVersion(),
    platform: process.platform,
    arch: process.arch,
    getDistinctId: () => getSecureIdentity()?.wallet.address ?? null,
    hadExistingIdentity,
  }).then(async (service) => {
    setTelemetryService(service);
    await service.recordAppStarted();
    return service;
  }).catch(() => null);
}

async function recordTelemetryCleanShutdown(): Promise<void> {
  const telemetry = await telemetryReady;
  await telemetry?.recordCleanShutdown();
}

// The `antseed-attachment://` scheme must be registered as privileged
// *before* `app.whenReady()` fires. The actual request handler is wired
// inside whenReady() once Electron's protocol module is usable.
registerAttachmentScheme();

disableSandboxIfAppImageCannotSandbox();

const logBuffer: LogEvent[] = [];
let lastRuntimeActivityHash = '';

/**
 * Kill any leftover process still listening on the buyer proxy port after the
 * desktop's own runtime child was stopped. The CLI reuses a compatible
 * listener instead of failing on EADDRINUSE, so an orphaned runtime from an
 * earlier session can keep the proxy alive — chats keep working and the UI
 * reads as connected even though Stop was pressed. Only processes from our
 * own runtime family (node/antseed/electron) are reaped.
 */
async function killOrphanBuyerProxy(): Promise<void> {
  if (process.platform === 'win32') return;
  try {
    const port = await resolveBuyerProxyPort();
    const out = execFileSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    const pids = out
      .split(/\s+/)
      .map((raw) => Number(raw))
      .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
    for (const pid of pids) {
      let command = '';
      try {
        command = execFileSync('ps', ['-o', 'comm=', '-p', String(pid)], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
      } catch {
        continue; // Already gone.
      }
      if (!/node|antseed|electron/i.test(command)) continue;
      try {
        process.kill(pid, 'SIGTERM');
      } catch {
        // Already gone.
      }
    }
  } catch {
    // lsof unavailable or nothing listening — nothing to reap.
  }
}

async function requestBuyerPeerRefresh(): Promise<void> {
  const port = await resolveBuyerProxyPort();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 60_000);

  try {
    const response = await fetch(`${LOCALHOST_URL}:${port}/_antseed/peers/refresh`, {
      method: 'POST',
      signal: controller.signal,
    });
    const text = await response.text();
    let payload: Record<string, unknown> = {};
    try {
      payload = text ? JSON.parse(text) as Record<string, unknown> : {};
    } catch {
      payload = {};
    }

    if (!response.ok || payload['ok'] !== true) {
      const error = typeof payload['error'] === 'string' && payload['error'].trim().length > 0
        ? payload['error']
        : `Buyer proxy returned HTTP ${response.status}`;
      throw new Error(error);
    }
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw new Error(`Timed out refreshing peers via buyer proxy on port ${port}`);
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Unable to refresh peers via buyer proxy on port ${port}: ${message}`);
  } finally {
    clearTimeout(timer);
  }
}

// ── Runtime Activity & Log Wiring ──

function emitRuntimeActivity(activity: RuntimeActivityEvent): void {
  const hash = [
    activity.mode,
    activity.stage,
    activity.tone,
    activity.message,
    activity.requestId ?? '',
    activity.peerId ?? '',
  ].join('|');

  if (hash === lastRuntimeActivityHash) {
    return;
  }
  lastRuntimeActivityHash = hash;
  getMainWindow()?.webContents.send('runtime:activity', activity);
}

function emitRuntimeState(): void {
  getMainWindow()?.webContents.send('runtime:state', getCombinedProcessState());
  refreshTrayMenu();
}

function appendLog(mode: RuntimeMode, stream: 'stdout' | 'stderr' | 'system', line: string): void {
  const event: LogEvent = { mode, stream, line, timestamp: Date.now() };
  logBuffer.push(event);
  if (logBuffer.length > 1200) {
    logBuffer.splice(0, logBuffer.length - 1200);
  }

  getMainWindow()?.webContents.send('runtime:log', event);
  const activity = parseRuntimeActivityFromLog(event);
  if (activity) {
    emitRuntimeActivity(activity);
  }
  emitRuntimeState();
  if (mode === 'system-proxy' && stream === 'system' && /^Process exited|^Started system-proxy/.test(line)) {
    refreshTrayMenu();
  }
}

// Wire up callbacks for extracted modules
setPluginAppendLog(appendLog);

// When the peer set changes, tell the renderer to refresh the service catalog.
onPeersChanged(() => {
  getMainWindow()?.webContents.send('peers:changed');
  refreshTrayMenu();
});
const processManager = new ProcessManager((mode, stream, line) => {
  appendLog(mode, stream, line);
});

initSystemProxyRuntime({
  appName: APP_NAME,
  appendLog,
  processManager,
  effectiveLaunchTarget: (profileName) => effectiveLaunchTarget(profileName),
});

// ── Payments Portal ──

async function stopDesktopServices(): Promise<void> {
  await Promise.all([telegramBridge.stop(), stopManagedRuntimes(), stopPaymentsPortal(), stakingSessions.stop()]);
}

function getCombinedProcessState(): RuntimeProcessState[] {
  return processManager.getState();
}

// ── IPC handlers ──
// Each group lives in ipc/<domain>.ts; anything they need from this file is
// passed in rather than reached for.
registerPaymentsIpc();
registerStakingIpc();
registerDesktopIpc();
registerAppIpc();
registerFloatIpc();
registerSystemProxyIpc({ processManager });
const publicTunnelRuntime = registerPublicTunnelIpc({ processManager });
registerRuntimeIpc({
  processManager,
  logBuffer,
  appendLog,
  getCombinedProcessState,
  killOrphanBuyerProxy,
  requestBuyerPeerRefresh,
});

// Allowlisted top-level keys that the renderer is permitted to update via IPC.
// Any key not in this set is stripped before the request is forwarded to the
// dashboard API, preventing a compromised renderer from overwriting arbitrary
// config fields.

// ── Credits / Deposits Balance ──

// ── Incoming USDC watcher + P2P relay sweep ──
//
// The buyer daemon owns the hot-wallet watcher: it polls the USDC balance,
// treats any increase as an incoming deposit (QR transfer or Coinbase Onramp
// delivery), signs an EIP-3009 authorization addressed to the
// AntseedDepositRelay contract, and offers it to connected peers; a
// permissionless relayer submits it on-chain and earns the contract's fixed
// USDC fee (docs/protocol/spec/09-deposit-sweep.md). The hot wallet never
// needs ETH. While the in-app deposit panel is open, the renderer promotes
// the daemon's watcher to a fast cadence and mirrors its progress events
// (payments/deposit-sweep.ts).

// ── AI Chat IPC Handlers ──
const piChatEngine = registerPiChatHandlers({
  ipcMain,
  sendToRenderer: (channel, payload) => {
    getMainWindow()?.webContents.send(channel, payload);
    // Tee every chat event into the bus so the Telegram bridge can follow
    // stream deltas, completions, and tool-approval requests.
    emitChatEvent(channel, payload);
  },
  configPath: ACTIVE_CONFIG_PATH,
  isBuyerRuntimeRunning: () => getCombinedProcessState().some((state) => state.mode === "connect" && state.running),
  ensureBuyerRuntimeStarted: async () => {
    const connectState = getCombinedProcessState().find((state) => state.mode === 'connect');
    if (connectState?.running) {
      return true;
    }

    await ensureSecureIdentity();

    const startOptions: StartOptions = {
      mode: 'connect',
      router: 'local',
      ...(isDesktopDebugEnabled() ? { verbose: true } : {}),
      env: {
        ...(isDesktopDebugEnabled() ? { ANTSEED_DEBUG: '1' } : {}),
        ...secureIdentityEnv(),
      },
    };

    try {
      await processManager.start(startOptions);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.toLowerCase().includes('already running')) {
        return true;
      }
      appendLog('connect', 'system', `Chat-triggered buyer runtime start failed: ${message}`);
      return false;
    }
  },
  appendSystemLog: (line) => {
    appendLog("connect", "system", line);
  },
  recordFirstChatStarted: async (input) => {
    const telemetry = await telemetryReady;
    await telemetry?.recordFirstChatStarted(input, async () => {
      const credits = await refreshCreditsInfo();
      return firstChatDepositSnapshot(credits.balanceUsdc);
    });
  },
  recordFirstModelShown: async (input) => {
    const telemetry = await telemetryReady;
    await telemetry?.recordFirstModelShown(input);
  },
  recordModelSelected: async (input, selectionKey) => {
    const telemetry = await telemetryReady;
    await telemetry?.recordModelSelected(input, selectionKey);
  },
  recordChatRequestStarted: async (input) => {
    const telemetry = await telemetryReady;
    await telemetry?.recordChatRequestStarted(input);
  },
  recordChatRequestFinished: async (input) => {
    const telemetry = await telemetryReady;
    await telemetry?.recordChatRequestFinished(input);
  },
  recordDiscoveryFailed: async (input) => {
    const telemetry = await telemetryReady;
    await telemetry?.recordDiscoveryFailed(input);
  },
});

// The Claude Desktop gateway advertises the same curated picker rows the
// in-app dropdown (and Telegram bridge) offer, behind Claude's model ids.
setClaudeDesktopGatewayModelSource(() => (
  (piChatEngine.getModelPicker()?.models ?? []).map((model) => ({
    label: model.label,
    model: model.serviceId,
  }))
));

// ── Telegram bridge ──
const telegramBridge = createTelegramBridge({
  engine: piChatEngine,
  appendLog: (line) => { appendLog('connect', 'system', line); },
  onStatusChanged: (status) => {
    getMainWindow()?.webContents.send('telegram:status-changed', status);
  },
});

registerTelegramIpc({ telegramBridge });

/* ------------------------------------------------------------------ */
/*  Floating always-on-top pill window                                  */
/* ------------------------------------------------------------------ */

// Cache the latest display payload so a freshly opened float window can be
// primed before the main window's next periodic update.

app.whenReady().then(async () => {
  installAttachmentProtocol();
  app.setName(INTERNAL_APP_NAME);
  app.setAboutPanelOptions({
    applicationName: APP_NAME,
    applicationVersion: app.getVersion(),
    version: app.getVersion(),
    iconPath: APP_ICON_PATH,
  });
  if (process.platform === 'darwin' && APP_ICON_PATH && app.dock) {
    app.dock.setIcon(APP_ICON_PATH);
  }
  const hadExistingIdentity = hasStoredIdentity();
  await ensureSecureIdentity();
  telemetryReady = initializeTelemetry(hadExistingIdentity);
  await telemetryReady;
  createApplicationMenu(APP_NAME, APP_ICON_PATH);

  // Ensure config.json exists before anything else (first launch).
  // Must complete before creating the window — the renderer auto-starts the
  // buyer runtime which needs config.json to find the router plugin.
  await ensureConfig(ACTIVE_CONFIG_PATH).catch(() => {});
  loadPersistedSystemProxyState();

  const showMainWindow = () => {
    const existingWindow = getMainWindow();
    if (existingWindow) {
      existingWindow.show();
      existingWindow.focus();
      return;
    }
    createWindow({ appName: APP_NAME, appIconPath: APP_ICON_PATH, isDev, rendererUrl });
    // Windows only, and the reason this is here rather than on `app`:
    // 'before-quit' is NOT emitted when the app goes down with an OS shutdown,
    // restart or logout, so this is the last chance to hand the proxy setting
    // back — and there is only time for the synchronous restore. Without it
    // the machine reboots into a system proxy pointing at nothing.
    getMainWindow()?.on('session-end', () => {
      restoreOsSystemProxySync();
    });
  };

  showMainWindow();

  void publicTunnelRuntime.restoreAtLaunch().then((result) => {
    if (result && !result.ok) {
      appendLog('tunnel', 'system', `Public tunnel auto-start failed: ${result.error ?? 'Unknown error'}`);
    }
  }).catch((err) => {
    appendLog('tunnel', 'system', `Public tunnel auto-start failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Fail open before anything else. Whatever the OS proxy is set to right now
  // was left behind by the previous run — and if that run ended in a crash,
  // a force-quit or an OS shutdown, it still points at a proxy that is not
  // running, which is the whole machine offline. Restore it unconditionally
  // and let the reconnect below re-arm it only once a proxy really listens.
  // Fire-and-forget so clean launches don't block window creation on
  // networksetup/reg calls; only the state files differ between the two cases
  // (persisted state is the reconnect memory and must survive).
  const systemProxyFailOpen = (getActiveSystemProxyState()
    ? clearSystemProxyTransportSettings()
    : clearSystemProxySettings()
  ).catch((err) => {
    appendLog('system-proxy', 'system', `System Proxy cleanup failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  startSystemProxyWatchdog();

  const showFloatingWindow = () => {
    const win = getMainWindow();
    if (win) {
      win.webContents.send('desktop:open-floating-window');
      return;
    }
    showMainWindow();
    getMainWindow()?.webContents.once('did-finish-load', () => {
      getMainWindow()?.webContents.send('desktop:open-floating-window');
    });
  };

  const toggleMainConnection = () => {
    const running = getCombinedProcessState().some((state) => state.mode === 'connect' && state.running);
    getMainWindow()?.webContents.send(running ? 'desktop:disconnect-main' : 'desktop:connect-main');
  };

  createDesktopTray({
    appName: APP_NAME,
    iconPath: TRAY_ICON_PATH,
    onShow: showMainWindow,
    buildMenu: () => buildSystemProxyTrayMenu(showMainWindow, showFloatingWindow, toggleMainConnection),
  });
  refreshTrayMenu();

  const restoredState = getActiveSystemProxyState();
  const restoredProfiles = Array.isArray(restoredState?.['activeProfileNames'])
    ? restoredState['activeProfileNames'].filter((name: unknown): name is string => typeof name === 'string')
    : [];
  if (restoredProfiles.length > 0 && typeof restoredState?.['peerId'] === 'string') {
    const restorePeerId = restoredState['peerId'];
    const restoreDefaultModel = typeof restoredState['defaultModel'] === 'string'
      ? restoredState['defaultModel'] as string
      : undefined;
    // Sequenced after the fail-open above, or the clear could land after the
    // child has already re-armed the setting and silently disconnect it.
    void systemProxyFailOpen.then(() => restoreSystemProxyProfilesAtLaunch({
      peerId: restorePeerId,
      port: DEFAULT_SYSTEM_PROXY_PORT,
      profiles: restoredProfiles,
      defaultModel: restoreDefaultModel,
      servedModels: [],
      profileSwitch: true,
    })).catch((err) => {
      appendLog('system-proxy', 'system', `System Proxy auto-start failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  // Resume the Telegram bridge if a bot was connected in a previous session.
  // Needs app-ready because the token store decrypts via safeStorage.
  void telegramBridge.start().catch((err) => {
    appendLog('connect', 'system', `[telegram] Bridge resume failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Payments portal starts lazily on first open (via payments:open-portal IPC)

  void ensureDefaultPlugin('@antseed/router-local', {
    getAppSetupNeeded: () => getAppSetupStatus().needed,
    setAppSetupNeeded: (v) => { setAppSetupStatus({ needed: v }); },
    getAppSetupComplete: () => getAppSetupStatus().complete,
    setAppSetupComplete: (v) => { setAppSetupStatus({ complete: v }); },
    onAppSetupStarted: () => { void telemetryReady.then((telemetry) => telemetry?.recordSetupStarted()); },
    onAppSetupCompleted: () => { void telemetryReady.then((telemetry) => telemetry?.recordSetupCompleted()); },
    getMainWindow,
    appendLog,
  }).catch(() => {
    // Failure is already logged via appendLog inside ensureDefaultPlugin.
  });

  // Auto-update: check for updates silently on launch and every 30 minutes.
  // If an in-flight download stops emitting progress events for a couple of
  // minutes (network drop, stuck CDN connection, etc.) we re-trigger the
  // update check so electron-updater resumes/restarts the download instead
  // of sitting idle forever.
  // Downloads are opt-in: detection only surfaces an "Update available"
  // banner, and the (hundreds of MB) download starts when the user clicks it.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  const UPDATE_CHECK_INTERVAL_MS = 30 * 60 * 1000;
  const DOWNLOAD_STALL_TIMEOUT_MS = 2 * 60 * 1000;
  const DOWNLOAD_STALL_POLL_MS = 30 * 1000;

  let updateCheckInterval: ReturnType<typeof setInterval> | null = null;
  let downloadStallInterval: ReturnType<typeof setInterval> | null = null;
  let lastDownloadProgressAt: number | null = null;
  let lastDownloadPercent = 0;
  let updateVersion: string | null = null;

  // Kept for replay: the renderer can mount after update-downloaded fired
  // (window reopened, dev reload), and electron-updater never re-emits it.
  let lastUpdateStatus: UpdateStatus | null = null;

  const sendUpdateStatus = (status: UpdateStatus) => {
    lastUpdateStatus = status;
    getMainWindow()?.webContents.send('app:update-status', status);
  };

  ipcMain.handle('app:get-update-status', () => lastUpdateStatus);

  const clearStallWatchdog = () => {
    if (downloadStallInterval) {
      clearInterval(downloadStallInterval);
      downloadStallInterval = null;
    }
    lastDownloadProgressAt = null;
    lastDownloadPercent = 0;
  };

  const reportUpdateError = (error: unknown, context: string): InstallUpdateResult => {
    const message = errorMessage(error);
    const details = errorDetails(error);
    const hint = getMacUpdateInstallHint();
    console.error(`[auto-update] ${context}:`, details);
    appendLog('connect', 'system', `Auto-update ${context}: ${message}`);
    clearStallWatchdog();
    if (isInstallingUpdate) {
      isQuitting = false;
    }
    isInstallingUpdate = false;
    sendUpdateStatus({ status: 'error', version: updateVersion, message, details, hint });
    updateVersion = null;
    return { ok: false, error: message, details, hint };
  };

  const startStallWatchdog = () => {
    clearStallWatchdog();
    lastDownloadProgressAt = Date.now();
    downloadStallInterval = setInterval(() => {
      if (!updateVersion || lastDownloadProgressAt === null) return;
      // Once bytes are done electron-updater still spends time verifying the
      // file (sha512 / code-sign) and emits no progress — don't treat that as
      // a stall, just wait for update-downloaded.
      if (lastDownloadPercent >= 100) return;
      const idleMs = Date.now() - lastDownloadProgressAt;
      if (idleMs < DOWNLOAD_STALL_TIMEOUT_MS) return;
      console.warn(`[auto-update] download stalled (${Math.round(idleMs / 1000)}s with no progress) — retrying`);
      startStallWatchdog();
      void autoUpdater.downloadUpdate().catch((err) => {
        reportUpdateError(err, 'stall-retry failed');
      });
    }, DOWNLOAD_STALL_POLL_MS);
  };

  // idle → available → downloading → ready; periodic re-checks re-announce
  // "available" but must not regress an in-flight or finished download.
  let updatePhase: 'idle' | 'available' | 'downloading' | 'ready' = 'idle';

  const TRANSIENT_UPDATE_ERROR = /net::ERR_|ETIMEDOUT|ESOCKETTIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up/i;
  const MAX_DOWNLOAD_RETRIES = 5;
  let downloadRetries = 0;
  let downloadRetryTimer: ReturnType<typeof setTimeout> | null = null;

  const clearDownloadRetry = () => {
    if (downloadRetryTimer) {
      clearTimeout(downloadRetryTimer);
      downloadRetryTimer = null;
    }
    downloadRetries = 0;
  };

  autoUpdater.on('update-available', (info) => {
    if (updatePhase === 'downloading' || updatePhase === 'ready') return;
    updatePhase = 'available';
    updateVersion = info.version;
    sendUpdateStatus({ status: 'available', version: info.version });
  });

  ipcMain.handle('app:download-update', async (): Promise<InstallUpdateResult> => {
    if (updatePhase === 'downloading' || updatePhase === 'ready') {
      return { ok: true };
    }
    updatePhase = 'downloading';
    clearDownloadRetry();
    startStallWatchdog();
    sendUpdateStatus({ status: 'downloading', version: updateVersion ?? '', percent: 0 });
    void autoUpdater.downloadUpdate().catch(() => {
      // Failures surface through the 'error' event, where transient network
      // errors are retried before anything is shown.
    });
    return { ok: true };
  });
  autoUpdater.on('download-progress', (progress) => {
    if (!updateVersion) return;
    // Bytes are flowing again — a past interruption no longer counts.
    downloadRetries = 0;
    lastDownloadProgressAt = Date.now();
    const percent = Math.max(0, Math.min(100, Math.round(progress.percent ?? 0)));
    lastDownloadPercent = percent;
    sendUpdateStatus({
      status: 'downloading',
      version: updateVersion,
      percent,
    });
  });
  // macOS: electron-updater's update-downloaded fires when ITS download
  // completes, but Squirrel still has to unpack the zip and deep-verify the
  // bundle's code signature — tens of seconds for an app this size. A
  // Restart & update click during that window silently stalls until Squirrel
  // catches up. Hold the "ready" banner until the native side confirms, so
  // the click goes straight to the final bundle swap.
  let nativeSquirrelReady = process.platform !== 'darwin';
  let pendingReadyVersion: string | null = null;
  let nativeReadyFallbackTimer: ReturnType<typeof setTimeout> | null = null;

  const announceReady = (version: string) => {
    if (nativeReadyFallbackTimer) {
      clearTimeout(nativeReadyFallbackTimer);
      nativeReadyFallbackTimer = null;
    }
    pendingReadyVersion = null;
    sendUpdateStatus({ status: 'ready', version });
  };

  if (process.platform === 'darwin') {
    nativeAutoUpdater.on('update-downloaded', () => {
      nativeSquirrelReady = true;
      if (pendingReadyVersion) {
        announceReady(pendingReadyVersion);
      }
    });
  }

  autoUpdater.on('update-downloaded', (info) => {
    updatePhase = 'ready';
    updateVersion = info.version;
    clearStallWatchdog();
    clearDownloadRetry();
    if (updateCheckInterval) {
      clearInterval(updateCheckInterval);
      updateCheckInterval = null;
    }
    if (nativeSquirrelReady) {
      announceReady(info.version);
      return;
    }
    // Never strand the banner if the native confirmation doesn't arrive —
    // the install path still works, it just stalls like before.
    pendingReadyVersion = info.version;
    nativeReadyFallbackTimer = setTimeout(() => {
      if (pendingReadyVersion) announceReady(pendingReadyVersion);
    }, 3 * 60_000);
  });
  autoUpdater.on('error', (err) => {
    const message = errorMessage(err);

    // Background check failures (no download in flight, nothing being
    // installed) are routine on network changes — a VPN toggling or WiFi
    // switching mid-check must not raise an "Update failed" banner. The
    // periodic re-check retries on its own.
    if (!isInstallingUpdate && updatePhase !== 'downloading') {
      appendLog('connect', 'system', `Auto-update check failed (will retry): ${message}`);
      return;
    }

    // A download interrupted by a transient network error rides it out:
    // retry quietly a few times before surfacing a failure.
    if (
      !isInstallingUpdate
      && updatePhase === 'downloading'
      && TRANSIENT_UPDATE_ERROR.test(message)
      && downloadRetries < MAX_DOWNLOAD_RETRIES
    ) {
      if (downloadRetryTimer) return; // a retry is already scheduled
      downloadRetries += 1;
      appendLog('connect', 'system', `Auto-update download interrupted (${message}) — retry ${downloadRetries}/${MAX_DOWNLOAD_RETRIES} in 15s`);
      downloadRetryTimer = setTimeout(() => {
        downloadRetryTimer = null;
        startStallWatchdog();
        void autoUpdater.downloadUpdate().catch(() => {
          // Failure re-enters through the 'error' event.
        });
      }, 15_000);
      return;
    }

    if (!isInstallingUpdate && updatePhase === 'downloading') {
      // Let the next periodic check re-announce the update after the banner.
      updatePhase = 'available';
    }
    reportUpdateError(err, 'error');
  });

  void autoUpdater.checkForUpdates().catch(() => {});

  updateCheckInterval = setInterval(() => {
    void autoUpdater.checkForUpdates().catch(() => {});
  }, UPDATE_CHECK_INTERVAL_MS);

  // Squirrel installs updates by registering its ShipIt helper as a launchd
  // job and quitting; it treats "submitted" as "done". On this machine's
  // macOS, Background Task Management declines to auto-start the helper
  // (registration accepted but the job never runs, or the fresh submission
  // is rejected outright), so the app quits and the update silently never
  // installs. Running the very same helper manually works every time, so:
  // spawn a detached watchdog before quitting that waits for the app to
  // exit and starts ShipIt itself if launchd didn't.
  const SHIPIT_LABEL = 'com.antseed.desktop.ShipIt';
  const clearStaleMacUpdateJob = (): void => {
    if (process.platform !== 'darwin') return;
    const uid = process.getuid?.();
    if (uid === undefined) return;
    try {
      execFileSync('launchctl', ['bootout', `gui/${uid}/${SHIPIT_LABEL}`], {
        stdio: 'ignore',
      });
    } catch {
      // No job registered — the common case.
    }
  };
  const spawnMacUpdateWatchdog = (): void => {
    if (process.platform !== 'darwin') return;
    const contentsDir = path.resolve(path.dirname(process.execPath), '..');
    const shipIt = path.join(contentsDir, 'Frameworks', 'Squirrel.framework', 'Resources', 'ShipIt');
    const statePath = path.join(app.getPath('home'), 'Library', 'Caches', SHIPIT_LABEL, 'ShipItState.plist');
    const appProcessName = path.basename(process.execPath);
    const script = [
      'APP_PID="$1"; SHIPIT="$2"; LABEL="$3"; STATE="$4"; APP_NAME="$5"',
      // Wait for the app process to exit (Squirrel quits it), then give a
      // launchd-started ShipIt a short window to appear — checking every 2s
      // so a healthy native install ends the watchdog immediately instead of
      // padding the user-visible gap before the relaunch.
      'i=0; while kill -0 "$APP_PID" 2>/dev/null && [ "$i" -lt 180 ]; do sleep 1; i=$((i+1)); done',
      // The install gap has no UI at all — reassure via a system notification.
      'osascript -e \'display notification "Installing the update — the app will reopen shortly." with title "Antseed AI VPN"\' >/dev/null 2>&1 || true',
      'j=0; while [ "$j" -lt 3 ]; do',
      '  sleep 2',
      '  launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -q "state = running" && exit 0',
      '  pgrep -x "$APP_NAME" >/dev/null 2>&1 && exit 0',
      '  j=$((j+1))',
      'done',
      '[ -f "$STATE" ] || exit 0',
      'if launchctl kickstart "gui/$(id -u)/$LABEL" 2>/dev/null; then exit 0; fi',
      'exec "$SHIPIT" "$LABEL" "$STATE"',
    ].join('\n');
    const child = spawn('/bin/sh', ['-c', script, 'antseed-update-watchdog', String(process.pid), shipIt, SHIPIT_LABEL, statePath, appProcessName], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
  };

  ipcMain.handle('app:install-update', async (): Promise<InstallUpdateResult> => {
    if (isInstallingUpdate) {
      return { ok: true };
    }

    isInstallingUpdate = true;
    sendUpdateStatus({ status: 'installing', version: updateVersion });

    try {
      clearStaleMacUpdateJob();
      spawnMacUpdateWatchdog();
      await Promise.allSettled([stopDesktopServices(), recordTelemetryCleanShutdown()]);
      isQuitting = true;
      autoUpdater.quitAndInstall(false, true);
      return { ok: true };
    } catch (err) {
      isQuitting = false;
      return reportUpdateError(err, 'install failed');
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      showMainWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', (event) => {
  if (isQuitting) {
    return;
  }

  event.preventDefault();
  try {
    stakingSessions.pauseWrites();
  } catch {
    dialog.showMessageBoxSync({
      type: 'info', title: 'Staking action in progress',
      message: 'Wait for your staking action to finish before quitting VPR.',
      detail: 'You can follow its progress in the staking dashboard.',
    });
    return;
  }
  isQuitting = true;

  // First, and synchronously: the async teardown below waits on child
  // processes and can be cut short (Windows gives an app only a few seconds
  // to quit at logout/shutdown before killing it). An OS proxy left pointing
  // at the dead port breaks networking machine-wide, so it must not be
  // downstream of anything that can block.
  restoreOsSystemProxySync();

  // Briefly flush the final close event and clear the local crash marker before
  // exit, otherwise delivery is lost or the next launch reports a false crash.
  const telemetryShutdown = recordTelemetryCleanShutdown();
  void Promise.allSettled([stopDesktopServices(), telemetryShutdown]).finally(() => {
    app.exit(0);
  });
});

// Ensure child processes are cleaned up if the main process receives a terminal
// stop signal before before-quit fires.
process.on('SIGINT', () => {
  restoreOsSystemProxySync();
  const telemetryShutdown = recordTelemetryCleanShutdown();
  void Promise.allSettled([stopDesktopServices(), telemetryShutdown]).finally(() => process.exit(0));
});

process.on('SIGTERM', () => {
  restoreOsSystemProxySync();
  const telemetryShutdown = recordTelemetryCleanShutdown();
  void Promise.allSettled([stopDesktopServices(), telemetryShutdown]).finally(() => process.exit(0));
});

// Suppress EPIPE errors from console.error/console.warn when the dev terminal
// pipe is closed (e.g. Ctrl+C in the terminal while Electron is still running).
process.stdout?.on('error', () => {});
process.stderr?.on('error', () => {});
