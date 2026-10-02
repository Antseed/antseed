/**
 * The system-proxy runtime: its process lifecycle, the persisted connection
 * state, and the tray menu that drives it.
 *
 * These three arrived here together because they cannot be separated — the
 * tray menu is a view of the connection state, changing it starts or stops the
 * runtime, and the runtime writes the state back. Splitting them would mean
 * exporting the mutable state they share; keeping them in one module makes
 * that sharing private and leaves a small surface: the `SystemProxyDeps`
 * below are the only things it needs from the app around it.
 */
import { net as electronNet, type MenuItemConstructorOptions } from 'electron';
import { readFileSync } from 'node:fs';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import type { AppLaunchTarget } from '../connected-apps/launch-settings.js';
import {
  isMultiInstanceDevelopment,
  shouldRemoveSharedConfigPatches,
} from '../dev-instance.js';
import {
  getMacAppProcessInfo,
  isAppTargetRunning,
  namedAppTarget,
  restartAppTarget,
} from '../connected-apps/launcher.js';
import { getNetworkSnapshot, lookupPeer, type DashboardNetworkPeer } from '../runtime/peer-cache.js';
import type { ProcessManager, RuntimeMode, RuntimeProcessState } from '../runtime/process-manager.js';
import { applyWindowView, getMainWindow } from '../ui/window.js';
import { updateDesktopTray } from '../ui/tray.js';
import path from 'node:path';
import { ensureClaudeDesktopGateway, stopClaudeDesktopGateway } from '../connected-apps/claude-desktop-gateway.js';
import { applyConfigPatch, removeConfigPatch } from './config-patch.js';
import {
  DEFAULT_SYSTEM_PROXY_PORT,
  SYSTEM_PROXY_PROFILES,
  allSystemProxyProfiles,
  readStringArray,
  removeAllConfigPatches,
  systemProxyProfilesEnv,
} from './profiles.js';
import {
  canConnectToLocalPort,
  isOsSystemProxyConfigured,
  restoreOsSystemProxy,
  waitForSystemProxyReady,
} from './os-settings.js';
import { resolveBuyerProxyPort } from '../runtime/active-config.js';
import {
  systemProxyCaPath,
  systemProxyDataDir,
  systemProxyDesktopStatePath,
  systemProxyPidPath,
  systemProxyStatePath,
  systemProxyWslTargetsPath,
} from './paths.js';
import { clearWslTargetsForTool, isWslTool, readWslTargets } from './wsl.js';
import { stopWslRelays, syncWslRelays } from './wsl-relay.js';

/** What this module needs from the app around it — injected once at startup. */
export type SystemProxyDeps = {
  appName: string;
  appendLog: (mode: RuntimeMode, stream: 'stdout' | 'stderr' | 'system', line: string) => void;
  processManager: ProcessManager;
  effectiveLaunchTarget: (profileName: string) => AppLaunchTarget | null;
};

let injected: SystemProxyDeps | null = null;

export function initSystemProxyRuntime(deps: SystemProxyDeps): void {
  injected = deps;
}

function deps(): SystemProxyDeps {
  if (!injected) {
    throw new Error('system-proxy runtime used before initSystemProxyRuntime()');
  }
  return injected;
}

let lastSystemProxySetupAt: number | null = null;
let traySystemProxyPeerId = '';
let traySystemProxyModel = '';
let traySystemProxyProfiles = new Set<string>();
let activeSystemProxyState: (RuntimeProcessState & Record<string, unknown>) | null = null;

export type SystemProxyGuiTestResult = {
  ok: boolean;
  proxyConfigured: boolean;
  proxyReachable: boolean;
  guiTrustOk: boolean;
  /** True only when the probe failed with a certificate/TLS trust error —
   *  a timeout or generic network failure is NOT a missing-CA signal. */
  certTrustError: boolean;
  appRunning: boolean;
  needsAppRestart: boolean;
  appPid?: number;
  statusCode?: number;
  error?: string;
};


/** Every profile that has ever been connected — the on-disk `setupProfileNames`
    plus whatever is (or was last) active, so state files written before the
    field existed still count their connected apps as set up. */
function knownSetupProfileNames(metadata: Record<string, unknown>, extras: string[] = []): string[] {
  return Array.from(new Set([
    ...readStringArray(metadata['setupProfileNames']),
    ...readStringArray(metadata['activeProfileNames']),
    ...extras,
  ]));
}

export function readSystemProxyRuntimeMetadata(): Record<string, unknown> {
  // Desktop file first; the CLI child's state file only as a fallback (it
  // exists while the child runs, and older desktop builds persisted there).
  for (const filePath of [systemProxyDesktopStatePath(), systemProxyStatePath()]) {
    try {
      const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // Missing or invalid — try the next source.
    }
  }
  return {};
}

