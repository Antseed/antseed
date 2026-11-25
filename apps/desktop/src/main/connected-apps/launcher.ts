/**
 * Starting, stopping and restarting the desktop applications attached to app
 * profiles.
 *
 * Connecting a running app to the proxy needs it restarted to pick up the new
 * settings, and "restart" means something different per platform and per app
 * kind — a Chromium app spawns its renderer only once a window exists, an
 * `open -a` target has no bundle path at all. Those distinctions live here.
 */
import { shell } from 'electron';
import { execFile, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { AppLaunchTarget } from './launch-settings.js';
import { launchAppTarget, listInstalledApplications } from './installed.js';
import { APPS_FOLDER_PREFIX, isAppsFolderTarget } from './windows-start-menu.js';
import { runningAppNeedsRestart } from './patching/config-changes.js';
export type AppProcessInfo = { running: boolean; pid?: number; startedAt?: number };

type ManagedAppProcess = { launchedAt: number; pid?: number; startedAt?: number };

const managedAppProcesses = new Map<string, ManagedAppProcess>();
const windowsPackagedExecutables = new Map<string, string>();

const execFileAsync = promisify(execFile);

/** How long a cached process check may serve the renderer's status polls.
    Restart flows always query fresh — see `appTargetProcessInfo`. */
const PROCESS_INFO_TTL_MS = 2_000;
const processInfoCache = new Map<string, { at: number; info: AppProcessInfo }>();

async function runCommand(
  command: string,
  args: string[],
  opts: { windowsHide?: boolean } = {},
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, args, { encoding: 'utf8', ...opts });
    return stdout;
  } catch {
    return null;
  }
}

async function macProcessInfoByPgrep(pgrepArgs: string[]): Promise<AppProcessInfo> {
  const raw = await runCommand('pgrep', pgrepArgs);
  const pid = Number(raw?.trim().split('\n')[0]?.trim());
  if (!Number.isFinite(pid) || pid <= 0) {
    return { running: false };
  }
  const startRaw = await runCommand('ps', ['-p', String(pid), '-o', 'lstart=']);
  const startedAt = startRaw ? Date.parse(startRaw.trim()) : NaN;
  return { running: true, pid, ...(Number.isFinite(startedAt) ? { startedAt } : {}) };
}

function appTargetKey(target: AppLaunchTarget): string {
  return `${target.name}\u0000${target.path}`;
}

export async function getMacAppProcessInfo(appName: string): Promise<AppProcessInfo> {
  if (process.platform !== 'darwin') {
    return { running: false };
  }
  return macProcessInfoByPgrep(['-x', appName]);
}

export function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function windowsExecutablePath(targetPath: string): string | null {
  if (process.platform !== 'win32') return null;
  if (path.extname(targetPath).toLowerCase() === '.exe') return targetPath;
  if (isAppsFolderTarget(targetPath)) {
    const cached = windowsPackagedExecutables.get(targetPath);
    if (cached) return cached;
    const appId = targetPath.slice(APPS_FOLDER_PREFIX.length);
    try {
      const executable = execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          `$id = '${appId.replace(/'/g, "''")}'; $app = Get-AppxPackage | ForEach-Object { $package = $_; try { Get-AppxPackageManifest -Package $package | ForEach-Object { $manifest = $_; $manifest.Package.Applications.Application | Where-Object { ($package.PackageFamilyName + '!' + $_.Id) -eq $id } | ForEach-Object { Join-Path $package.InstallLocation $_.Executable } } } catch {} } | Select-Object -First 1; if ($app) { $app }`,
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
      ).trim();
      if (!executable || path.extname(executable).toLowerCase() !== '.exe') return null;
      windowsPackagedExecutables.set(targetPath, executable);
      return executable;
    } catch {
      return null;
    }
  }
  if (!targetPath.toLowerCase().endsWith('.lnk')) return null;
  try {
    const shortcut = shell.readShortcutLink(targetPath);
    const processStart = /--processStart(?:=|\s+)(?:"([^"]+)"|'([^']+)'|(\S+))/i.exec(shortcut.args ?? '')?.slice(1).find(Boolean);
    if (processStart && path.extname(processStart).toLowerCase() === '.exe') return processStart;
    return shortcut.target && path.extname(shortcut.target).toLowerCase() === '.exe' ? shortcut.target : null;
  } catch {
    return null;
  }
}

async function queryAppTargetProcessInfo(target: AppLaunchTarget): Promise<AppProcessInfo> {
  if (process.platform === 'darwin') {
    if (!target.path.endsWith('.app')) return getMacAppProcessInfo(target.name);
    return macProcessInfoByPgrep(['-f', escapeRegExpLiteral(`${target.path}/Contents/MacOS/`)]);
  }
  if (process.platform === 'win32') {
    const executable = windowsExecutablePath(target.path);
    if (!executable) return { running: false };
    const out = await runCommand(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `$p = Get-Process -Name '${path.basename(executable, '.exe').replace(/'/g, "''")}' -ErrorAction SilentlyContinue | Select-Object -First 1; if ($p) { $p.Id.ToString() + '|' + $p.StartTime.ToUniversalTime().ToString('o') }`],
      { windowsHide: true },
    );
    const [pidText, startedText] = (out ?? '').trim().split('|');
    const pid = Number(pidText);
    const startedAt = startedText ? Date.parse(startedText) : NaN;
    return Number.isFinite(pid) && pid > 0
      ? { running: true, pid, ...(Number.isFinite(startedAt) ? { startedAt } : {}) }
      : { running: false };
  }
  return { running: false };
}

