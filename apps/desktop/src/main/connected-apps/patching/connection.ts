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
import { finishConfigPatch, isConfigPatchConnected, removeConfigPatch, writeConfigPatch, type ConfigPatchDef, type ConfigPatchTarget } from '@antseed/connected-apps/config-patch';
import { RETIRED_APP_PROFILES } from '@antseed/connected-apps/defaults';
import { readWslTargets } from '@antseed/connected-apps/wsl';
import type { AppLaunchTarget } from '../launch-settings.js';
import { isAppTargetRunning, namedAppTarget, restartAppTarget } from '../launcher.js';
import { isMultiInstanceDevelopment } from '../../dev-instance.js';
import { machineWideChangesDisabled } from '../../runtime/attach-only.js';
import type { RuntimeMode } from '../../runtime/process-manager.js';
import { getGatewayEndpoint, localGatewayOrigin, type GatewayEndpoint } from '../../gateway/service.js';
import { patchesComeOffAtQuit, relayTarget } from './relay-target.js';
import { createSerialQueue } from '../../serial-queue.js';
import { fetchGatewayModelEntries } from '../../gateway/models.js';
import { appModelsReader, type AppModels } from './app-models.js';
import { getGatewaySettings } from '../../gateway/settings.js';
import {
  claudeGatewaySlotsPath,
  connectedAppsDataDir,
  connectedAppsStatePath,
  connectedAppsWslTargetsPath,
  legacyDesktopStatePath,
  retiredAppsPendingPath,
} from './paths.js';
import { migrateRetiredApps, retiredMigrationStore } from './retired-migration.js';
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
const queue = createSerialQueue();

export function initConnectedApps(deps: ConnectedAppsDeps): void {
  injected = deps;
  connected = readConnectedNames();
  removeRetiredAppPatches();
}

/**
 * Apps Antseed no longer connects (Claude Desktop): an earlier version may
 * have pointed them at Antseed, so restore their config at launch. Apps only
 * the desktop stopped connecting are restored once, on the first launch after
 * the update, so a later `antseed apps connect` isn't undone by opening the app.
 */