export function loadPersistedSystemProxyState(): void {
  const metadata = readSystemProxyRuntimeMetadata();
  const activeProfileNames = readStringArray(metadata['activeProfileNames']);
  const peerId = typeof metadata['peerId'] === 'string' ? metadata['peerId'] : '';
  const defaultModel = typeof metadata['defaultModel'] === 'string' ? metadata['defaultModel'] : '';
  if (activeProfileNames.length === 0 || !peerId) return;
  activeSystemProxyState = {
    mode: 'system-proxy',
    running: activeProfileNames.some((name) => isConfigPatchProfileName(name)),
    pid: null,
    startedAt: Date.now(),
    lastExitCode: null,
    lastError: null,
    port: Number(metadata['port']) || DEFAULT_SYSTEM_PROXY_PORT,
    peerId,
    defaultModel,
    activeProfileNames,
    setupProfileNames: knownSetupProfileNames(metadata),
    toolRoutes: metadata['toolRoutes'],
  };
  traySystemProxyPeerId = peerId;
  traySystemProxyModel = defaultModel;
  traySystemProxyProfiles = new Set(activeProfileNames);
}

export function withSystemProxyRuntimeMetadata(state: RuntimeProcessState | null): RuntimeProcessState | null {
  const metadata = readSystemProxyRuntimeMetadata();
  const setupProfileNames = knownSetupProfileNames(metadata);
  if (!state) {
    if (setupProfileNames.length === 0) return null;
    return {
      mode: 'system-proxy',
      running: false,
      pid: null,
      startedAt: Date.now(),
      lastExitCode: null,
      lastError: null,
      ...metadata,
      activeProfileNames: [],
      setupProfileNames,
    } as RuntimeProcessState & Record<string, unknown>;
  }
  if (state.mode !== 'system-proxy') return state;
  return {
    ...state,
    ...metadata,
    setupProfileNames,
    activeProfileNames: state.running ? metadata['activeProfileNames'] : [],
    running: state.running,
  } as RuntimeProcessState & Record<string, unknown>;
}

export function getSystemProxyProcessState(): RuntimeProcessState | null {
  const processState = deps().processManager.getState().find((s) => s.mode === 'system-proxy') ?? null;
  if (!activeSystemProxyState) {
    return withSystemProxyRuntimeMetadata(processState);
  }
  const activeProfiles = Array.isArray(activeSystemProxyState['activeProfileNames'])
    ? activeSystemProxyState['activeProfileNames'].filter((name: unknown): name is string => typeof name === 'string')
    : [];
  const hasConfigPatch = activeProfiles.some((name) => isConfigPatchProfileName(name));
  const running = processState?.running === true || hasConfigPatch;
  return {
    ...activeSystemProxyState,
    ...(processState ?? {}),
    running,
    pid: processState?.pid ?? null,
    lastExitCode: processState?.lastExitCode ?? activeSystemProxyState.lastExitCode ?? null,
    lastError: processState?.lastError ?? activeSystemProxyState.lastError ?? null,
  };
}

export async function setActiveSystemProxyState(state: RuntimeProcessState & Record<string, unknown>): Promise<void> {
  const metadata = readSystemProxyRuntimeMetadata();
  const setupProfileNames = knownSetupProfileNames(metadata, [
    ...readStringArray(state['setupProfileNames']),
    ...readStringArray(state['activeProfileNames']),
  ]);
  // Kept on the in-memory state too — getSystemProxyProcessState() serves
  // polls from here without re-reading the disk file.
  activeSystemProxyState = { ...state, setupProfileNames };
  await mkdir(systemProxyDataDir(), { recursive: true }).catch(() => undefined);
  await writeFile(systemProxyDesktopStatePath(), JSON.stringify({
    port: state['port'],
    peerId: state['peerId'],
    defaultModel: state['defaultModel'],
    activeProfileNames: state['activeProfileNames'],
    setupProfileNames,
    toolRoutes: state['toolRoutes'],
    running: state.running,
  }), 'utf8').catch(() => undefined);
}

export function runtimeMetadata(state: RuntimeProcessState | null): Record<string, unknown> {
  return state ? state as unknown as Record<string, unknown> : {};
}

export function shortTrayPeerId(peerId: string): string {
  return peerId.length > 12 ? `${peerId.slice(0, 8)}...${peerId.slice(-4)}` : peerId;
}

export function getTrayPeerOptions(): DashboardNetworkPeer[] {
  return getNetworkSnapshot().peers
    .filter((peer) => peer.peerId.length > 0)
    .sort((a, b) => {
      if (a.online !== b.online) return a.online ? -1 : 1;
      return (a.displayName || a.peerId).localeCompare(b.displayName || b.peerId);
    });
}

export function getTraySelectedPeer(): DashboardNetworkPeer | null {
  const state = getSystemProxyProcessState();
  const metadata = runtimeMetadata(state);
  const statePeerId = typeof metadata['peerId'] === 'string' ? metadata['peerId'] : '';
  const selectedId = statePeerId || traySystemProxyPeerId;
  return selectedId ? lookupPeer(selectedId) : null;
}

export function getTraySelectedModel(): string {
  const state = getSystemProxyProcessState();
  const metadata = runtimeMetadata(state);
  return (typeof metadata['defaultModel'] === 'string' && metadata['defaultModel'].length > 0)
    ? metadata['defaultModel']
    : traySystemProxyModel;
}

