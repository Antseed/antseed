/**
 * Where the system-proxy runtime keeps its files.
 *
 * All under the CLI's connect data dir, because the CLI child writes most of
 * them; see `state.ts` for which side owns which file.
 */
import path from 'node:path';
import { desktopSystemProxyDataDir } from '../dev-instance.js';
import { resolveConnectDataDir } from '../runtime/process-manager.js';

export function systemProxyDataDir(): string {
  const explicit = desktopSystemProxyDataDir();
  if (explicit) return explicit;
  return path.join(resolveConnectDataDir(), 'system-proxy');
}

export function systemProxyCaPath(): string {
  return path.join(systemProxyDataDir(), 'ca.crt');
}

export function systemProxyPidPath(): string {
  return path.join(systemProxyDataDir(), 'system-proxy.pid');
}

export function systemProxyStatePath(): string {
  return path.join(systemProxyDataDir(), 'system-proxy.state.json');
}

/**
 * Desktop-owned copy of the connection state. The CLI child owns
 * system-proxy.state.json — it rewrites it on boot and deletes it in its
 * graceful-shutdown handler — so the desktop's reconnect-at-launch memory
 * must live in a file the child never touches, or every clean quit forgets
 * which apps were connected.
 */
export function systemProxyDesktopStatePath(): string {
  return path.join(systemProxyDataDir(), 'system-proxy.desktop.json');
}

export function systemProxySnapshotPath(): string {
  return path.join(systemProxyDataDir(), 'system-proxy.snapshot.json');
}

/**
 * Which WSL distros the last connect patched a tool config in (see @antseed/connected-apps/wsl) —
 * kept so disconnect/quit can unpatch them and stop the relay without
 * re-running WSL discovery, which would cold-start distros.
 */
export function systemProxyWslTargetsPath(): string {
  return path.join(systemProxyDataDir(), 'system-proxy.wsl-targets.json');
}
