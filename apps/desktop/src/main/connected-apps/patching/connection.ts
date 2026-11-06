/**
 * Connected apps: each app's own config file points at the gateway with an
 * API key, and lists the gateway's models so the user picks one inside the
 * app. Nothing is intercepted and no OS proxy is touched.
 *
 * Which apps are connected is remembered in connected-apps.json. With a
 * local gateway the patches are removed on quit (the gateway stops with the
 * desktop, and an app pointed at a dead port only fails confusingly) and
 * re-applied at launch; a remote gateway keeps serving while the desktop is
 * closed, so its patches stay.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { isConfigPatchConnected, removeConfigPatch, writeConfigPatch, type ConfigPatchTarget } from '@antseed/connected-apps/config-patch';
import { RETIRED_APP_PROFILES } from '@antseed/connected-apps/defaults';
import { clearWslTargetsForTool, isWslTool, readWslTargets } from '@antseed/connected-apps/wsl';
import type { AppLaunchTarget } from '../launch-settings.js';
import { isAppTargetRunning, namedAppTarget, restartAppTarget } from '../launcher.js';
import { isMultiInstanceDevelopment } from '../../dev-instance.js';
import type { RuntimeMode } from '../../runtime/process-manager.js';
import { DEFAULT_LOCAL_GATEWAY_PORT } from '../../runtime/process-manager.js';
import { getGatewayEndpoint, type GatewayEndpoint } from '../../gateway/service.js';
import { fetchGatewayModelEntries, toGatewayModel, type GatewayModel } from '../../gateway/models.js';
import { recommendAppModels, toChatModels, type ChatModel } from '../../chat/gateway-model.js';
import { getGatewaySettings } from '../../gateway/settings.js';
import {
  claudeGatewaySlotsPath,
  connectedAppsDataDir,
  connectedAppsStatePath,
  connectedAppsWslTargetsPath,
  legacyDesktopStatePath,
} from './paths.js';
import { connectableProfiles, findConnectableProfile, normalizeDesktopSystemProxyProfile, readStringArray, removeAllConfigPatches, retiredDesktopProfiles } from './profiles.js';
import { stopWslRelays, syncWslRelays } from './wsl-relay.js';

export type ConnectedAppsDeps = {
  appendLog: (mode: RuntimeMode, stream: 'stdout' | 'stderr' | 'system', line: string) => void;
  effectiveLaunchTarget: (profileName: string) => AppLaunchTarget | null;
};

export type ConnectedAppsState = {
  connected: string[];
  /** App name → last connect error, for apps that failed to (re)connect. */
  errors: Record<string, string>;
  /** When the last successful connect ran; apps started before it may need a restart. */
  connectedAt: number | null;
};

let injected: ConnectedAppsDeps | null = null;
let connected: string[] = [];
let errors: Record<string, string> = {};
let connectedAt: number | null = null;
/** Serializes connects so concurrent clicks don't interleave config writes. */
let queue: Promise<unknown> = Promise.resolve();

export function initConnectedApps(deps: ConnectedAppsDeps): void {
  injected = deps;
  connected = readConnectedNames();
  removeRetiredAppPatches();
}

/**
 * Apps Antseed no longer connects (Claude Desktop): an earlier version may
 * have pointed them at Antseed, so restore their config once, at launch.
 */