/** Whether the application behind a launch target has a live process. macOS
    matches the bundle's executable directory, so an Electron app's helper
    processes count; Windows matches the executable image name, and a `.lnk`
    shortcut carries no resolvable image so it reads as not running.

    `maxAgeMs` lets polled callers accept a recent cached answer instead of
    spawning `pgrep`/`ps` on every tick; omit it wherever staleness would be
    observable, like the restart wait loops. */
export async function appTargetProcessInfo(
  target: AppLaunchTarget,
  opts: { maxAgeMs?: number } = {},
): Promise<AppProcessInfo> {
  const key = appTargetKey(target);
  const cached = processInfoCache.get(key);
  if (cached && opts.maxAgeMs !== undefined && Date.now() - cached.at <= opts.maxAgeMs) {
    return cached.info;
  }
  const info = await queryAppTargetProcessInfo(target);
  processInfoCache.set(key, { at: Date.now(), info });
  return info;
}

export async function isAppTargetRunning(target: AppLaunchTarget): Promise<boolean> {
  return (await appTargetProcessInfo(target)).running;
}

export function markAppTargetManaged(target: AppLaunchTarget, launchedAt = Date.now()): void {
  managedAppProcesses.set(appTargetKey(target), { launchedAt });
}

export async function captureManagedAppTarget(target: AppLaunchTarget): Promise<void> {
  const managed = managedAppProcesses.get(appTargetKey(target));
  if (!managed) return;
  const processInfo = await appTargetProcessInfo(target);
  if (!processInfo.running) return;
  managedAppProcesses.set(appTargetKey(target), {
    ...managed,
    ...(processInfo.pid ? { pid: processInfo.pid } : {}),
    ...(processInfo.startedAt ? { startedAt: processInfo.startedAt } : {}),
  });
}

export async function appTargetNeedsRestart(target: AppLaunchTarget, configChangedAt: number | null): Promise<boolean> {
  const processInfo = await appTargetProcessInfo(target, { maxAgeMs: PROCESS_INFO_TTL_MS });
  return runningAppNeedsRestart(processInfo, managedAppProcesses.get(appTargetKey(target)), configChangedAt);
}

/** Name-only targets (`open -a Claude`) carry no bundle path, so the window
    check below has nothing to match — fill it in from the usual install
    locations when the name maps to a bundle. */
export function bundleForAppTarget(target: AppLaunchTarget): AppLaunchTarget {
  if (process.platform !== 'darwin' || target.path.endsWith('.app')) return target;
  for (const dir of ['/Applications', path.join(homedir(), 'Applications')]) {
    const candidate = path.join(dir, `${target.name}.app`);
    if (existsSync(candidate)) return { name: target.name, path: candidate };
  }
  return target;
}

/** Whether a bundle is a Chromium/Electron app — those get the stronger
    window-is-up check below. */
export function isElectronAppTarget(target: AppLaunchTarget): boolean {
  if (process.platform !== 'darwin' || !target.path.endsWith('.app')) return false;
  return existsSync(path.join(target.path, 'Contents', 'Frameworks', 'Electron Framework.framework'));
}

/** A Chromium app spawns its renderer helper only once a window is created, so
    this is the closest permission-free signal we have to "the UI is up" — the
    main process alone is alive seconds earlier, while the app is still booting. */
export async function hasAppTargetWindowProcess(target: AppLaunchTarget): Promise<boolean> {
  const pattern = `${escapeRegExpLiteral(`${target.path}/Contents/Frameworks/`)}.*${escapeRegExpLiteral('Helper (Renderer)')}`;
  return (await runCommand('pgrep', ['-f', pattern])) !== null;
}

export function quitAppTarget(target: AppLaunchTarget): void {
  if (process.platform === 'darwin') {
    // By POSIX path when we have one: two same-named bundles in /Applications
    // and ~/Applications would otherwise be ambiguous.
    const reference = target.path.endsWith('.app') ? target.path : target.name;
    execFileSync('osascript', ['-e', `tell application "${reference.replace(/(["\\])/g, '\\$1')}" to quit`], { stdio: 'pipe' });
    return;
  }
  if (process.platform === 'win32') {
    const executable = windowsExecutablePath(target.path);
    if (executable) execFileSync('taskkill', ['/T', '/IM', path.basename(executable)], { stdio: 'pipe', windowsHide: true });
  }
}