export function getTrayProfilesFromState(): Set<string> {
  const state = getSystemProxyProcessState();
  const metadata = runtimeMetadata(state);
  const active = Array.isArray(metadata['activeProfileNames'])
    ? metadata['activeProfileNames'].filter((name: unknown): name is string => typeof name === 'string')
    : [];
  return new Set(active.length > 0 ? active : traySystemProxyProfiles);
}


/** Null for terminal-only tools, which have nothing to restart. */
export function restartTargetForProfile(profileName: string): AppLaunchTarget | null {
  const launchTarget = deps().effectiveLaunchTarget(profileName);
  if (launchTarget) return launchTarget;
  const appName = allSystemProxyProfiles().find((item) => item.name === profileName)?.restartAppName;
  return appName ? namedAppTarget(appName) : null;
}

/** Restart the apps we just connected that were already running — a live app
    keeps the config and proxy settings it read at launch, so without this the
    user connects and nothing routes until they restart it themselves.
 *
 * An app we can't resolve to a launch target is the same failure wearing a
 * disguise: it keeps its pre-connect settings and nothing routes, but silently.
 * Say so in the log rather than skipping, so "connected but nothing is
 * intercepted" is traceable to the app that was never restarted. */
export async function restartConnectedApps(profileNames: string[]): Promise<void> {
  for (const profileName of profileNames) {
    const profile = allSystemProxyProfiles().find((item) => item.name === profileName);
    const label = profile?.label ?? profileName;
    const target = restartTargetForProfile(profileName);
    if (!target) {
      // Only worth flagging for apps that have something to restart at all —
      // terminal-only tools legitimately have no target.
      if (profile?.restartAppName) {
        deps().appendLog(
          'system-proxy',
          'system',
          `${label}: could not locate ${profile.restartAppName} to restart it — `
          + 'quit and reopen it so it picks up the connection, or set its path in the app settings',
        );
      }
      continue;
    }
    if (!(await isAppTargetRunning(target))) continue;
    const result = await restartAppTarget(target, {
      env: profile?.kind === 'proxy'
        ? { NODE_EXTRA_CA_CERTS: systemProxyCaPath() }
        : undefined,
    });
    deps().appendLog(
      'system-proxy',
      'system',
      result.restarted
        ? `${label}: restarted ${target.name} to apply the new connection`
        : `${label}: ${result.error ?? `could not restart ${target.name}`}`,
    );
  }
}

export function firstProbeUrl(): string | null {
  const profile = SYSTEM_PROXY_PROFILES.find((item) => item.kind === 'proxy' && item.domains.length > 0);
  const domain = profile?.domains[0];
  return domain ? `https://${domain}/` : null;
}

export async function restartTargetProcessInfo(): Promise<{ running: boolean; pid?: number; startedAt?: number }> {
  const appName = SYSTEM_PROXY_PROFILES.find((item) => item.restartAppName)?.restartAppName;
  return appName ? await getMacAppProcessInfo(appName) : { running: false };
}

