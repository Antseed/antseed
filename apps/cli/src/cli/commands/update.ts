import { spawn } from 'node:child_process'
import { userInfo } from 'node:os'
import type { Command } from 'commander'
import chalk from 'chalk'
import pkg from '../../../package.json' with { type: 'json' }
import { detectInstallMethod, type InstallKind, type InstallMethod } from '../../update/install-method.js'
import {
  readRootUpdateProgress,
  requestRootUpdate,
  rootUpdaterPaths,
  updateInFlight,
  type RootUpdaterPaths,
  type RootUpdateProgress,
} from '../../update/root-updater.js'
import { fetchLatestVersion, isNewer, writeUpdateCache } from '../../update/version.js'
import { getGlobalOptions } from './types.js'

/** Bump when a field of the --json output changes meaning or is removed. */
export const UPDATE_JSON_SCHEMA_VERSION = 1

export interface UpdateReport {
  schemaVersion: typeof UPDATE_JSON_SCHEMA_VERSION
  current: string
  latest: string
  available: boolean
  install: { kind: InstallKind; command: string | null; note: string }
  /** True once this run installed `latest`. */
  updated: boolean
}

/** How long `antseed update` waits on the gateway server's root updater before giving up. */
const ROOT_UPDATE_TIMEOUT_MS = 10 * 60_000
/** A request nobody picked up by then means the updater's path unit is not installed or not running. */
const ROOT_PICKUP_WARN_MS = 30_000

function runCommand(argv: string[], json: boolean): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(argv[0]!, argv.slice(1), {
      // --json keeps stdout for the report.
      stdio: ['inherit', json ? process.stderr : 'inherit', 'inherit'],
      shell: process.platform === 'win32',
    })
    child.on('error', (error) => {
      process.stderr.write(chalk.red(`Could not run ${argv[0]}: ${error.message}\n`))
      resolve(127)
    })
    child.on('exit', (code) => resolve(code ?? 1))
  })
}

async function waitForRootUpdate(paths: RootUpdaterPaths, log: (line: string) => void): Promise<RootUpdateProgress | null> {
  const started = Date.now()
  let last: string | null = null
  let warned = false
  for (;;) {
    const progress = readRootUpdateProgress(paths)
    const state = progress?.state ?? null
    if (state !== last) {
      if (state === 'requested') log('Waiting for the update service…')
      else if (state === 'running') log(`Installing @antseed/cli@latest (from ${progress?.from ?? 'unknown'})…`)
      last = state
    }
    if (progress && !updateInFlight(progress) && progress.startedAt >= started - 5_000) return progress
    if (!warned && state === 'requested' && Date.now() - started > ROOT_PICKUP_WARN_MS) {
      warned = true
      log(chalk.yellow('The update service has not picked up the request. Check `systemctl status antseed-update.path`; servers installed before it existed need the installer re-run once.'))
    }
    if (Date.now() - started > ROOT_UPDATE_TIMEOUT_MS) return progress
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
}

async function updateThroughRoot(method: InstallMethod, log: (line: string) => void): Promise<boolean> {
  const paths = rootUpdaterPaths()
  if (!paths) throw new Error(method.note)
  if (!updateInFlight(readRootUpdateProgress(paths))) requestRootUpdate(paths, `cli:${userInfo().username}`)
  const result = await waitForRootUpdate(paths, log)
  if (result?.state === 'succeeded') {
    log(chalk.green(`Updated ${result.from ?? ''} → ${result.to ?? 'latest'}; the buyer and gateway services restarted.`))
    return true
  }
  if (result?.state === 'failed') {
    log(chalk.red(`Update failed: ${result.error ?? 'unknown error'}. Details: journalctl -u antseed-update`))
    return false
  }
  log(chalk.red('Timed out waiting for the update service. Details: journalctl -u antseed-update'))
  return false
}

export function registerUpdateCommand(program: Command): void {
  program
    .command('update')
    .description('Check npm for a newer Antseed CLI and install it the way this copy was installed')
    .option('--check', 'only report whether an update is available', false)
    .option('--json', 'print a JSON report on stdout', false)
    .action(async (options: { check: boolean; json: boolean }) => {
      const { dataDir } = getGlobalOptions(program)
      const json = options.json
      const log = (line: string) => process.stderr.write(`${line}\n`)
      const say = json ? log : (line: string) => console.log(line)
      const current = pkg.version
      const method = detectInstallMethod()

      const latest = await fetchLatestVersion()
      try {
        writeUpdateCache(dataDir, { checkedAt: Date.now(), latest })
      } catch {
        // a read-only data dir only costs the notifier its cache
      }
      const available = isNewer(latest, current)
      const report: UpdateReport = {
        schemaVersion: UPDATE_JSON_SCHEMA_VERSION,
        current,
        latest,
        available,
        install: { kind: method.kind, command: method.command, note: method.note },
        updated: false,
      }
      const finish = (code: number) => {
        if (json) console.log(JSON.stringify(report, null, 2))
        process.exitCode = code
      }

      if (!available) {
        say(`Antseed ${current} is up to date${compareNote(latest, current)}.`)
        return finish(0)
      }
      say(`Antseed ${latest} is available (you have ${current}).`)
      if (options.check) {
        say(method.command ? `Update with: ${chalk.bold(method.kind === 'installer' ? 'antseed update' : method.command)}` : method.note)
        return finish(0)
      }

      if (method.kind === 'installer') {
        report.updated = await updateThroughRoot(method, say)
        return finish(report.updated ? 0 : 1)
      }
      if (!method.argv) {
        say(method.note)
        if (method.command) say(`Update with: ${chalk.bold(method.command)}`)
        return finish(1)
      }
      say(`Running: ${method.command}`)
      const code = await runCommand(method.argv, json)
      if (code !== 0) {
        say(chalk.red(`${method.argv[0]} exited with ${code}.`))
        return finish(code)
      }
      report.updated = true
      say(chalk.green(`Updated to ${latest}. Restart any running antseed buyer, seller or gateway to use it.`))
      return finish(0)
    })
}

function compareNote(latest: string, current: string): string {
  return latest === current ? '' : ` (npm's latest is ${latest})`
}
