/**
 * IPC surface for connecting apps through the system proxy: the profile list,
 * the app picker, CA trust, and starting/stopping the runtime.
 */
import { ipcMain } from 'electron';
import { desktopSystemProxyCliDataDir } from '../dev-instance.js';
import {
  type CustomAppRecord,
  customAppName,
  deriveCustomAppTarget,
  fetchCustomAppSiteMetadata,
  loadCustomApps,
  probeCustomAppModelsEndpoint,
  saveCustomApps,
} from '../connected-apps/custom.js';
import {
  installedAppIcon,
} from '../connected-apps/installed.js';
import {
  type AppLaunchTarget,
  normalizeToolSlugs,
  setAppIdentitySetting,
  setAppLaunchSetting,
} from '../connected-apps/launch-settings.js';
import {
  appTargetNeedsRestart,
  isCertificateTrustError,
  restartAppTarget,
} from '../connected-apps/launcher.js';
import {
  effectiveLaunchTarget,
  effectiveToolSlugs,
  launchTargetIcon,
  readInstalledAppTarget,
  syncCustomAppDisplay,
} from '../connected-apps/profile-targets.js';
import {
  stripAnsi,
} from '../runtime/log-parser.js';
import {
  type ProcessManager,
  resolveConnectDataDir,
} from '../runtime/process-manager.js';
import {
  canConnectToLocalPort,
  getSystemProxyServices,
  isWindowsSystemProxyConfigured,
} from '../system-proxy/os-settings.js';
import {
  systemProxyCaPath,
} from '../system-proxy/paths.js';
import {
  DEFAULT_SYSTEM_PROXY_PORT,
  SYSTEM_PROXY_PROFILES,
  allSystemProxyProfiles,
  loadCustomAppRecords,
} from '../system-proxy/profiles.js';
import {
  type SystemProxyGuiTestResult,
  getLastSystemProxySetupAt,
  getSystemProxyProcessState,
  refreshTrayMenu,
  restartTargetProcessInfo,
  runGuiSystemProxyTrustProbe,
  setLastSystemProxySetupAt,
  startSystemProxyRuntime,
  stopSystemProxyRuntime,
} from '../system-proxy/runtime.js';
import {
  shell,
} from 'electron';
import {
  existsSync,
} from 'node:fs';
import path from 'node:path';

