/**
 * The desktop's connected-apps memory, shared so the CLI can keep it in step.
 *
 * The desktop persists which apps are connected in
 * `<dataDir>/system-proxy/system-proxy.desktop.json` (`activeProfileNames`:
 * connected now, `setupProfileNames`: ever connected). It reads that file at
 * launch and whenever it has no in-memory connection state, falling back to
 * the CLI child's `system-proxy.state.json` exactly as below. `antseed apps
 * connect|disconnect` update the same file so the Connected apps screen shows
 * what the CLI changed. Only the two name lists are touched;
 * every other field the desktop wrote is carried through untouched.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

export const SYSTEM_PROXY_DIR_NAME = 'system-proxy';
export const DESKTOP_STATE_FILE_NAME = 'system-proxy.desktop.json';
export const CLI_STATE_FILE_NAME = 'system-proxy.state.json';
export const WSL_TARGETS_FILE_NAME = 'system-proxy.wsl-targets.json';

/** `<dataDir>/system-proxy`, the directory the desktop keeps these files in. */
export function connectedAppsStateDir(dataDir: string): string {
  return path.join(dataDir, SYSTEM_PROXY_DIR_NAME);
}

export function desktopStatePath(dataDir: string): string {
  return path.join(connectedAppsStateDir(dataDir), DESKTOP_STATE_FILE_NAME);
}

/** Shared applied-WSL-targets memory (see wsl.ts), so either side can unpatch
    the distros the other one patched. */
export function wslTargetsPath(dataDir: string): string {
  return path.join(connectedAppsStateDir(dataDir), WSL_TARGETS_FILE_NAME);
}

export type ConnectedAppsState = Record<string, unknown> & {
  activeProfileNames: string[];
  setupProfileNames: string[];
};

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function readJsonObject(filePath: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** Same source order as the desktop: its own file, then the CLI child's. */
export function readConnectedAppsState(dataDir: string): ConnectedAppsState {
  const dir = connectedAppsStateDir(dataDir);
  const metadata = readJsonObject(path.join(dir, DESKTOP_STATE_FILE_NAME))
    ?? readJsonObject(path.join(dir, CLI_STATE_FILE_NAME))
    ?? {};
  const activeProfileNames = readStringArray(metadata['activeProfileNames']);
  return {
    ...metadata,
    activeProfileNames,
    // State files written before setupProfileNames existed still count their
    // connected apps as set up (mirrors the desktop's knownSetupProfileNames).
    setupProfileNames: Array.from(new Set([...readStringArray(metadata['setupProfileNames']), ...activeProfileNames])),
  };
}

function writeConnectedAppsState(dataDir: string, state: ConnectedAppsState): void {
  mkdirSync(connectedAppsStateDir(dataDir), { recursive: true });
  writeFileSync(desktopStatePath(dataDir), JSON.stringify(state), 'utf8');
}

/**
 * Record `profileName` as connected (and set up). `running` and every other
 * field are left as the desktop wrote them — the desktop recomputes its
 * runtime flags from the profile lists at launch. Returns the new state.
 */
export function markProfileConnected(dataDir: string, profileName: string): ConnectedAppsState {
  const state = readConnectedAppsState(dataDir);
  if (state.activeProfileNames.includes(profileName) && state.setupProfileNames.includes(profileName)) return state;
  const next: ConnectedAppsState = {
    ...state,
    activeProfileNames: [...state.activeProfileNames.filter((name) => name !== profileName), profileName],
    setupProfileNames: Array.from(new Set([...state.setupProfileNames, profileName])),
  };
  writeConnectedAppsState(dataDir, next);
  return next;
}

/**
 * Record `profileName` as disconnected. It stays in setupProfileNames (it
 * has been set up before), matching the desktop's own disconnect. A profile
 * that was not active leaves the file untouched.
 */
export function markProfileDisconnected(dataDir: string, profileName: string): ConnectedAppsState {
  const state = readConnectedAppsState(dataDir);
  if (!state.activeProfileNames.includes(profileName)) return state;
  const next: ConnectedAppsState = {
    ...state,
    activeProfileNames: state.activeProfileNames.filter((name) => name !== profileName),
  };
  writeConnectedAppsState(dataDir, next);
  return next;
}
