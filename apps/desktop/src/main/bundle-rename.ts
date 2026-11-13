/**
 * Moving the macOS app bundle to "Antseed Desktop.app".
 *
 * Squirrel.Mac names an updated bundle after its executable. Updating an install
 * named after another executable ("AntSeed VPR.app") renames the bundle, and
 * Squirrel then reopens the app by starting its ShipIt helper from the old
 * bundle path, which the rename just removed: the update installs but the app
 * never reopens. So installs from before the rename update to a bridge build
 * that keeps the old executable name (no rename, so it reopens), and that build
 * moves its own bundle to the new name here and restarts from it.
 */
import { spawn } from 'node:child_process';
import { existsSync, renameSync } from 'node:fs';
import path from 'node:path';

export const BUNDLE_NAME = 'Antseed Desktop.app';
/**
 * Update channel of builds that have this module: they read `desktop-mac.yml`,
 * and `latest-mac.yml` stays the bridge build's (scripts/release-mac.mjs).
 */
export const MAC_UPDATE_CHANNEL = 'desktop';
/** Bundle names of installs from before the rename, moved to BUNDLE_NAME at launch. */
export const LEGACY_BUNDLE_NAMES: readonly string[] = ['AntSeed VPR.app', 'Antseed AI VPN.app'];

export type BundleMove = { from: string; to: string };

/** The move this launch should make, or null: only a legacy-named bundle with nothing at the new name. */
export function legacyBundleMove(execPath: string, exists: (target: string) => boolean = existsSync): BundleMove | null {
  // <bundle>.app/Contents/MacOS/<executable>
  const bundle = path.resolve(execPath, '..', '..', '..');
  if (!LEGACY_BUNDLE_NAMES.includes(path.basename(bundle))) return null;
  const to = path.join(path.dirname(bundle), BUNDLE_NAME);
  if (exists(to)) return null;
  return { from: bundle, to };
}

/** Moves a legacy-named bundle; returns the bundle to restart from, or null when nothing moved. */
export function moveLegacyBundle(execPath: string, log: (line: string) => void): string | null {
  const move = legacyBundleMove(execPath);
  if (!move) return null;
  try {
    renameSync(move.from, move.to);
  } catch (err) {
    // Read-only location, no permission: keep running from the old name.
    log(`bundle rename skipped: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  log(`moved ${move.from} to ${move.to}`);
  return move.to;
}

/**
 * Opens `bundle` once this process has exited, so the new instance gets the
 * single-instance lock. Not app.relaunch(): Electron starts its relauncher from
 * the executable's old path, which the move just removed.
 */
export function openBundleAfterExit(bundle: string): void {
  const script = 'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done; exec /usr/bin/open "$2"';
  spawn('/bin/sh', ['-c', script, 'antseed-bundle-reopen', String(process.pid), bundle], {
    detached: true,
    stdio: 'ignore',
  }).unref();
}
