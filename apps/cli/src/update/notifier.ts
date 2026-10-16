import { spawn } from 'node:child_process'
import chalk from 'chalk'
import { detectInstallMethod, type InstallKind } from './install-method.js'
import {
  isNewer,
  readUpdateCache,
  registryUrl,
  UPDATE_CHECK_INTERVAL_MS,
  updateCachePath,
  updateChecksDisabled,
} from './version.js'

/** Installs that `antseed update` (or the person) can act on; the others update some other way. */
const NOTIFY_KINDS: ReadonlySet<InstallKind> = new Set(['installer', 'npm', 'pnpm', 'yarn', 'bun', 'volta', 'nix'])

/**
 * Refreshes the cache in a detached child, the way update-notifier does, so
 * a slow registry never delays this command or its exit. Self-contained:
 * the esbuild bundle has no separate worker file to run.
 */
const CHECK_SCRIPT = `
const fs = require('node:fs'), path = require('node:path');
const [url, file] = process.argv.slice(1);
fetch(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10000) })
  .then((r) => r.ok ? r.json() : null)
  .then((tags) => {
    const latest = tags && tags.latest;
    if (typeof latest !== 'string' || !/^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?$/.test(latest)) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ checkedAt: Date.now(), latest }));
    fs.renameSync(tmp, file);
  })
  .catch(() => {});
`

export function refreshUpdateCacheInBackground(dataDir: string, env: NodeJS.ProcessEnv = process.env): void {
  try {
    const url = `${registryUrl(env)}/-/package/@antseed%2fcli/dist-tags`
    const child = spawn(process.execPath, ['-e', CHECK_SCRIPT, url, updateCachePath(dataDir)], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
    child.on('error', () => {})
    child.unref()
  } catch {
    // best effort
  }
}

export interface NotifyOptions {
  dataDir: string
  current: string
  /** The command that is about to run, e.g. `update` or `start`. */
  commandName: string
  argv?: string[]
  env?: NodeJS.ProcessEnv
  stream?: NodeJS.WriteStream
  now?: number
  refresh?: (dataDir: string) => void
}

/**
 * Prints a one-line notice on stderr when the last registry check found a
 * newer CLI, and refreshes that check in the background once a day. Silent
 * for non-interactive runs (`--json`, pipes, services, CI) and when
 * `NO_UPDATE_NOTIFIER` or `ANTSEED_NO_UPDATE_CHECK` is set.
 */
export function notifyIfUpdateAvailable(options: NotifyOptions): void {
  const env = options.env ?? process.env
  const stream = options.stream ?? process.stderr
  const argv = options.argv ?? process.argv
  if (options.commandName === 'update' || updateChecksDisabled(env) || !stream.isTTY || argv.includes('--json')) return
  const method = detectInstallMethod({ env })
  if (!NOTIFY_KINDS.has(method.kind)) return

  const cache = readUpdateCache(options.dataDir)
  const now = options.now ?? Date.now()
  if (!cache || now - cache.checkedAt > UPDATE_CHECK_INTERVAL_MS) (options.refresh ?? ((dir) => refreshUpdateCacheInBackground(dir, env)))(options.dataDir)
  if (!cache || !isNewer(cache.latest, options.current)) return

  const how = method.kind === 'nix' ? `Update your Nix flake input to get it.` : `Run ${chalk.bold('antseed update')} to install it.`
  stream.write(`${chalk.yellow('●')} Antseed ${cache.latest} is available (you have ${options.current}). ${how}\n`)
}