export async function runGuiSystemProxyTrustProbe(): Promise<{ ok: boolean; statusCode?: number; error?: string }> {
  const url = firstProbeUrl();
  if (!url) {
    return { ok: false, error: 'No proxy-based System Proxy profiles are configured.' };
  }
  return await new Promise((resolve) => {
    const request = electronNet.request({
      method: 'GET',
      url,
    });
    let settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const finish = (result: { ok: boolean; statusCode?: number; error?: string }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    timer = setTimeout(() => {
      request.abort();
      finish({ ok: false, error: 'GUI network test timed out.' });
    }, 8_000);
    request.on('response', (response) => {
      response.on('data', () => undefined);
      response.on('end', () => finish({ ok: true, statusCode: response.statusCode }));
    });
    request.on('error', (err) => {
      finish({ ok: false, error: err.message });
    });
    request.end();
  });
}

/**
 * Windows caches Internet Settings per-process — writing the `ProxyServer`/
 * `ProxyEnable` registry values alone doesn't make already-running WinINET
 * apps (and sometimes new ones) pick up the change. This broadcasts the
 * same `InternetSetOption` refresh Control Panel's proxy UI issues.
 * Mirrors `notifyWindowsProxyChanged` in apps/cli/src/system-proxy/system-proxy.ts.
 */
export function expectsOsSystemProxy(): boolean {
  const profiles = Array.isArray(activeSystemProxyState?.['activeProfileNames'])
    ? activeSystemProxyState['activeProfileNames']
    : [];
  return profiles.some((name: unknown) => typeof name === 'string' && !isConfigPatchProfileName(name));
}

/**
 * Fail-open watchdog for the OS proxy setting.
 *
 * The quit path restores the setting, but plenty of ways out of the app never
 * reach it: the CLI child crashing or being killed from Task Manager, the app
 * being force-quit, a power cut. Any of those leaves the machine pointing at a
 * proxy that no longer exists and takes the user's whole browser offline — the
 * failure users actually report, and one they have no reason to connect back
 * to this app. So the setting is polled against a real connect to the port and
 * cleared as soon as it outlives the proxy it points at.
 */
export const SYSTEM_PROXY_WATCHDOG_INTERVAL_MS = 15_000;
let systemProxyWatchdog: ReturnType<typeof setInterval> | null = null;
/** Non-zero while a start/restart is mid-flight — the setting is legitimately
    up with nothing listening yet during that window. */
let systemProxyStartsInFlight = 0;

export function startSystemProxyWatchdog(): void {
  if (systemProxyWatchdog) return;
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  let busy = false;
  // One failed probe is not enough: a restart briefly has the setting up with
  // no listener. Only a second consecutive miss counts as a dead proxy.
  let consecutiveMisses = 0;
  systemProxyWatchdog = setInterval(() => {
    if (busy) return;
    busy = true;
    void (async () => {
      try {
        // Cheap gates first, in cost order — `isOsSystemProxyConfigured` shells
        // out to reg/networksetup synchronously, so it must not run on the
        // healthy path every tick.
        if (systemProxyStartsInFlight > 0 || !expectsOsSystemProxy()) {
          consecutiveMisses = 0;
          return;
        }
        const port = Number(activeSystemProxyState?.['port']) || DEFAULT_SYSTEM_PROXY_PORT;
        if (await canConnectToLocalPort(port)) {
          consecutiveMisses = 0;
          return;
        }
        if (!isOsSystemProxyConfigured(port)) {
          consecutiveMisses = 0;
          return;
        }
        consecutiveMisses += 1;
        if (consecutiveMisses < 2) return;
        consecutiveMisses = 0;
        deps().appendLog(
          'system-proxy',
          'system',
          `System Proxy is not listening on 127.0.0.1:${port} but the OS proxy still points at it — `
          + 'restoring the previous proxy setting so other apps keep working.',
        );
        await restoreOsSystemProxy(port);
      } catch { /* best-effort */ } finally {
        busy = false;
      }
    })();
  }, SYSTEM_PROXY_WATCHDOG_INTERVAL_MS);
  systemProxyWatchdog.unref?.();
}

export async function clearSystemProxyRuntimeFiles(): Promise<void> {
  await Promise.all([
    unlink(systemProxyPidPath()).catch(() => undefined),
    unlink(systemProxyStatePath()).catch(() => undefined),
    unlink(systemProxyDesktopStatePath()).catch(() => undefined),
  ]);
  activeSystemProxyState = null;
}

export async function clearSystemProxySettings(port = DEFAULT_SYSTEM_PROXY_PORT): Promise<void> {
  await restoreOsSystemProxy(port);
  await clearSystemProxyRuntimeFiles();
}

export async function clearSystemProxyTransportSettings(port = DEFAULT_SYSTEM_PROXY_PORT): Promise<void> {
  await restoreOsSystemProxy(port);
}

export async function stopManagedRuntimes(): Promise<void> {
  try {
    if (isMultiInstanceDevelopment()) {
      await deps().processManager.stop('system-proxy');
      await deps().processManager.stop('connect', true);
    } else {
      await deps().processManager.stopAll();
    }
  } finally {
    // Quit path: restore OS proxy settings and unpatch tool configs so
    // nothing routes through the dead proxy while the app is closed — but
    // keep system-proxy.state.json: launch reads it to reconnect the same
    // profiles automatically. Explicit disconnects go through
    // stopSystemProxyRuntime(true), which does delete it.
    if (!isMultiInstanceDevelopment() || isOsSystemProxyConfigured(DEFAULT_SYSTEM_PROXY_PORT)) {
      await clearSystemProxyTransportSettings();
    }
    if (shouldRemoveSharedConfigPatches('shutdown')) {
      await unlink(systemProxyPidPath()).catch(() => undefined);
      removeAllConfigPatches();
      await stopWslRelays();
    }
    traySystemProxyProfiles = new Set();
  }
}

export type SystemProxyStartRequest = {
  peerId: string;
  port?: number;
  profiles?: string[];
  defaultModel?: string;
  servedModels?: string[];
  toolRoutes?: Record<string, { peerId: string; model: string }>;
  profileSwitch?: boolean;
  /** Overrides the 5s default — launch restore allows a slow cold start. */
  readyTimeoutMs?: number;
  /** Set by the launch-time reconnect only: it must not count as a user
      action that takes the runtime over from the retry loop. */
  launchRestore?: boolean;
};

/**
 * Bumped by every user-driven connect or disconnect. The launch-time
 * reconnect compares it across its retries: a change means the user took
 * over the runtime while it was backing off, and the loop must stand down.
 */
let userRuntimeActions = 0;

export function routeForTool(opts: SystemProxyStartRequest, profileName: string): { peerId: string; model: string; services: string[] } {
  const route = opts.toolRoutes?.[profileName];
  const peerId = route?.peerId?.trim() || opts.peerId;
  const peer = lookupPeer(peerId);
  // For the request's own peer, merge the caller-provided served-models list
  // into the cached announcement — the renderer resolves its default model
  // from live discover rows, and a stale or differently-named cache entry
  // must not knock that model off the route (the services[0] fallback below
  // would silently re-point the buyer default at another model).
  const services = peerId === opts.peerId
    ? Array.from(new Set([...(peer?.services ?? []), ...(opts.servedModels ?? [])]))
    : peer?.services ?? [];
  const requestedModel = route?.model?.trim();
  const defaultModel = opts.defaultModel?.trim() ?? '';
  const model = route
    // Explicitly routed model is used verbatim; otherwise fall back to the
    // peer's first service, then the default model.
    ? (requestedModel || (services[0] ?? defaultModel))
    : (defaultModel && (services.length === 0 || services.includes(defaultModel))
      ? defaultModel
      : services[0] ?? defaultModel);
  return { peerId, model, services };
}

export async function startSystemProxyRuntime(opts: SystemProxyStartRequest): Promise<RuntimeProcessState | null> {
  if (!opts.launchRestore) userRuntimeActions += 1;
  systemProxyStartsInFlight += 1;
  try {
    return await startSystemProxyRuntimeInner(opts);
  } finally {
    systemProxyStartsInFlight -= 1;
  }
}

export async function startSystemProxyRuntimeInner(opts: SystemProxyStartRequest): Promise<RuntimeProcessState | null> {
  const port = opts.port ?? DEFAULT_SYSTEM_PROXY_PORT;
  const allProfiles = opts.profiles ?? [];
  const proxyProfiles = allProfiles.filter((name) => !isConfigPatchProfileName(name));
  const configPatchProfiles = allProfiles.filter((name) => isConfigPatchProfileName(name));
  const proxyRoute = proxyProfiles.length > 0 ? routeForTool(opts, proxyProfiles[0]!) : routeForTool(opts, allProfiles[0] ?? '');
  const previousProfiles = new Set(
    Array.isArray(activeSystemProxyState?.['activeProfileNames'])
      ? activeSystemProxyState['activeProfileNames'].filter((name: unknown): name is string => typeof name === 'string')
      : [...traySystemProxyProfiles],
  );
  // Only apps joining the connection get restarted below — re-applying a
  // route to already-connected apps (model switch, startup restore) must not
  // bounce them.
  const newlyConnectedProfiles = allProfiles.filter((name) => !previousProfiles.has(name));

  for (const name of previousProfiles) {
    if (allProfiles.includes(name) || !isConfigPatchProfileName(name)) continue;
    const profile = SYSTEM_PROXY_PROFILES.find((p) => p.name === name);
    if (profile?.configPatch) {
      removeConfigPatch(profile.configPatch, systemProxyWslTargetsPath());
      deps().appendLog('system-proxy', 'system', `${profile.label}: removed Antseed provider from config`);
    }
  }

  const processState = deps().processManager.getState().find((entry) => entry.mode === 'system-proxy');
  if (processState?.running) {
    await deps().processManager.stop('system-proxy');
  }
  if (proxyProfiles.length === 0) {
    await clearSystemProxyTransportSettings(port);
  }

  const buyerProxyPort = await resolveBuyerProxyPort();
  // Keep the buyer's default route on the current selection so configs that
  // carry the routed-model alias follow route changes without a rewrite.
  const defaultRoute = routeForTool(opts, '');
  await postBuyerDefaultRoute(buyerProxyPort, defaultRoute.peerId, defaultRoute.model);
  // One profile failing its install probe must not take down the rest of the
  // batch: launch restore re-applies every previously-connected profile in a
  // single call, and a connect click sends the union of the already-connected
  // profiles plus the new one. A failed profile is dropped from the active
  // set (its row must not claim Connected); only a failure of a profile this
  // call was asked to *add* is rethrown, after the survivors are fully wired.
  const failedConfigPatchProfiles = new Set<string>();
  let newProfileConnectError: Error | null = null;
  for (const name of configPatchProfiles) {
    const profile = SYSTEM_PROXY_PROFILES.find((p) => p.name === name);
    if (!profile?.configPatch) continue;
    try {
      if (profile.configPatch.format === 'claude-desktop') {
        // Claude Desktop's config points at the desktop's Claude gateway, not
        // the buyer proxy — bring it up before the patch so a gateway failure
        // fails the connect instead of leaving Claude aimed at a dead port.
        await ensureClaudeDesktopGateway(
          buyerProxyPort,
          (line) => deps().appendLog('system-proxy', 'system', line),
          path.join(systemProxyDataDir(), 'claude-gateway.slots.json'),
        );
      }
      // The patched config carries only the routed-model alias; the buyer
      // resolves it to the default route posted above, so the model picked in
      // the floating pill / AI VPN applies to running tool sessions.
      applyConfigPatch(profile.configPatch, defaultRoute.peerId, buyerProxyPort, systemProxyWslTargetsPath());
      deps().appendLog('system-proxy', 'system', `${profile.label}: connected by config patch (peer=${shortTrayPeerId(defaultRoute.peerId)}, model=${defaultRoute.model || 'auto'} via selection)`);
    } catch (err) {
      failedConfigPatchProfiles.add(name);
      const message = err instanceof Error ? err.message : String(err);
      deps().appendLog('system-proxy', 'system', `${profile.label}: connect failed — ${message}`);
      // Applied-target rows from an earlier session must not outlive the
      // failed re-apply — they would keep the relay up and claim a
      // connection the tool no longer has.
      const installProbe = (profile.configPatch as { installProbe?: unknown }).installProbe;
      if (isWslTool(installProbe)) clearWslTargetsForTool(systemProxyWslTargetsPath(), installProbe);
      if (newlyConnectedProfiles.includes(name) && !newProfileConnectError) {
        newProfileConnectError = err instanceof Error ? err : new Error(message);
      }
    }
  }
  // WSL distros patched above (if any) reach the loopback-only buyer proxy
  // through a relay on their NAT gateway address; reconcile the relays with
  // what the config patches actually wrote — including down to zero when the
  // last WSL-carrying tool was just disconnected.
  const wslTargets = readWslTargets(systemProxyWslTargetsPath());
  for (const target of wslTargets) {
    deps().appendLog('system-proxy', 'system', `WSL ${target.distro}: ${target.tool} config patched at ${target.configPath} (buyer proxy via ${target.host}:${buyerProxyPort})`);
  }
  await syncWslRelays(
    wslTargets.filter((target) => target.needsRelay).map((target) => target.host),
    buyerProxyPort,
    (line) => deps().appendLog('system-proxy', 'system', line),
  );

  let state: RuntimeProcessState | null = null;
  // A proxy that fails to come up is an outage, not a disconnect: the config
  // patches above point at the buyer proxy, not at this process, so the apps
  // they connect keep working and must keep their configs and their rows.
  // Only the proxy-routed profiles are dropped from the active set (their
  // proxy is not there), and only the transport is torn down — the OS must
  // never be left pointing at a proxy that isn't listening. Removing every
  // app config here used to turn a slow cold start or an unstable network
  // into "all apps disconnected, configs gone" (issue #1016).
  let proxyStartError: Error | null = null;
  if (proxyProfiles.length > 0) {
    state = await deps().processManager.start({
      mode: 'system-proxy',
      env: systemProxyProfilesEnv(),
      systemProxyPeerId: proxyRoute.peerId,
      systemProxyPort: opts.port,
      systemProxyProfiles: proxyProfiles,
      systemProxyDefaultModel: proxyRoute.model || undefined,
      systemProxyServedModels: proxyRoute.services,
      setSystemProxy: true,
    });
    try {
      await waitForSystemProxyReady(port, opts.readyTimeoutMs, () => (
        deps().processManager.getState().find((entry) => entry.mode === 'system-proxy')
      ));
    } catch (err) {
      proxyStartError = err instanceof Error ? err : new Error(String(err));
      state = null;
      await deps().processManager.stop('system-proxy').catch(() => undefined);
      await clearSystemProxyTransportSettings(port).catch(() => undefined);
      await unlink(systemProxyPidPath()).catch(() => undefined);
      deps().appendLog('system-proxy', 'system', `System Proxy start failed — keeping connected app configs in place: ${proxyStartError.message}`);
    }
    if (!opts.profileSwitch && !proxyStartError) {
      lastSystemProxySetupAt = Date.now();
    }
  }

  const appliedProfiles = allProfiles.filter((name) => (
    !failedConfigPatchProfiles.has(name) && (proxyStartError === null || isConfigPatchProfileName(name))
  ));
  const appliedConfigPatchProfiles = configPatchProfiles.filter((name) => !failedConfigPatchProfiles.has(name));
  // The Claude gateway only has a reason to exist while a claude-desktop
  // profile is connected — stop it on disconnect (and on connect failure, so
  // it does not linger after its profile was dropped from the active set).
  const claudeDesktopActive = appliedConfigPatchProfiles.some((name) =>
    SYSTEM_PROXY_PROFILES.find((p) => p.name === name)?.configPatch?.format === 'claude-desktop');
  if (!claudeDesktopActive) {
    await stopClaudeDesktopGateway();
  }
  traySystemProxyPeerId = opts.peerId;
  traySystemProxyModel = opts.defaultModel ?? '';
  traySystemProxyProfiles = new Set(appliedProfiles);
  refreshTrayMenu();
  const nextState = {
    ...(state ?? { mode: 'system-proxy' as const, running: appliedConfigPatchProfiles.length > 0, pid: null, startedAt: Date.now(), lastExitCode: null, lastError: null }),
    port,
    peerId: opts.peerId,
    defaultModel: opts.defaultModel,
    toolRoutes: opts.toolRoutes,
    activeProfileNames: appliedProfiles,
    running: proxyProfiles.length > 0 && !proxyStartError ? state?.running === true : appliedConfigPatchProfiles.length > 0,
  } as RuntimeProcessState & Record<string, unknown>;
  await setActiveSystemProxyState(nextState);
  // Last, so the relaunched app reads config patches already on disk and a
  // proxy already listening.
  await restartConnectedApps(newlyConnectedProfiles.filter((name) => appliedProfiles.includes(name)));
  const disconnectedProfiles = [...previousProfiles].filter((name) => !allProfiles.includes(name));
  await restartConnectedApps(disconnectedProfiles);
  if (proxyStartError) {
    // The config-patched apps are connected and persisted; the proxy the
    // rest of the batch needs is not, and that must reach the caller's UI.
    throw proxyStartError;
  }
  if (newProfileConnectError) {
    // The survivors are connected and persisted; the profile this call was
    // asked to add still failed, and that must reach the caller's UI.
    throw newProfileConnectError;
  }
  return getSystemProxyProcessState();
}

export async function restartSystemProxyRuntime(opts: SystemProxyStartRequest): Promise<RuntimeProcessState | null> {
  await deps().processManager.stop('system-proxy');
  return startSystemProxyRuntime(opts);
}

/**
 * Launch-time reconnect of the previous session's connected apps. Cold starts
 * are slow (native modules, P2P bootstrap) and a quick relaunch can find the
 * old instance still holding the port, so this allows a generous ready
 * timeout and retries. A failed start keeps the config-patched apps
 * connected but drops the proxy-routed profiles from the persisted state, so
 * if every attempt fails the full profile set is re-persisted — the next
 * launch retries instead of silently forgetting which apps were connected.
 */
export async function restoreSystemProxyProfilesAtLaunch(opts: SystemProxyStartRequest): Promise<void> {
  const persisted = readSystemProxyRuntimeMetadata();
  const owner = userRuntimeActions;
  const attempts = 3;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    // A manual connect or disconnect while we were backing off owns the
    // runtime now. (A failed attempt itself leaves the config-patched apps
    // connected and their state persisted, so a non-null state is no longer
    // a sign of user action.)
    if (attempt > 1 && userRuntimeActions !== owner) return;
    try {
      await startSystemProxyRuntime({ ...opts, readyTimeoutMs: 20_000, launchRestore: true });
      return;
    } catch (err) {
      deps().appendLog('system-proxy', 'system', `System Proxy auto-start attempt ${attempt}/${attempts} failed: ${err instanceof Error ? err.message : String(err)}`);
      if (attempt < attempts) await new Promise((resolve) => setTimeout(resolve, 3_000 * attempt));
    }
  }
  if (userRuntimeActions !== owner) return;
  await mkdir(systemProxyDataDir(), { recursive: true }).catch(() => undefined);
  await writeFile(systemProxyDesktopStatePath(), JSON.stringify(persisted), 'utf8').catch(() => undefined);
  // Reconnect is being retried next launch, not now — so the OS must not be
  // left pointing at a proxy that never came up. The profiles are remembered
  // in the state file above; the proxy setting is not part of that memory.
  await clearSystemProxyTransportSettings().catch(() => undefined);
}

