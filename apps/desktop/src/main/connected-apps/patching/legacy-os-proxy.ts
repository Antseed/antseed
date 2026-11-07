/**
 * One-time cleanup after the move from the system proxy to the gateway.
 *
 * Earlier releases could point the machine's HTTPS proxy at their local
 * system proxy (127.0.0.1:8378) for intercepted apps. Nothing listens there
 * any more, so a setting left behind by a crash or force-quit would take the
 * whole browser offline. At launch, restore the proxy setting saved before
 * it was changed (or switch ours off), only when it still points at us.
 *
 * macOS goes through `networksetup` per enabled network service; Windows
 * through the WinINET registry keys every browser reads, followed by a
 * settings-changed broadcast.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import path from 'node:path';
import { isWindowsProxyPointingAt, parseRegQueryValue, windowsProxyRestoreWrites } from './legacy-windows-proxy-state.js';
import { connectedAppsDataDir } from './paths.js';

/** The port earlier releases' system proxy listened on. */
const DEFAULT_SYSTEM_PROXY_PORT = 8378;

function systemProxySnapshotPath(): string {
  return path.join(connectedAppsDataDir(), 'system-proxy.snapshot.json');
}

export function getEnabledNetworkServices(): string[] {
  try {
    const out = execFileSync('networksetup', ['-listallnetworkservices'], { encoding: 'utf8' });
    const services = out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith('*') && !line.includes('denotes'));
    return services.length > 0 ? services : ['Wi-Fi'];
  } catch {
    return ['Wi-Fi'];
  }
}

/** Where WinINET keeps the per-user proxy settings every browser reads. */
export const WINDOWS_INTERNET_SETTINGS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

/**
 * Whether the Windows registry proxy actually points at our System Proxy —
 * the counterpart of `getSystemProxyServices` on Windows, and what decides
 * whether anything gets intercepted there. Read back rather than assumed: the
 * values can be overwritten after we set them, and that failure is otherwise
 * silent (traffic goes direct while the app still looks connected).
 */
export function isWindowsSystemProxyConfigured(port = DEFAULT_SYSTEM_PROXY_PORT): boolean {
  if (process.platform !== 'win32') return false;
  const read = (name: string): string | null => {
    try {
      const out = execFileSync('reg', [
        'query', WINDOWS_INTERNET_SETTINGS_KEY,
        '/v', name,
      ], { encoding: 'utf8' });
      return parseRegQueryValue(out, name);
    } catch {
      return null;
    }
  };
  return isWindowsProxyPointingAt(read('ProxyEnable'), read('ProxyServer'), port);
}

export function getSystemProxyServices(port = DEFAULT_SYSTEM_PROXY_PORT): string[] {
  if (process.platform !== 'darwin') {
    return [];
  }
  const matches: string[] = [];
  for (const service of getEnabledNetworkServices()) {
    try {
      const out = execFileSync('networksetup', ['-getsecurewebproxy', service], { encoding: 'utf8' });
      if (out.includes('Enabled: Yes') && out.includes('Server: 127.0.0.1') && out.includes(`Port: ${port}`)) {
        matches.push(service);
      }
    } catch { /* best-effort */ }
  }
  return matches;
}

export function notifyWindowsProxyChanged(): void {
  const script = [
    '$sig = \'[DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);\'',
    '$t = Add-Type -MemberDefinition $sig -Name AntseedWinInet -Namespace Antseed -PassThru',
    '$t::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null',
    '$t::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null',
  ].join('; ');
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'pipe' });
  } catch {
    // Best-effort: settings still take effect for newly-launched processes.
  }
}

