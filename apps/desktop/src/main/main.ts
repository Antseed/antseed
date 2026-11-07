import {
  app,
  autoUpdater as nativeAutoUpdater,
  BrowserWindow,
  ipcMain,
  safeStorage,
} from 'electron';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import electronUpdater from 'electron-updater';
const { autoUpdater } = electronUpdater;
import {
  ProcessManager,
  type RuntimeMode,
  type RuntimeProcessState,
} from './runtime/process-manager.js';
import { registerPiChatHandlers } from './chat/engine.js';
import { emitChatEvent } from './chat/event-bus.js';
import { createTelegramBridge } from './telegram/bridge.js';
import { encryptedIdentityPath, ensureSecureIdentity, getSecureIdentity, hasStoredIdentity } from './identity.js';
import type { LogEvent } from './runtime/log-parser.js';
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
  LEGACY_INTERNAL_APP_NAME,
  RENAMED_FROM_LEGACY,
  TRAY_ICON_PATH,
  errorDetails,
  errorMessage,
  getAppSetupStatus,
  getMacUpdateInstallHint,
  isDev,
  rendererUrl,
  setAppSetupStatus,
  type InstallUpdateResult,
  type UpdateStatus,
} from './app-context.js';
import {
  initConnectedApps,
  reconnectAllApps,
  releaseConnectedAppsOnQuit,
} from './connected-apps/patching/connection.js';
import { ensureLocalGateway, holdLocalGatewayUntil, initGatewayService, stopLocalGateway } from './gateway/service.js';
import { gatewaySettingsPath } from './gateway/settings.js';
import { IS_SAFE_STORAGE_EXPORT } from './process-role.js';
import { isMultiInstanceDevelopment } from './dev-instance.js';
import { runSafeStorageExport } from './safe-storage-export.js';
import { exportWithOldName, gatewaySettingsStore, migrateEncryptedStores, wholeFileStore } from './app-rename.js';
import { releaseLegacySystemProxy } from './connected-apps/patching/legacy-os-proxy.js';
import { registerAppIpc } from './ipc/app.js';
import { registerDesktopIpc } from './ipc/desktop.js';
import { registerFreeTierIpc } from './ipc/free-tier.js';
import { registerPaymentsIpc } from './ipc/payments.js';
import { registerRuntimeIpc } from './ipc/runtime.js';
import { registerConnectedAppsIpc } from './ipc/connected-apps.js';
import { registerGatewayIpc } from './ipc/gateway.js';
import { registerTelegramIpc } from './ipc/telegram.js';
import {
  effectiveLaunchTarget,
} from './connected-apps/profile-targets.js';
import {
  stopPaymentsPortal,
} from './payments/portal.js';
import { ACTIVE_CONFIG_PATH } from './runtime/active-config.js';
import { createTelemetryService } from './telemetry/telemetry.js';
import { setTelemetryService } from './telemetry/runtime.js';
import { firstChatDepositSnapshot } from './telemetry/events.js';
import { refreshCreditsInfo } from './payments/credits.js';

// Internal runtime name (INTERNAL_APP_NAME, app-context.ts): on macOS the
// safeStorage encryption key lives in the "<app.setName value> Safe Storage"
// keychain entry, and the default userData path derives from it too. Renaming
// it rotates the key; app-rename.ts moves the userData folder and re-encrypts
// identity.enc and the gateway key secrets the first time the new name runs.
// User-visible surfaces use APP_NAME.

