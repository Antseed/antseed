/**
 * PATH/SHELL setup for tools the chat agent shells out to.
 *
 * Electron on macOS launches from Finder with a login-shell-less environment,
 * so `node`, `pnpm` and friends are missing from PATH. Called once at engine
 * import time.
 */
import { existsSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

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

  process.env['PATH'] = segments.join(path.delimiter);

  if (!process.env['SHELL']) {
    if (existsSync('/bin/zsh')) process.env['SHELL'] = '/bin/zsh';
    else if (existsSync('/bin/bash')) process.env['SHELL'] = '/bin/bash';
  }
}