function removeRetiredAppPatches(): void {
  const retired = [
    ...RETIRED_APP_PROFILES.map((raw, index) => normalizeDesktopSystemProxyProfile(raw, index)),
    ...retiredDesktopProfiles(),
  ];
  retired.forEach((profile) => {
    if (!profile.configPatch) return;
    try {
      if (!isConfigPatchConnected(profile.configPatch, connectedAppsWslTargetsPath())) return;
      removeConfigPatch(profile.configPatch, connectedAppsWslTargetsPath());
      log(`${profile.label}: no longer supported — removed Antseed from its config`);
    } catch (err) {
      log(`${profile.label}: could not remove Antseed from its config: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
  rmSync(claudeGatewaySlotsPath(), { force: true });
}

function deps(): ConnectedAppsDeps {
  if (!injected) throw new Error('connected-apps runtime used before initConnectedApps()');
  return injected;
}

function log(line: string): void {
  deps().appendLog('gateway', 'system', line);
}

function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

/** connected-apps.json, else (first launch after the update) the config-patched apps the old system-proxy state had connected. */
function readConnectedNames(): string[] {
  const known = new Set(connectableProfiles().map((profile) => profile.name));
  for (const [file, field] of [[connectedAppsStatePath(), 'connected'], [legacyDesktopStatePath(), 'activeProfileNames']] as const) {
    if (!existsSync(file)) continue;
    try {
      const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>;
      return readStringArray(parsed[field]).filter((name) => known.has(name));
    } catch {
      // Unreadable — try the next source.
    }
  }
  return [];
}

async function persist(): Promise<void> {
  await mkdir(connectedAppsDataDir(), { recursive: true }).catch(() => undefined);
  await writeFile(connectedAppsStatePath(), JSON.stringify({ connected }, null, 2), 'utf8').catch(() => undefined);
}

export function getConnectedAppsState(): ConnectedAppsState {
  return { connected: [...connected], errors: { ...errors }, connectedAt };
}

/** Text models for the apps, plus the ones worth defaulting to. */
type AppModels = {
  models: GatewayModel[];
  /** Best first: free for everyone, then able to use tools, then the most sellers. */
  recommended: ChatModel[];
};

function patchTarget(endpoint: GatewayEndpoint, { models, recommended }: AppModels): ConfigPatchTarget {
  return {
    origin: endpoint.origin,
    apiKey: endpoint.apiKey,
    models: models.map((model) => ({ id: model.id, label: model.label })),
    // An app without a model of its own starts on one that works without
    // funds; a model the user picked inside the app is kept.
    ...(recommended[0] ? { defaultModel: recommended[0].id } : {}),
  };
}


/** Null for terminal-only tools, which have nothing to restart. */
function restartTarget(profileName: string): AppLaunchTarget | null {
  const launchTarget = deps().effectiveLaunchTarget(profileName);
  if (launchTarget) return launchTarget;
  const appName = findConnectableProfile(profileName)?.restartAppName;
  return appName ? namedAppTarget(appName) : null;
}

/** A running app keeps the config it read at launch; restart the ones whose connection just changed. */
async function restartApps(profileNames: string[]): Promise<void> {
  for (const name of profileNames) {
    const profile = findConnectableProfile(name);
    const target = restartTarget(name);
    if (!target) {
      if (profile?.restartAppName) {
        log(`${profile.label}: could not locate ${profile.restartAppName} to restart it — quit and reopen it so it picks up the change`);
      }
      continue;
    }
    if (!(await isAppTargetRunning(target))) continue;
    const result = await restartAppTarget(target);
    log(result.restarted
      ? `${profile?.label ?? name}: restarted ${target.name} to apply the change`
      : `${profile?.label ?? name}: ${result.error ?? `could not restart ${target.name}`}`);
  }
}

/** Patches one app; throws on failure. */
async function patchApp(name: string, models: AppModels): Promise<void> {
  const profile = findConnectableProfile(name);
  if (!profile?.configPatch) throw new Error(`Unknown app: ${name}`);
  const endpoint = await getGatewayEndpoint({ name, label: profile.label });
  try {
    writeConfigPatch(profile.configPatch, patchTarget(endpoint, models), connectedAppsWslTargetsPath());
  } catch (err) {
    // Applied-target rows from an earlier session must not outlive a failed
    // re-apply — they would keep the relay up for a tool no longer patched.
    const installProbe = (profile.configPatch as { installProbe?: unknown }).installProbe;
    if (isWslTool(installProbe)) clearWslTargetsForTool(connectedAppsWslTargetsPath(), installProbe);
    throw err;
  }
  log(`${profile.label}: connected to the gateway at ${endpoint.origin}`);
}

/** WSL distros reach the loopback-only local gateway through a relay; a remote gateway needs none. */
async function syncRelays(): Promise<void> {
  if (getGatewaySettings().mode !== 'local') {
    await stopWslRelays();
    return;
  }
  const targets = readWslTargets(connectedAppsWslTargetsPath()).filter((target) => target.needsRelay);
  await syncWslRelays(targets.map((target) => target.host), DEFAULT_LOCAL_GATEWAY_PORT, log);
}

async function textModels(): Promise<AppModels> {
  try {
    const entries = await fetchGatewayModelEntries(await getGatewayEndpoint());
    const models = entries.map(toGatewayModel).filter((model) => model.type === null || model.type === 'text');
    return { models, recommended: recommendAppModels(toChatModels(entries)) };
  } catch (err) {
    log(`Could not load the gateway's models; apps get the address and key only: ${err instanceof Error ? err.message : String(err)}`);
    return { models: [], recommended: [] };
  }
}

/**
 * Applies `names` (all connected apps when omitted). Failures are recorded per
 * app; an app the caller is adding that fails is rethrown after the rest are
 * wired, so the click that asked for it sees the error.
 */
async function applyPatches(names: string[], adding: string[] = []): Promise<void> {
  const models = await textModels();
  let addError: Error | null = null;
  for (const name of names) {
    try {
      await patchApp(name, models);
      delete errors[name];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors[name] = message;
      log(`${findConnectableProfile(name)?.label ?? name}: connect failed — ${message}`);
      if (adding.includes(name) && !addError) addError = err instanceof Error ? err : new Error(message);
    }
  }
  await syncRelays();
  connectedAt = Date.now();
  if (addError) throw addError;
}

export function connectApp(name: string): Promise<ConnectedAppsState> {
  return serialized(async () => {
    if (!findConnectableProfile(name)) throw new Error(`Unknown app: ${name}`);
    const isNew = !connected.includes(name);
    if (isNew) connected = [...connected, name];
    try {
      await applyPatches([name], [name]);
    } catch (err) {
      if (isNew) connected = connected.filter((entry) => entry !== name);
      throw err;
    } finally {
      await persist();
    }
    if (isNew) await restartApps([name]);
    return getConnectedAppsState();
  });
}

export function disconnectApp(name: string): Promise<ConnectedAppsState> {
  return serialized(async () => {
    const profile = findConnectableProfile(name);
    connected = connected.filter((entry) => entry !== name);
    delete errors[name];
    await persist();
    if (profile?.configPatch) {
      removeConfigPatch(profile.configPatch, connectedAppsWslTargetsPath());
      log(`${profile.label}: removed the Antseed gateway from its config`);
    }
    await syncRelays();
    await restartApps([name]);
    return getConnectedAppsState();
  });
}

/**
 * Re-applies every connected app: at launch, and after the gateway, its key
 * or the key mode changed. `restart` bounces running apps so they read the
 * new address or key (not needed for a launch-time restore of the same one).
 */
export function reconnectAllApps(options: { restart?: boolean } = {}): Promise<ConnectedAppsState> {
  return serialized(async () => {
    if (connected.length === 0) return getConnectedAppsState();
    await applyPatches(connected);
    await persist();
    if (options.restart) await restartApps(connected);
    return getConnectedAppsState();
  });
}

/** Quit path. A local gateway stops with the desktop, so its patches come out; a remote one keeps them. */
export async function releaseConnectedAppsOnQuit(): Promise<void> {
  if (getGatewaySettings().mode === 'local' && !isMultiInstanceDevelopment()) {
    removeAllConfigPatches();
  }
  await stopWslRelays();
}

/** Every built-in profile, for listing in the Apps view. */
export function listConnectableProfiles() {
  return connectableProfiles();
}