export function clearOsSystemProxy(port = DEFAULT_SYSTEM_PROXY_PORT): void {
  if (process.platform === 'darwin') {
    for (const service of getEnabledNetworkServices()) {
      try {
        const out = execFileSync('networksetup', ['-getsecurewebproxy', service], { encoding: 'utf8' });
        if (!out.includes('Server: 127.0.0.1') || !out.includes(`Port: ${port}`)) {
          continue;
        }
        execFileSync('networksetup', ['-setsecurewebproxystate', service, 'off'], { stdio: 'pipe' });
      } catch { /* best-effort */ }
    }
  } else if (process.platform === 'win32') {
    try {
      // Ownership guard: only disable the proxy if it points at the Antseed proxy.
      const out = execFileSync('reg', [
        'query', WINDOWS_INTERNET_SETTINGS_KEY,
        '/v', 'ProxyServer',
      ], { encoding: 'utf8' });
      if (!out.includes(`127.0.0.1:${port}`) && !out.includes(`localhost:${port}`)) {
        return;
      }
      execFileSync('reg', [
        'add', WINDOWS_INTERNET_SETTINGS_KEY,
        '/v', 'ProxyEnable', '/t', 'REG_DWORD', '/d', '0', '/f',
      ], { stdio: 'pipe' });
      notifyWindowsProxyChanged();
    } catch { /* best-effort */ }
  }
}

export function restoreOsSystemProxySnapshot(rawSnapshot: unknown): boolean {
  if (!rawSnapshot || typeof rawSnapshot !== 'object' || Array.isArray(rawSnapshot)) return false;
  const snapshot = rawSnapshot as Record<string, unknown>;
  if (snapshot['platform'] === 'darwin') {
    const services = Array.isArray(snapshot['services']) ? snapshot['services'] : [];
    for (const rawService of services) {
      if (!rawService || typeof rawService !== 'object' || Array.isArray(rawService)) continue;
      const service = rawService as Record<string, unknown>;
      const name = typeof service['service'] === 'string' ? service['service'] : '';
      const server = typeof service['server'] === 'string' ? service['server'] : '';
      const port = typeof service['port'] === 'string' ? service['port'] : '';
      const enabled = service['enabled'] === true;
      if (!name) continue;
      try {
        if (server && port) {
          execFileSync('networksetup', ['-setsecurewebproxy', name, server, port], { stdio: 'pipe' });
        }
        execFileSync('networksetup', ['-setsecurewebproxystate', name, enabled ? 'on' : 'off'], { stdio: 'pipe' });
      } catch { /* best-effort */ }
    }
    return true;
  }
  if (snapshot['platform'] === 'win32') {
    for (const write of windowsProxyRestoreWrites(snapshot)) {
      try {
        execFileSync('reg', write.type === 'delete'
          ? ['delete', WINDOWS_INTERNET_SETTINGS_KEY, '/v', write.name, '/f']
          : ['add', WINDOWS_INTERNET_SETTINGS_KEY, '/v', write.name, '/t', write.type, '/d', write.value, '/f'],
        { stdio: 'pipe' });
      } catch {
        // A delete of an already-absent value, or a write we aren't allowed to
        // make. Keep going — the remaining writes still matter, and
        // ProxyEnable is the one that decides whether traffic flows.
      }
    }
    notifyWindowsProxyChanged();
    return true;
  }
  return false;
}

export async function restoreOsSystemProxy(port = DEFAULT_SYSTEM_PROXY_PORT): Promise<void> {
  try {
    const raw = readFileSync(systemProxySnapshotPath(), 'utf8');
    const restored = restoreOsSystemProxySnapshot(JSON.parse(raw) as unknown);
    if (restored) {
      await unlink(systemProxySnapshotPath()).catch(() => undefined);
      return;
    }
  } catch { /* no snapshot */ }
  clearOsSystemProxy(port);
}

export function isOsSystemProxyConfigured(port: number): boolean {
  if (process.platform === 'win32') return isWindowsSystemProxyConfigured(port);
  if (process.platform === 'darwin') return getSystemProxyServices(port).length > 0;
  return false;
}

/** Restores the OS proxy setting when it still points at the retired system proxy. Best-effort. */
export async function releaseLegacySystemProxy(): Promise<void> {
  try {
    if (!isOsSystemProxyConfigured(DEFAULT_SYSTEM_PROXY_PORT)) return;
    await restoreOsSystemProxy(DEFAULT_SYSTEM_PROXY_PORT);
  } catch {
    // Best-effort: the user can still switch the proxy off in system settings.
  }
}