async function migrateStoresAfterRename(): Promise<void> {
  const log = (line: string) => console.log(`[desktop] rename: ${line}`);
  try {
    const oldUserData = path.join(app.getPath('appData'), LEGACY_INTERNAL_APP_NAME);
    const result = await migrateEncryptedStores({
      stores: [wholeFileStore(encryptedIdentityPath()), gatewaySettingsStore(gatewaySettingsPath())],
      markerDir: app.getPath('userData'),
      oldName: LEGACY_INTERNAL_APP_NAME,
      newName: INTERNAL_APP_NAME,
      safeStorage,
      // The helper runs under the old name. Its userData only matters on
      // Windows (the key is in `Local State`): the old folder when it is still
      // there, else the moved one.
      decryptWithOldName: (blobs) => exportWithOldName({
        execPath: process.execPath,
        appArgs: app.isPackaged ? [] : [app.getAppPath()],
        oldName: LEGACY_INTERNAL_APP_NAME,
        userData: existsSync(oldUserData) ? oldUserData : app.getPath('userData'),
        blobs,
      }),
      log,
    });
    if (!result.skipped) log(`migrated ${result.migrated.length}, failed ${result.failed.length}`);
  } catch (err) {
    log(`failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

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

// The safeStorage export helper (app-rename.ts) does its one job and exits;
// the guards below keep the app itself from starting in that process.
if (IS_SAFE_STORAGE_EXPORT) runSafeStorageExport();

// One app at a time: a second launch (e.g. a relaunch after an update while
// the app already reopened) brings the open window forward instead of
// starting a second gateway. Development instances run side by side on
// purpose, and the export helper takes no lock.
if (!IS_SAFE_STORAGE_EXPORT && !isMultiInstanceDevelopment()) {
  if (!app.requestSingleInstanceLock()) {
    app.exit(0);
  } else {
    app.on('second-instance', () => {
      const win = getMainWindow();
      if (!win) return;
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    });
  }
}

const logBuffer: LogEvent[] = [];

function emitRuntimeState(): void {
  getMainWindow()?.webContents.send('runtime:state', getCombinedProcessState());
}

function appendLog(mode: RuntimeMode, stream: 'stdout' | 'stderr' | 'system', line: string): void {
  const event: LogEvent = { mode, stream, line, timestamp: Date.now() };
  logBuffer.push(event);
  if (logBuffer.length > 1200) {
    logBuffer.splice(0, logBuffer.length - 1200);
  }

  getMainWindow()?.webContents.send('runtime:log', event);
  emitRuntimeState();
}

// Wire up callbacks for extracted modules
setPluginAppendLog(appendLog);

// When the peer set changes, tell the renderer to refresh the service catalog.
onPeersChanged(() => {
  getMainWindow()?.webContents.send('peers:changed');
});
const processManager = new ProcessManager((mode, stream, line) => {
  appendLog(mode, stream, line);
});

initGatewayService({ processManager, appendLog });
// Not in the export helper: it restores retired apps' configs.
if (!IS_SAFE_STORAGE_EXPORT) {
  initConnectedApps({
    appendLog,
    effectiveLaunchTarget: (profileName) => effectiveLaunchTarget(profileName),
  });
}

async function stopDesktopServices(): Promise<void> {
  await Promise.all([
    telegramBridge.stop(),
    releaseConnectedAppsOnQuit().then(() => stopLocalGateway()),
    stopPaymentsPortal(),
  ]);
}

function getCombinedProcessState(): RuntimeProcessState[] {
  return processManager.getState();
}

// ── IPC handlers ──
// Each group lives in ipc/<domain>.ts; anything they need from this file is
// passed in rather than reached for.
registerPaymentsIpc();
registerFreeTierIpc();
registerDesktopIpc();
registerAppIpc();
registerConnectedAppsIpc();
registerGatewayIpc({
  onEndpointChanged: () => {
    piChatEngine.invalidateModelCatalog();
    getMainWindow()?.webContents.send('gateway:changed');
  },
});
registerRuntimeIpc({
  processManager,
  logBuffer,
  getCombinedProcessState,
});

// Created here, before any IPC handler can run, and settled in whenReady.
let settlePluginInstall: (install: Promise<unknown>) => void = () => {};
holdLocalGatewayUntil(new Promise<void>((resolve) => {
  settlePluginInstall = (install) => { void install.then(() => resolve(), () => resolve()); };
}));

// ── AI Chat IPC Handlers ──
const piChatEngine = registerPiChatHandlers({
  ipcMain,
  sendToRenderer: (channel, payload) => {
    getMainWindow()?.webContents.send(channel, payload);
    // Tee every chat event into the bus so the Telegram bridge can follow it.
    emitChatEvent(channel, payload);
  },
  configPath: ACTIVE_CONFIG_PATH,
  appendSystemLog: (line) => {
    appendLog('gateway', 'system', line);
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

// ── Telegram bridge ──
const telegramBridge = createTelegramBridge({
  engine: piChatEngine,
  appendLog: (line) => { appendLog('gateway', 'system', line); },
  onStatusChanged: (status) => {
    getMainWindow()?.webContents.send('telegram:status-changed', status);
  },
});

registerTelegramIpc({ telegramBridge });

app.whenReady().then(async () => {
  if (IS_SAFE_STORAGE_EXPORT) return;
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
  // Before anything reads an encrypted store under the new name.
  if (RENAMED_FROM_LEGACY) await migrateStoresAfterRename();
  const hadExistingIdentity = hasStoredIdentity();
  await ensureSecureIdentity();
  telemetryReady = initializeTelemetry(hadExistingIdentity);
  await telemetryReady;
  createApplicationMenu(APP_NAME, APP_ICON_PATH);

  // Ensure config.json exists before anything else (first launch).
  // Must complete before creating the window — the renderer auto-starts the
  // buyer runtime which needs config.json to find the router plugin.
  await ensureConfig(ACTIVE_CONFIG_PATH).catch(() => {});

  const showMainWindow = () => {
    const existingWindow = getMainWindow();
    if (existingWindow) {
      existingWindow.show();
      existingWindow.focus();
      return;
    }
    createWindow({ appName: APP_NAME, appIconPath: APP_ICON_PATH, isDev, rendererUrl });
  };

  showMainWindow();

  createDesktopTray({
    appName: APP_NAME,
    iconPath: TRAY_ICON_PATH,
    onShow: showMainWindow,
    buildMenu: () => [
      { label: `Show ${APP_NAME}`, click: showMainWindow },
      { label: 'Quit', click: () => app.quit() },
    ],
  });

  // Releases before the gateway could leave the OS proxy pointing at their
  // local system proxy after a crash; nothing listens there any more.
  void releaseLegacySystemProxy();

  // The buyer loads the router plugin, and installing it replaces the plugins
  // folder, so the gateway only starts once the install has settled. Failure is
  // already logged inside ensureDefaultPlugin; the gateway then reports its own.
  const pluginReady = ensureDefaultPlugin('@antseed/router-local', {
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

  // The local gateway (and its buyer) comes up with the app; connected apps
  // are re-pointed at it once it serves. Nothing to start for a remote one.
  settlePluginInstall(pluginReady);
  void pluginReady
    .then(() => ensureLocalGateway())
    .catch((err) => {
      appendLog('gateway', 'system', `Gateway start failed: ${err instanceof Error ? err.message : String(err)}`);
    })
    .then(() => reconnectAllApps())
    .catch((err) => {
      appendLog('gateway', 'system', `Reconnecting apps failed: ${err instanceof Error ? err.message : String(err)}`);
    });

  // Resume the Telegram bridge if a bot was connected in a previous session.
  // Needs app-ready because the token store decrypts via safeStorage.
  void telegramBridge.start().catch((err) => {
    appendLog('gateway', 'system', `[telegram] Bridge resume failed: ${err instanceof Error ? err.message : String(err)}`);
  });

  // Payments portal starts lazily on first open (via payments:open-portal IPC)

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
    appendLog('gateway', 'system', `Auto-update ${context}: ${message}`);
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

  const startUpdateDownload = (): void => {
    if (updatePhase === 'downloading' || updatePhase === 'ready') return;
    updatePhase = 'downloading';
    clearDownloadRetry();
    startStallWatchdog();
    sendUpdateStatus({ status: 'downloading', version: updateVersion ?? '', percent: 0 });
    void autoUpdater.downloadUpdate().catch(() => {
      // Failures surface through the 'error' event, where transient network
      // errors are retried before anything is shown.
    });
  };

  ipcMain.handle('app:download-update', async (): Promise<InstallUpdateResult> => {
    startUpdateDownload();
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
      appendLog('gateway', 'system', `Auto-update check failed (will retry): ${message}`);
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
      appendLog('gateway', 'system', `Auto-update download interrupted (${message}) — retry ${downloadRetries}/${MAX_DOWNLOAD_RETRIES} in 15s`);
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
      'osascript -e \'display notification "Installing the update — the app will reopen shortly." with title "Antseed Desktop"\' >/dev/null 2>&1 || true',
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

  async function installDownloadedUpdate(): Promise<InstallUpdateResult> {
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
  }
  ipcMain.handle('app:install-update', () => installDownloadedUpdate());

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
  isQuitting = true;

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
  const telemetryShutdown = recordTelemetryCleanShutdown();
  void Promise.allSettled([stopDesktopServices(), telemetryShutdown]).finally(() => process.exit(0));
});

process.on('SIGTERM', () => {
  const telemetryShutdown = recordTelemetryCleanShutdown();
  void Promise.allSettled([stopDesktopServices(), telemetryShutdown]).finally(() => process.exit(0));
});

// Suppress EPIPE errors from console.error/console.warn when the dev terminal
// pipe is closed (e.g. Ctrl+C in the terminal while Electron is still running).
process.stdout?.on('error', () => {});
process.stderr?.on('error', () => {});
