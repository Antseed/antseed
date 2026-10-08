/**
 * PATH/SHELL setup for tools the chat agent shells out to.
 *
 * Electron on macOS launches from Finder with a login-shell-less environment,
 * so `node`, `pnpm` and friends are missing from PATH. Called once at engine
 * import time.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { CHAT_DATA_DIR } from './paths.js';

export const CHAT_NODE_SHIM_DIR = path.join(CHAT_DATA_DIR, 'node-runtime');

function writeIfChanged(filePath: string, content: string, mode: number): void {
  const current = existsSync(filePath) ? readFileSync(filePath, 'utf8') : null;
  if (current !== content) writeFileSync(filePath, content, { mode });
  chmodSync(filePath, mode);
}

/**
 * Writes a `node` launcher that runs Electron's bundled Node.js, so bundled
 * skill scripts (for example `antseed_video.mjs`) work on machines without a
 * system Node.js. Returns the launcher directory.
 */
export function installChatNodeShim(
  electronPath: string = process.execPath,
  shimDir: string = CHAT_NODE_SHIM_DIR,
  platform: NodeJS.Platform = process.platform,
): string {
  mkdirSync(shimDir, { recursive: true });
  const posixPath = platform === 'win32' ? electronPath.replace(/\\/g, '/') : electronPath;
  const quoted = `'${posixPath.replace(/'/g, `'\\''`)}'`;
  writeIfChanged(path.join(shimDir, 'node'), `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quoted} "$@"\n`, 0o755);
  if (platform === 'win32') {
    writeIfChanged(path.join(shimDir, 'node.cmd'), `@echo off\r\nset ELECTRON_RUN_AS_NODE=1\r\n"${electronPath}" %*\r\n`, 0o755);
  }
  return shimDir;
}

export function augmentChatToolPath(): void {
  const currentPath = process.env['PATH'] ?? '';
  const segments = currentPath
    .split(path.delimiter)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  const seen = new Set(segments);

  const add = (segment: string | undefined) => {
    const normalized = segment?.trim();
    if (!normalized || seen.has(normalized) || !existsSync(normalized)) return;
    segments.unshift(normalized);
    seen.add(normalized);
  };

  add('/usr/local/bin');
  add('/opt/homebrew/bin');
  add('/usr/bin');
  add('/bin');
  add(path.join(homedir(), 'Library', 'pnpm'));
  add(path.join(homedir(), '.volta', 'bin'));
  add(path.join(homedir(), 'bin'));

  const nvmVersionsDir = path.join(homedir(), '.nvm', 'versions', 'node');
  if (existsSync(nvmVersionsDir)) {
    const versionDirs = readdirSync(nvmVersionsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));

    for (const versionDir of versionDirs) {
      add(path.join(nvmVersionsDir, versionDir, 'bin'));
    }
  }

  if (process.versions.electron) {
    try {
      const shimDir = installChatNodeShim();
      if (!seen.has(shimDir)) segments.push(shimDir);
    } catch {
      // Without the launcher, skill scripts fall back to a system Node.js.
    }
  }

  process.env['PATH'] = segments.join(path.delimiter);

  if (!process.env['SHELL']) {
    if (existsSync('/bin/zsh')) process.env['SHELL'] = '/bin/zsh';
    else if (existsSync('/bin/bash')) process.env['SHELL'] = '/bin/bash';
  }
}
