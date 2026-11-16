/**
 * Where the connected-apps runtime keeps its files: under the connect data
 * dir's `system-proxy/` folder, where earlier releases (which also ran a
 * system proxy) kept them — so existing installs keep their WSL targets,
 * the retired Claude Desktop slot file, and the list of apps to migrate.
 */
import path from 'node:path';
import { desktopSystemProxyDataDir } from '../../dev-instance.js';
import { resolveConnectDataDir } from '../../runtime/process-manager.js';

export function connectedAppsDataDir(): string {
  const explicit = desktopSystemProxyDataDir();
  if (explicit) return explicit;
  return path.join(resolveConnectDataDir(), 'system-proxy');
}

/** Which apps are connected; reconnected (re-patched) at every launch. */
export function connectedAppsStatePath(): string {
  return path.join(connectedAppsDataDir(), 'connected-apps.json');
}

/** The connection memory of releases that ran a system proxy, read once to migrate their connected apps. */
export function legacyDesktopStatePath(): string {
  return path.join(connectedAppsDataDir(), 'system-proxy.desktop.json');
}

/**
 * Which WSL distros the last connect patched a tool config in (see @antseed/connected-apps/wsl) —
 * kept so disconnect/quit can unpatch them and stop the relay without
 * re-running WSL discovery, which would cold-start distros.
 */
export function connectedAppsWslTargetsPath(): string {
  return path.join(connectedAppsDataDir(), 'system-proxy.wsl-targets.json');
}

/** Where the retired Claude Desktop shim kept its model slots; only deleted now. */
export function claudeGatewaySlotsPath(): string {
  return path.join(connectedAppsDataDir(), 'claude-gateway.slots.json');
}

/** Apps only the desktop stopped connecting whose cleanup hasn't succeeded yet; retried at launch. */
export function retiredAppsPendingPath(): string {
  return path.join(connectedAppsDataDir(), 'retired-apps-pending.json');
}