export function registerSystemProxyIpc(deps: { processManager: ProcessManager }): void {
  const { processManager } = deps;

  ipcMain.handle('system-proxy:list-profiles', async () => {
    const base = await Promise.all(SYSTEM_PROXY_PROFILES.map(async (profile) => {
      const launchTarget = effectiveLaunchTarget(profile.name);
      // The associated application's real icon represents the row; the
      // renderer falls back to a drawn brand mark without one.
      const iconDataUri = launchTarget ? await launchTargetIcon(launchTarget.path) : null;
      return {
        name: profile.name,
        displayName: profile.label,
        kind: profile.kind,
        method: profile.method,
        domains: profile.domains,
        appAction: profile.appAction,
        openUrl: profile.openUrl,
        toolName: profile.toolName,
        canRestart: Boolean(launchTarget),
        needsRestart: launchTarget ? await appTargetNeedsRestart(launchTarget, getLastSystemProxySetupAt()) : false,
        toolSlugs: effectiveToolSlugs(profile.name, profile.toolSlugs, profile.label),
        ...(iconDataUri ? { iconDataUri } : {}),
        ...(launchTarget ? { launchAppName: launchTarget.name } : {}),
      };
    }));
    const custom = await Promise.all(loadCustomAppRecords().map(async (record) => {
      const launchTarget = effectiveLaunchTarget(record.name);
      // The picked application's name and icon identify a custom app, ahead of
      // whatever the record captured (site favicon/title) when it was added.
      const displayName = launchTarget?.name ?? record.displayName;
      const iconDataUri = (launchTarget ? await launchTargetIcon(launchTarget.path) : null)
        ?? record.iconDataUri;
      return {
        name: record.name,
        displayName,
        kind: 'proxy' as const,
        method: 'HTTPS proxy',
        domains: [record.host],
        canRestart: Boolean(launchTarget),
        needsRestart: launchTarget ? await appTargetNeedsRestart(launchTarget, getLastSystemProxySetupAt()) : false,
        custom: true,
        toolSlugs: effectiveToolSlugs(record.name, undefined, displayName),
        ...(iconDataUri ? { iconDataUri } : {}),
        ...(launchTarget ? { launchAppName: launchTarget.name } : {}),
      };
    }));
    return [...base, ...custom];
  });

  ipcMain.handle('system-proxy:set-app-launch', async (_event, opts: { name?: string; app?: { name?: string; path?: string } | null }) => {
    const name = typeof opts?.name === 'string' ? opts.name : '';
    if (!allSystemProxyProfiles().some((profile) => profile.name === name)) {
      return { ok: false, error: 'Unknown app.' };
    }
    const app = opts?.app;
    let target: AppLaunchTarget | null = null;
    if (app !== null && app !== undefined) {
      target = readInstalledAppTarget(app);
      if (!target) return { ok: false, error: 'That application could not be found.' };
    }
    setAppLaunchSetting(resolveConnectDataDir(), name, target);
    await syncCustomAppDisplay(name, target);
    refreshTrayMenu();
    return { ok: true };
  });

  ipcMain.handle('system-proxy:set-app-identity', (_event, opts: { name?: string; toolSlugs?: unknown }) => {
    const name = typeof opts?.name === 'string' ? opts.name : '';
    if (!allSystemProxyProfiles().some((profile) => profile.name === name)) {
      return { ok: false, error: 'Unknown app.' };
    }
    const raw = opts?.toolSlugs;
    if (raw !== null && raw !== undefined && !Array.isArray(raw)) {
      return { ok: false, error: 'Client names must be a list.' };
    }
    const slugs = Array.isArray(raw)
      ? normalizeToolSlugs(raw.filter((entry): entry is string => typeof entry === 'string'))
      : null;
    // An empty list clears the override — the profile's defaults apply again.
    setAppIdentitySetting(resolveConnectDataDir(), name, slugs && slugs.length > 0 ? slugs : null);
    return { ok: true };
  });

  ipcMain.handle('system-proxy:add-custom-app', async (_event, opts: { apiUrl?: string; app?: unknown; force?: boolean }) => {
    try {
      const apiUrl = typeof opts?.apiUrl === 'string' ? opts.apiUrl.trim() : '';
      const target = deriveCustomAppTarget(apiUrl);
      const existingProfiles = allSystemProxyProfiles();
      const conflict = existingProfiles.find((profile) => profile.kind === 'proxy' && profile.domains.includes(target.host));
      if (conflict) {
        return { ok: false, error: `${target.host} is already handled by ${conflict.label}.` };
      }
      // Verify the URL points at an AI API before intercepting it. Inconclusive
      // probes (gateways behind bot challenges, offline hosts) only warn — the
      // renderer retries with force after the user confirms.
      if (opts?.force !== true) {
        const probe = await probeCustomAppModelsEndpoint(apiUrl);
        if (!probe.ok) {
          return {
            ok: false,
            unverified: true,
            error: `This does not look like a supported AI API: ${probe.url} ${probe.detail}. You can add it anyway if you are sure.`,
          };
        }
      }
      // When the user picked the application that talks to this API, its name
      // and icon identify the entry — no favicon fetch needed. Without a pick,
      // fall back to the domain's site metadata.
      const launchTarget = readInstalledAppTarget(opts?.app);
      const appIcon = launchTarget ? await installedAppIcon(launchTarget.path) : null;
      const metadata = launchTarget ? null : await fetchCustomAppSiteMetadata(target.host);
      const iconDataUri = appIcon ?? metadata?.iconDataUri;
      const dataDir = resolveConnectDataDir();
      const record: CustomAppRecord = {
        name: customAppName(target.host, existingProfiles.map((profile) => profile.name)),
        displayName: launchTarget?.name ?? metadata?.title ?? target.host,
        apiUrl,
        ...target,
        ...(iconDataUri ? { iconDataUri } : {}),
        createdAt: Date.now(),
      };
      saveCustomApps(dataDir, [...loadCustomApps(dataDir), record]);
      // The picked application also becomes the profile's "Open with" target.
      if (launchTarget) setAppLaunchSetting(dataDir, record.name, launchTarget);
      refreshTrayMenu();
      return { ok: true, name: record.name };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('system-proxy:remove-custom-app', (_event, opts: { name?: string }) => {
    try {
      const name = typeof opts?.name === 'string' ? opts.name : '';
      const dataDir = resolveConnectDataDir();
      const existing = loadCustomApps(dataDir);
      if (!existing.some((record) => record.name === name)) {
        return { ok: false, error: 'Unknown custom app.' };
      }
      saveCustomApps(dataDir, existing.filter((record) => record.name !== name));
      // Drop the app's per-profile settings so a future same-name profile
      // doesn't inherit them.
      setAppLaunchSetting(dataDir, name, null);
      setAppIdentitySetting(dataDir, name, null);
      refreshTrayMenu();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('system-proxy:start', async (_event, opts: { peerId: string; port?: number; profiles?: string[]; defaultModel?: string; servedModels?: string[]; toolRoutes?: Record<string, { peerId: string; model: string }>; profileSwitch?: boolean }) => {
    try {
      return { ok: true, state: await startSystemProxyRuntime(opts) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('system-proxy:stop', async () => {
    try {
      return { ok: true, state: await stopSystemProxyRuntime(true) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('system-proxy:get-state', () => {
    return getSystemProxyProcessState();
  });

  ipcMain.handle('system-proxy:install-ca', async () => {
    try {
      const dataDir = desktopSystemProxyCliDataDir() ?? resolveConnectDataDir();
      const result = await processManager.runCliCommand(['--data-dir', dataDir, 'system-proxy', 'install-ca']);
      setLastSystemProxySetupAt(Date.now());
      const warning = stripAnsi(result.stdout)
        .split(/\r?\n/)
        .find((line) => line.trim().startsWith('Warning:'))
        ?.replace(/^Warning:\s*/, '')
        .trim();
      return { ok: true, ...(warning ? { warning } : {}) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('system-proxy:test-gui', async (_event, opts?: { port?: number }): Promise<SystemProxyGuiTestResult> => {
    const port = opts?.port ?? DEFAULT_SYSTEM_PROXY_PORT;
    const targetApp = await restartTargetProcessInfo();
    const proxyConfigured = process.platform === 'darwin'
      ? getSystemProxyServices(port).length > 0
      : process.platform === 'win32'
        ? isWindowsSystemProxyConfigured(port)
        : true;
    const proxyReachable = await canConnectToLocalPort(port);
    const lastSetupAt = getLastSystemProxySetupAt();
    const needsAppRestartByStartTime = Boolean(
      targetApp.running
      && lastSetupAt
      && (!targetApp.startedAt || targetApp.startedAt < lastSetupAt),
    );

    if (!proxyReachable) {
      return {
        ok: false,
        proxyConfigured,
        proxyReachable,
        guiTrustOk: false,
        certTrustError: false,
        appRunning: targetApp.running,
        needsAppRestart: needsAppRestartByStartTime,
        appPid: targetApp.pid,
        error: `System Proxy is not listening on 127.0.0.1:${port}.`,
      };
    }

    if (!proxyConfigured) {
      return {
        ok: false,
        proxyConfigured,
        proxyReachable,
        guiTrustOk: false,
        certTrustError: false,
        appRunning: targetApp.running,
        needsAppRestart: needsAppRestartByStartTime,
        appPid: targetApp.pid,
        error: process.platform === 'win32'
          ? 'The Windows proxy settings are not pointing at System Proxy — another tool (VPN, corporate policy) may have overwritten them.'
          : 'macOS HTTPS proxy is not pointing at System Proxy.',
      };
    }

    const probe = await runGuiSystemProxyTrustProbe();
    const needsAppRestart = !probe.ok && (
      needsAppRestartByStartTime
      || (targetApp.running && isCertificateTrustError(probe.error ?? ''))
    );
    return {
      ok: probe.ok,
      proxyConfigured,
      proxyReachable,
      guiTrustOk: probe.ok,
      certTrustError: !probe.ok && isCertificateTrustError(probe.error ?? ''),
      appRunning: targetApp.running,
      needsAppRestart,
      appPid: targetApp.pid,
      statusCode: probe.statusCode,
      error: probe.error,
    };
  });

  ipcMain.handle('system-proxy:restart-app', async (_event, opts: { app: string }) => {
    const profileName = typeof opts?.app === 'string' ? opts.app : '';
    const profile = allSystemProxyProfiles().find((item) => item.name === profileName);
    const target = effectiveLaunchTarget(profileName);
    if (!profile || !target) {
      return { ok: false, error: `No restart target configured for ${profileName || 'this profile'}.` };
    }
    const result = await restartAppTarget(target, {
      force: true,
      launchIfStopped: true,
      env: { NODE_EXTRA_CA_CERTS: systemProxyCaPath() },
    });
    return { ok: result.ok, ...(result.error ? { error: result.error } : {}) };
  });

  ipcMain.handle('system-proxy:ca-exists', () => {
    const dataDir = desktopSystemProxyCliDataDir() ?? resolveConnectDataDir();
    return existsSync(path.join(dataDir, 'system-proxy', 'ca.crt'))
      && existsSync(path.join(dataDir, 'system-proxy', 'ca.key'));
  });

  // Where the local HTTPS-interception CA lives on this device, for the Apps
  // page's transparency panel. The cert is generated only when an intercepted
  // (custom HTTPS) app first connects, so `exists` is false by default.
  ipcMain.handle('system-proxy:ca-info', (): { path: string; exists: boolean } => {
    const caPath = systemProxyCaPath();
    return { path: caPath, exists: existsSync(caPath) };
  });

  ipcMain.handle('system-proxy:reveal-ca', (): { ok: boolean; error?: string } => {
    const caPath = systemProxyCaPath();
    if (!existsSync(caPath)) {
      return { ok: false, error: 'No certificate has been created yet. Connect an intercepted HTTPS app first.' };
    }
    shell.showItemInFolder(caPath);
    return { ok: true };
  });

  // Whether the OS already trusts this device's CA. Drives the "trust the
  // certificate" prompt shown after adding an intercepted app: `stale` means an
  // older Antseed CA is trusted under the same name (the CERT_SIGNATURE_FAILURE
  // cause), `absent` means nothing is trusted yet, `trusted` means we're set.
  ipcMain.handle('system-proxy:ca-trust-state', async (): Promise<{ ok: boolean; exists: boolean; trust: 'trusted' | 'stale' | 'absent' | 'unknown'; error?: string }> => {
    try {
      const dataDir = desktopSystemProxyCliDataDir() ?? resolveConnectDataDir();
      const result = await processManager.runCliCommand(['--data-dir', dataDir, 'system-proxy', 'ca-trust-state']);
      const line = stripAnsi(result.stdout)
        .split(/\r?\n/)
        .reverse()
        .find((entry) => entry.trim().startsWith('{'));
      const parsed = line ? JSON.parse(line) as { exists?: unknown; trust?: unknown } : {};
      const trust = parsed.trust === 'trusted' || parsed.trust === 'stale' || parsed.trust === 'absent'
        ? parsed.trust
        : 'unknown';
      return { ok: true, exists: parsed.exists === true, trust };
    } catch (err) {
      return { ok: false, exists: false, trust: 'unknown', error: err instanceof Error ? err.message : String(err) };
    }
  });
}