export async function stopSystemProxyRuntime(clearSettings: boolean): Promise<RuntimeProcessState | null> {
  if (clearSettings) userRuntimeActions += 1;
  const metadata = readSystemProxyRuntimeMetadata();
  const setupProfileNames = knownSetupProfileNames(metadata);
  const state = await deps().processManager.stop('system-proxy');
  if (clearSettings) {
    await clearSystemProxyTransportSettings();
    await unlink(systemProxyPidPath()).catch(() => undefined);
    await unlink(systemProxyStatePath()).catch(() => undefined);
    await mkdir(systemProxyDataDir(), { recursive: true }).catch(() => undefined);
    await writeFile(systemProxyDesktopStatePath(), JSON.stringify({
      ...metadata,
      activeProfileNames: [],
      setupProfileNames,
      running: false,
    }), 'utf8').catch(() => undefined);
    if (shouldRemoveSharedConfigPatches('disconnect')) {
      removeAllConfigPatches();
    }
    await stopClaudeDesktopGateway();
    await stopWslRelays();
    traySystemProxyProfiles = new Set();
    activeSystemProxyState = null;
  }
  refreshTrayMenu();
  return withSystemProxyRuntimeMetadata(state);
}

export function openSystemProxyWindow(): void {
  const window = getMainWindow();
  if (window) {
    applyWindowView('system-proxy');
    window.webContents.send('desktop:navigate-view', 'system-proxy');
    window.show();
    window.focus();
  }
}