function removeRetiredAppPatches(): void {
  // A testbench desktop shares the developer's apps, and never edits them.
  if (machineWideChangesDisabled()) return;
  const firstLaunchAfterUpdate = !existsSync(connectedAppsStatePath());
  const cleanUp = (profile: { label: string; configPatch?: ConfigPatchDef }): void => {
    if (!profile.configPatch) return;
    try {
      if (!isConfigPatchConnected(profile.configPatch, connectedAppsWslTargetsPath())) return;
      removeConfigPatch(profile.configPatch, connectedAppsWslTargetsPath());
      log(`${profile.label}: no longer supported — removed Antseed from its config`);
    } catch (err) {
      log(`${profile.label}: could not remove Antseed from its config: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  };
  for (const [index, raw] of RETIRED_APP_PROFILES.entries()) {
    try { cleanUp(normalizeDesktopSystemProxyProfile(raw, index)); } catch { /* retried at every launch anyway */ }
  }
  // Retried at later launches until it succeeds; an install that already
  // passed its first launch before this list existed has nothing pending.
  const store = retiredMigrationStore(retiredAppsPendingPath());
  if (!firstLaunchAfterUpdate && store.read() === null) store.write([]);
  migrateRetiredApps({
    store,
    firstLaunchNames: () => retiredDesktopProfiles(readLegacyDesktopConnected()).map((profile) => profile.name),
    cleanUp: (name) => {
      const profile = retiredDesktopProfiles([name])[0];
      if (profile) cleanUp(profile);
    },
  });
  rmSync(claudeGatewaySlotsPath(), { force: true });
  if (firstLaunchAfterUpdate) void persist();
}

function deps(): ConnectedAppsDeps {
  if (!injected) throw new Error('connected-apps runtime used before initConnectedApps()');
  return injected;
}

function log(line: string): void {
  deps().appendLog('gateway', 'system', line);
}

/** Set at quit: nothing may patch an app's config after its patch came out. */
let shuttingDown = false;
const SHUTDOWN_WAIT_MS = 5_000;

function serialized<T>(task: () => Promise<T>): Promise<T> {
  return queue.run(async () => {
    if (shuttingDown) throw new Error('Antseed Desktop is closing');
    return task();
  });
}

/** The apps the old system-proxy desktop had connected, as its saved state lists them. */
function readLegacyDesktopConnected(): string[] {
  try {
    return readStringArray((JSON.parse(readFileSync(legacyDesktopStatePath(), 'utf8')) as Record<string, unknown>)['activeProfileNames']);
  } catch {
    return [];
  }
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

function patchTarget(endpoint: GatewayEndpoint, { models, recommended }: AppModels): ConfigPatchTarget {
  return {
    origin: endpoint.origin,
    apiKey: endpoint.apiKey,
    models: models.map((model) => ({ id: model.id, label: model.label, ...(model.reasoning ? { reasoning: true } : {}) })),
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
async function patchApp(name: string, modelsFor: (endpoint: GatewayEndpoint) => Promise<AppModels>): Promise<void> {
  const profile = findConnectableProfile(name);
  if (!profile?.configPatch) throw new Error(`Unknown app: ${name}`);
  const endpoint = await getGatewayEndpoint({ name, label: profile.label });
  // Per-app keys can have their own policy, so the list must be the one this key sees.
  const models = await modelsFor(endpoint);
  // The awaits above may have spanned the start of quit.
  if (shuttingDown) throw new Error('Antseed Desktop is closing');
  // A failed write keeps the WSL rows: a distro patched before the failure
  // holds the gateway URL and key, and disconnect has to find it.
  const target = patchTarget(endpoint, models);
  writeConfigPatch(profile.configPatch, target, connectedAppsWslTargetsPath());
  // Codex's model catalog runs Codex itself: awaited here, off the main
  // thread, and dropped if quit starts before it lands.
  await finishConfigPatch(profile.configPatch, target, { isCurrent: () => !shuttingDown });
  log(`${profile.label}: connected to the gateway at ${endpoint.origin}`);
}

/** WSL distros reach a gateway on this computer's loopback through a relay; one elsewhere needs none. */
async function syncRelays(): Promise<void> {
  const settings = getGatewaySettings();
  const target = relayTarget(settings.mode === 'local' ? localGatewayOrigin() : settings.remoteUrl);
  if (!target) {
    await stopWslRelays();
    return;
  }
  const hosts = readWslTargets(connectedAppsWslTargetsPath()).filter((wsl) => wsl.needsRelay).map((wsl) => wsl.host);
  await syncWslRelays(hosts, target.port, log, target.upstreamHost);
}

/**
 * Applies `names`. Failures are recorded per app; if `requiredApp` (the one the
 * caller is adding) fails, it is rethrown after the rest are wired, so the
 * click that asked for it sees the error.
 */
async function applyPatches(names: string[], requiredApp?: string, options: { freshModels?: boolean } = {}): Promise<void> {
  const modelsFor = appModelsReader(options, { fetchEntries: fetchGatewayModelEntries, log });
  let addError: Error | null = null;
  for (const name of names) {
    try {
      await patchApp(name, modelsFor);
      delete errors[name];
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors[name] = message;
      log(`${findConnectableProfile(name)?.label ?? name}: connect failed — ${message}`);
      if (name === requiredApp) addError = err instanceof Error ? err : new Error(message);
    }
  }
  await syncRelays();
  connectedAt = Date.now();
  if (addError) throw addError;
}

/** A testbench desktop runs next to the developer's own: it never edits their apps' configs. */
const TESTBENCH_APPS_DISABLED = 'Connected-app changes are disabled in the isolated testbench desktop.';

export function connectApp(name: string): Promise<ConnectedAppsState> {
  return serialized(async () => {
    if (machineWideChangesDisabled()) throw new Error(TESTBENCH_APPS_DISABLED);
    if (!findConnectableProfile(name)) throw new Error(`Unknown app: ${name}`);
    const isNew = !connected.includes(name);
    if (isNew) connected = [...connected, name];
    try {
      await applyPatches([name], name);
    } catch (err) {
      // A write that landed before the failure (the native config, one WSL
      // distro) stays connected, with its error, so Disconnect can take it out.
      if (isNew && !partlyPatched(name)) connected = connected.filter((entry) => entry !== name);
      throw err;
    } finally {
      await persist();
    }
    if (isNew) await restartApps([name]);
    return getConnectedAppsState();
  });
}

/** Whether any of the app's config already carries the patch (a connect that failed partway). */
function partlyPatched(name: string): boolean {
  const patch = findConnectableProfile(name)?.configPatch;
  if (!patch) return false;
  try {
    return isConfigPatchConnected(patch, connectedAppsWslTargetsPath());
  } catch {
    // Can't tell: keep it, so Disconnect can still try.
    return true;
  }
}

export function disconnectApp(name: string): Promise<ConnectedAppsState> {
  return serialized(async () => {
    const profile = findConnectableProfile(name);
    // It stays connected until its config is clean: otherwise it would keep using
    // the gateway with no Disconnect left to offer.
    if (profile?.configPatch) {
      try {
        removeConfigPatch(profile.configPatch, connectedAppsWslTargetsPath());
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors[name] = message;
        log(`${profile.label}: disconnect failed — ${message}`);
        await persist();
        throw err;
      }
      log(`${profile.label}: removed the Antseed gateway from its config`);
    }
    connected = connected.filter((entry) => entry !== name);
    delete errors[name];
    await persist();
    await syncRelays();
    await restartApps([name]);
    return getConnectedAppsState();
  });
}

/**
 * Re-applies every connected app: at launch, and after the gateway, its key,
 * the key mode or the privacy mode changed. `restart` bounces running apps so
 * they read the new address or key (not needed for a launch-time restore of
 * the same one, or for a new model list on the same key). `freshModels` reads
 * the model list past its cache, which a read that began under the old
 * routing policy may have filled.
 */
export function reconnectAllApps(options: { restart?: boolean; freshModels?: boolean } = {}): Promise<ConnectedAppsState> {
  return serialized(async () => {
    if (connected.length === 0 || machineWideChangesDisabled()) return getConnectedAppsState();
    await applyPatches(connected, undefined, { freshModels: options.freshModels === true });
    await persist();
    if (options.restart) await restartApps(connected);
    return getConnectedAppsState();
  });
}

/** After a quit that didn't happen (an update that failed to install): patches may be written again. */
export function resumeConnectedAppsAfterAbortedQuit(): void {
  shuttingDown = false;
}

/** Quit path. A local gateway stops with the desktop, so its patches come out; a remote one keeps them. */
export async function releaseConnectedAppsOnQuit(): Promise<void> {
  shuttingDown = true;
  // Work already running finishes first; shutting down stops it writing more.
  await Promise.race([
    queue.whenSettled(),
    new Promise((resolve) => { setTimeout(resolve, SHUTDOWN_WAIT_MS).unref?.(); }),
  ]);
  try {
    const settings = getGatewaySettings();
    const relayedInWsl = readWslTargets(connectedAppsWslTargetsPath()).some((target) => target.needsRelay);
    if (patchesComeOffAtQuit(settings, relayedInWsl) && !isMultiInstanceDevelopment() && !machineWideChangesDisabled()) {
      removeAllConfigPatches(log);
    }
  } finally {
    await stopWslRelays();
  }
}

/** Every built-in profile, for listing in the Apps view. */
export function listConnectableProfiles() {
  return connectableProfiles();
}