export function killAppTarget(target: AppLaunchTarget): void {
  if (process.platform === 'darwin') {
    const args = target.path.endsWith('.app')
      ? ['-f', escapeRegExpLiteral(`${target.path}/Contents/MacOS/`)]
      : ['-x', target.name];
    execFileSync('pkill', args, { stdio: 'pipe' });
    return;
  }
  if (process.platform === 'win32') {
    const executable = windowsExecutablePath(target.path);
    if (executable) execFileSync('taskkill', ['/F', '/T', '/IM', path.basename(executable)], { stdio: 'pipe', windowsHide: true });
  }
}

/**
 * Quit and relaunch an application so it re-reads what we just changed — both
 * config-patch files and the system HTTPS proxy are read at startup.
 *
 * `force` kills the app when it doesn't quit within the grace period; leave it
 * off for automatic restarts, where an app holding a "save changes?" dialog
 * must be left alone rather than killed out from under the user.
 */
export async function restartAppTarget(
  target: AppLaunchTarget,
  opts: { force?: boolean; launchIfStopped?: boolean; env?: Record<string, string> } = {},
): Promise<{ ok: boolean; restarted: boolean; error?: string }> {
  if (process.platform !== 'darwin' && process.platform !== 'win32') {
    return { ok: false, restarted: false, error: `Restarting ${target.name} is not supported on this platform.` };
  }
  // `open` hands off to LaunchServices and returns immediately, so wait for
  // the process to actually come back — the caller's busy state is what tells
  // the user the app is on its way.
  const launch = async (): Promise<{ ok: boolean; restarted: boolean; error?: string }> => {
    const result = launchAppTarget(target, { env: opts.env });
    if (result.ok) {
      markAppTargetManaged(target);
      await waitForAppTarget(target);
      await captureManagedAppTarget(target);
    }
    return { ok: result.ok, restarted: result.ok, ...(result.error ? { error: result.error } : {}) };
  };

  if (!(await isAppTargetRunning(target))) {
    if (!opts.launchIfStopped) return { ok: true, restarted: false };
    return { ...(await launch()), restarted: false };
  }

  try {
    quitAppTarget(target);
  } catch {
    // Continue: the app may not respond to AppleScript / may already be gone.
  }
  const startedWaitingAt = Date.now();
  while (Date.now() - startedWaitingAt < 10_000 && await isAppTargetRunning(target)) {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  if (await isAppTargetRunning(target)) {
    if (!opts.force) {
      return { ok: false, restarted: false, error: `${target.name} did not quit — restart it manually to pick up the new settings.` };
    }
    try {
      killAppTarget(target);
    } catch { /* best-effort */ }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return launch();
}

/**
 * Wait for a launched app to be usable, not merely alive: `open` returns as soon
 * as LaunchServices accepts the request, and a Chromium app's main process comes
 * up seconds before its window paints. Callers use this to hold a busy state, so
 * it is bounded — apps we can't read a window signal from fall back to the
 * process check they had before.
 */
export async function waitForAppTarget(target: AppLaunchTarget, timeoutMs = 30_000): Promise<void> {
  const startedWaitingAt = Date.now();
  const expired = () => Date.now() - startedWaitingAt >= timeoutMs;
  while (!expired() && !(await isAppTargetRunning(target))) {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  const bundle = bundleForAppTarget(target);
  if (!isElectronAppTarget(bundle)) return;
  while (!expired() && !(await hasAppTargetWindowProcess(bundle))) {
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
}
/** A launch target for an app we only know by name. macOS addresses those
    through `open -a` / AppleScript, so the bare name is enough; Windows has no
    name-based launcher, so the name is resolved against installed apps to
    recover a real executable path.

    A profile's `restartAppName` may be the friendly Start Menu name or the
    executable's name — "Visual Studio Code" ships Code.exe — so when no entry
    name matches, entries are re-matched by their resolved executable's
    basename. That resolution reads each `.lnk` in turn, so it only runs on the
    miss path. */
export function namedAppTarget(appName: string): AppLaunchTarget | null {
  if (!appName) return null;
  if (process.platform === 'darwin') return { name: appName, path: '' };
  if (process.platform === 'win32') {
    const apps = cachedInstalledApplications();
    const wanted = appName.toLowerCase();
    const byName = apps.find((entry) => entry.name.toLowerCase() === wanted);
    if (byName) return byName;
    return apps.find((entry) => {
      const executable = windowsExecutablePath(entry.path);
      return executable !== null && path.basename(executable, '.exe').toLowerCase() === wanted;
    }) ?? null;
  }
  return null;
}

/** `listInstalledApplications` walks Start Menu shortcuts and program folders
    synchronously — cheap once, not per lookup. `restartConnectedApps` resolves
    a name per profile in a loop, so the scan is done once per run (matching
    the icon list's lifetime in `installedAppsPromise`). */
export let installedApplicationsCache: AppLaunchTarget[] | null = null;
export function cachedInstalledApplications(): AppLaunchTarget[] {
  if (installedApplicationsCache === null) {
    const listed = listInstalledApplications();
    // A failed scan stays uncached so a later call can retry.
    if (!listed.ok) return [];
    installedApplicationsCache = listed.apps;
  }
  return installedApplicationsCache;
}