export function resolveTrayPeerForStart(): DashboardNetworkPeer | null {
  return getTraySelectedPeer() ?? getTrayPeerOptions().find((peer) => peer.online) ?? getTrayPeerOptions()[0] ?? null;
}

export function resolveTrayModelForPeer(peer: DashboardNetworkPeer | null): string {
  if (!peer) return '';
  const selected = getTraySelectedModel();
  return selected && peer.services.includes(selected) ? selected : peer.services[0] ?? selected;
}

export async function setTrayPeer(peerId: string): Promise<void> {
  traySystemProxyPeerId = peerId;
  const peer = lookupPeer(peerId);
  traySystemProxyModel = resolveTrayModelForPeer(peer);
  const state = getSystemProxyProcessState();
  const profiles = getTrayProfilesFromState();
  if (state?.running && profiles.size > 0) {
    await restartSystemProxyRuntime({
      peerId,
      port: DEFAULT_SYSTEM_PROXY_PORT,
      profiles: [...profiles],
      defaultModel: traySystemProxyModel || undefined,
      servedModels: peer?.services ?? [],
      profileSwitch: true,
    });
  }
  refreshTrayMenu();
}

export async function setTrayModel(model: string): Promise<void> {
  traySystemProxyModel = model;
  const peer = resolveTrayPeerForStart();
  const state = getSystemProxyProcessState();
  const profiles = getTrayProfilesFromState();
  if (state?.running && peer && profiles.size > 0) {
    await restartSystemProxyRuntime({
      peerId: peer.peerId,
      port: DEFAULT_SYSTEM_PROXY_PORT,
      profiles: [...profiles],
      defaultModel: model || undefined,
      servedModels: peer.services,
      profileSwitch: true,
    });
  }
  refreshTrayMenu();
}

