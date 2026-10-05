/**
 * App-level identity, build mode, and the few flags the whole main process
 * reads.
 *
 * The mutable ones sit behind accessors: several handler modules read them and
 * one writes each, and a live-binding `export let` across module boundaries is
 * not assignable by importers anyway.
 */
import { app } from 'electron';
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { desktopInstanceName, desktopUserDataDir, isMultiInstanceDevelopment } from './dev-instance.js';
import { ASSETS_DIR, RENDERER_INDEX_PATH } from './paths.js';

export const isDev = Boolean(process.env['VITE_DEV_SERVER_URL']);
export const rendererUrl = process.env['VITE_DEV_SERVER_URL'] ?? `file://${RENDERER_INDEX_PATH}`;

export const INTERNAL_APP_NAME = 'AntStation Desktop';
const devInstanceName = isMultiInstanceDevelopment() ? desktopInstanceName() : '';
export const APP_NAME = devInstanceName ? `Antseed AI VPN [${devInstanceName}]` : 'Antseed AI VPN';
export const DESKTOP_DEBUG_ENV = 'ANTSEED_DESKTOP_DEBUG';
export const DESKTOP_DEBUG_FLAGS = new Set(['--debug-runtime', '--desktop-debug']);

export type UpdateStatus =
  | { status: 'available'; version: string }
  | { status: 'downloading'; version: string; percent: number }
  | { status: 'ready'; version: string }
  | { status: 'installing'; version: string | null }
  | { status: 'error'; version: string | null; message: string; details: string; hint?: string };

export type InstallUpdateResult =
  | { ok: true }
  | { ok: false; error: string; details: string; hint?: string };

export function isTruthyEnv(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function hasDesktopDebugFlag(argv: string[]): boolean {
  for (const arg of argv) {
    if (DESKTOP_DEBUG_FLAGS.has(arg.trim().toLowerCase())) {
      return true;
    }
  }
  return false;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error.trim()) return error.trim();
  return 'Unknown updater error';
}

export function errorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack || error.message || String(error);
  }
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export function getMacUpdateInstallHint(): string | undefined {
  if (process.platform !== 'darwin') return undefined;

  const executablePath = process.execPath;
  if (executablePath.includes('/AppTranslocation/')) {
    return 'Quit Antseed, move it to Applications, reopen, and try again.';
  }
  if (executablePath.startsWith('/Volumes/')) {
    return 'Quit Antseed, move it from the disk image to Applications, reopen, and try again.';
  }
  if (executablePath.includes('.app/') && !executablePath.startsWith('/Applications/')) {
    return 'Quit Antseed, move it to Applications, reopen, and try again.';
  }
  return undefined;
}

/**
 * First of `names` that exists, preferring the packaged assets directory and
 * falling back to the launch cwd (dev runs start from `apps/desktop`).
 */
export function resolveAssetPath(...names: string[]): string | undefined {
  for (const name of names) {
    const candidates = [
      path.join(ASSETS_DIR, name),
      path.resolve(process.cwd(), 'assets', name),
    ];
    const found = candidates.find((candidate) => existsSync(candidate));
    if (found) {
      return found;
    }
  }
  return undefined;
}

export const APP_ICON_PATH = resolveAssetPath('antseed-dock-icon.png', 'antseed-mark.png');
export const TRAY_ICON_PATH = resolveAssetPath('antseed-mark.png', 'antseed-dock-icon.png');

// Set the internal app name as early as possible — before any safeStorage use,
// since it determines the macOS keychain entry. On macOS dev runs some surfaces
// may still show "Electron" because the underlying bundle is Electron.app.
app.setName(INTERNAL_APP_NAME);
const userDataDir = desktopUserDataDir();
if (isMultiInstanceDevelopment() && userDataDir) {
  mkdirSync(userDataDir, { recursive: true });
  app.setPath('userData', userDataDir);
}

/** Verbose runtime logging, toggled from the renderer's developer settings. */
let desktopDebugEnabled = isTruthyEnv(process.env[DESKTOP_DEBUG_ENV]) || hasDesktopDebugFlag(process.argv);

export function isDesktopDebugEnabled(): boolean {
  return desktopDebugEnabled;
}

export function setDesktopDebugEnabled(enabled: boolean): void {
  desktopDebugEnabled = enabled;
}

/**
 * First-run state. `needed` is set once the launch checks decide the user has
 * setup to do; `complete` flips when they finish it.
 */
let appSetupNeeded = false;
let appSetupComplete = false;

export function getAppSetupStatus(): { needed: boolean; complete: boolean } {
  return { needed: appSetupNeeded, complete: appSetupComplete };
}

export function setAppSetupStatus(next: { needed?: boolean; complete?: boolean }): void {
  if (next.needed !== undefined) appSetupNeeded = next.needed;
  if (next.complete !== undefined) appSetupComplete = next.complete;
}