export function isConfigPatchProfileName(name: string): boolean {
  return SYSTEM_PROXY_PROFILES.find((p) => p.name === name)?.kind === 'config-patch';
}

/**
 * Tell the running buyer what the routed-model alias should resolve to.
 * Best-effort: the buyer also persists the route in buyer.state.json, so a
 * missed update self-heals on the next connect or route change.
 */
export async function postBuyerDefaultRoute(buyerPort: number, peerId: string, model: string): Promise<void> {
  const service = model.trim();
  const peer = peerId.trim();
  if (!service || !/^(0x)?[0-9a-fA-F]{40}$/.test(peer)) return;
  try {
    await fetch(`http://127.0.0.1:${buyerPort}/_antseed/route`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: `${peer}@${service}` }),
      signal: AbortSignal.timeout(3_000),
    });
  } catch (err) {
    deps().appendLog('system-proxy', 'system', `Default route update failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function setTrayProfile(profileName: string, enabled: boolean): Promise<void> {
  const next = getTrayProfilesFromState();
  if (enabled) next.add(profileName);
  else next.delete(profileName);

  const state = getSystemProxyProcessState();
  traySystemProxyProfiles = next;

  const peer = resolveTrayPeerForStart();

  if (isConfigPatchProfileName(profileName)) {
    if (!peer && enabled) {
      deps().appendLog('system-proxy', 'system', 'Select a peer before connecting an app from the tray.');
      refreshTrayMenu();
      return;
    }
    if (next.size === 0) {
      await stopSystemProxyRuntime(true);
      refreshTrayMenu();
      return;
    }
    const selectedPeer = peer ?? getTraySelectedPeer();
    if (selectedPeer) {
      const model = resolveTrayModelForPeer(selectedPeer);
      traySystemProxyPeerId = selectedPeer.peerId;
      traySystemProxyModel = model;
      await startSystemProxyRuntime({
        peerId: selectedPeer.peerId,
        port: DEFAULT_SYSTEM_PROXY_PORT,
        profiles: [...next],
        defaultModel: model || undefined,
        servedModels: selectedPeer.services,
        profileSwitch: true,
      });
    }
    refreshTrayMenu();
    return;
  }

  const proxyProfiles = [...next].filter((name) => !isConfigPatchProfileName(name));
  if (proxyProfiles.length === 0) {
    if (state?.running) {
      await startSystemProxyRuntime({
        peerId: peer?.peerId ?? traySystemProxyPeerId,
        port: DEFAULT_SYSTEM_PROXY_PORT,
        profiles: [...next],
        defaultModel: peer ? resolveTrayModelForPeer(peer) || undefined : traySystemProxyModel || undefined,
        servedModels: peer?.services ?? [],
        profileSwitch: true,
      });
    }
    refreshTrayMenu();
    return;
  }

  if (!peer) {
    deps().appendLog('system-proxy', 'system', 'Select a peer before connecting an app from the tray.');
    refreshTrayMenu();
    return;
  }
  const model = resolveTrayModelForPeer(peer);
  traySystemProxyPeerId = peer.peerId;
  traySystemProxyModel = model;

  if (state?.running) {
    await restartSystemProxyRuntime({
      peerId: peer.peerId,
      port: DEFAULT_SYSTEM_PROXY_PORT,
      profiles: [...next],
      defaultModel: model || undefined,
      servedModels: peer.services,
      profileSwitch: true,
    });
  } else {
    await startSystemProxyRuntime({
      peerId: peer.peerId,
      port: DEFAULT_SYSTEM_PROXY_PORT,
      profiles: [...next],
      defaultModel: model || undefined,
      servedModels: peer.services,
    });
  }
  refreshTrayMenu();
}

export function buildSystemProxyTrayMenu(
  showMainWindow: () => void,
  openFloatingWindow: () => void,
  toggleMainConnection: () => void,
): MenuItemConstructorOptions[] {
  const running = deps().processManager.getState().some((entry) => entry.mode === 'connect' && entry.running);

  return [
    { label: `Show ${deps().appName}`, click: showMainWindow },
    { label: 'Show Floating Window', click: openFloatingWindow },
    { label: running ? 'Disconnect' : 'Connect', click: toggleMainConnection },
  ];
}

export function refreshTrayMenu(): void {
  updateDesktopTray();
}


export function getActiveSystemProxyState(): (RuntimeProcessState & Record<string, unknown>) | null {
  return activeSystemProxyState;
}

export function getLastSystemProxySetupAt(): number | null {
  return lastSystemProxySetupAt;
}

/**
 * Stamp the moment the CA/proxy setup last ran. Apps started before this are
 * considered stale and get restarted when they are connected.
 */
export function setLastSystemProxySetupAt(at: number): void {
  lastSystemProxySetupAt = at;
}
