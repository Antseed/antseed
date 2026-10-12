import { InvalidArgumentError, type Command } from 'commander'
import chalk from 'chalk'
import {
  connectedAppStatus,
  findConnectedAppProfile,
  loadConnectedAppProfiles,
  markProfileConnected,
  markProfileDisconnected,
  removeConfigPatch,
  wslTargetsPath,
  writeConfigPatch,
  type ConnectedAppProfile,
  type ConnectedAppStatus,
} from '@antseed/connected-apps'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { getGlobalOptions } from '../types.js'
import { parsePositiveInteger } from '../parse-positive-integer.js'
import { resolveDefaultAntseedBaseUrl } from '../wrapped-tools.js'

/** Bump when a field of the --json output changes meaning or is removed. */
export const APPS_JSON_SCHEMA_VERSION = 1
export const DEFAULT_BUYER_PORT = 8377

export type AppsContext = {
  dataDir: string
  configPath: string
}

export type AppsStatusReport = {
  schemaVersion: typeof APPS_JSON_SCHEMA_VERSION
  apps: ConnectedAppStatus[]
}

export type AppsActionReport = {
  schemaVersion: typeof APPS_JSON_SCHEMA_VERSION
  ok: boolean
  action: 'connect' | 'disconnect'
  app: string
  displayName?: string
  /** connect only: buyer proxy port written into the config. */
  buyerPort?: number
  /** disconnect only: false when the config carried nothing AntSeed added. */
  changed?: boolean
  connected?: boolean
  configPath?: string
  warnings?: string[]
  error?: string
}

function profiles(): ConnectedAppProfile[] {
  return loadConnectedAppProfiles()
}

function unknownAppError(name: string, all: readonly ConnectedAppProfile[]): string {
  return `Unknown app "${name}". Supported apps: ${all.map((profile) => profile.name).join(', ')}`
}

/** Buyer proxy port from buyer.state.json / config buyer.proxyPort, else 8377. */
export async function resolveDefaultBuyerPort(ctx: AppsContext): Promise<number> {
  try {
    const port = Number(new URL(await resolveDefaultAntseedBaseUrl(ctx.dataDir, ctx.configPath)).port)
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : DEFAULT_BUYER_PORT
  } catch {
    return DEFAULT_BUYER_PORT
  }
}

export function getAppsStatus(ctx: AppsContext): AppsStatusReport {
  const targets = wslTargetsPath(ctx.dataDir)
  return {
    schemaVersion: APPS_JSON_SCHEMA_VERSION,
    apps: profiles().map((profile) => connectedAppStatus(profile, targets)),
  }
}

/**
 * The buyer's default route (`defaultRoutedModel` in buyer.state.json), which
 * resolves the `antseed` model alias the patched configs carry. Null when no
 * route is set — the buyer then rejects alias requests with no_default_route.
 */
export function readDefaultRoutedModel(dataDir: string): string | null {
  try {
    const state = JSON.parse(readFileSync(join(dataDir, 'buyer.state.json'), 'utf8')) as Record<string, unknown>
    const model = typeof state['defaultRoutedModel'] === 'string' ? state['defaultRoutedModel'].trim() : ''
    return model.length > 0 ? model : null
  } catch {
    return null
  }
}

export function noDefaultRouteWarning(buyerPort: number): string {
  return 'No default route is set on the buyer, so requests for model "antseed" will fail with no_default_route. '
    + 'Pick a model in the AntSeed desktop app, or set one on the running buyer: '
    + `curl -X POST http://localhost:${buyerPort}/_antseed/route -H 'content-type: application/json' -d '{"model":"<peerId>@<service>"}'`
}

function ensureStateDir(ctx: AppsContext): string {
  const targets = wslTargetsPath(ctx.dataDir)
  mkdirSync(dirname(targets), { recursive: true })
  return targets
}

export async function connectApp(ctx: AppsContext, name: string, buyerPort?: number): Promise<AppsActionReport> {
  const all = profiles()
  const profile = findConnectedAppProfile(name, all)
  if (!profile) {
    return { schemaVersion: APPS_JSON_SCHEMA_VERSION, ok: false, action: 'connect', app: name, error: unknownAppError(name, all) }
  }
  const port = buyerPort ?? await resolveDefaultBuyerPort(ctx)
  const warnings: string[] = []
  if (!readDefaultRoutedModel(ctx.dataDir)) warnings.push(noDefaultRouteWarning(port))
  if (profile.configPatch.format === 'claude-desktop') {
    warnings.push('Claude Desktop is routed through the AntSeed desktop app\'s local Claude gateway; it only works while the desktop app is running.')
  }
  try {
    writeConfigPatch(profile.configPatch, port, ensureStateDir(ctx))
  } catch (err) {
    return {
      schemaVersion: APPS_JSON_SCHEMA_VERSION,
      ok: false,
      action: 'connect',
      app: profile.name,
      displayName: profile.displayName,
      error: err instanceof Error ? err.message : String(err),
    }
  }
  markProfileConnected(ctx.dataDir, profile.name)
  const status = connectedAppStatus(profile, wslTargetsPath(ctx.dataDir))
  return {
    schemaVersion: APPS_JSON_SCHEMA_VERSION,
    ok: true,
    action: 'connect',
    app: profile.name,
    displayName: profile.displayName,
    buyerPort: port,
    connected: status.connected,
    configPath: status.configPath,
    ...(warnings.length > 0 ? { warnings } : {}),
  }
}

export function disconnectApp(ctx: AppsContext, name: string): AppsActionReport {
  const all = profiles()
  const profile = findConnectedAppProfile(name, all)
  if (!profile) {
    return { schemaVersion: APPS_JSON_SCHEMA_VERSION, ok: false, action: 'disconnect', app: name, error: unknownAppError(name, all) }
  }
  let changed: boolean
  try {
    changed = removeConfigPatch(profile.configPatch, ensureStateDir(ctx))
  } catch (err) {
    return {
      schemaVersion: APPS_JSON_SCHEMA_VERSION,
      ok: false,
      action: 'disconnect',
      app: profile.name,
      displayName: profile.displayName,
      error: err instanceof Error ? err.message : String(err),
    }
  }
  markProfileDisconnected(ctx.dataDir, profile.name)
  const status = connectedAppStatus(profile, wslTargetsPath(ctx.dataDir))
  return {
    schemaVersion: APPS_JSON_SCHEMA_VERSION,
    ok: true,
    action: 'disconnect',
    app: profile.name,
    displayName: profile.displayName,
    changed,
    connected: status.connected,
    configPath: status.configPath,
  }
}

function printStatus(report: AppsStatusReport): void {
  const nameWidth = Math.max(3, ...report.apps.map((app) => app.name.length))
  const labelWidth = Math.max(4, ...report.apps.map((app) => app.displayName.length))
  console.log(chalk.bold(`${'APP'.padEnd(nameWidth)}  ${'NAME'.padEnd(labelWidth)}  ${'INSTALLED'}  ${'CONNECTED'}  CONFIG`))
  for (const app of report.apps) {
    const installed = (app.installed ? 'yes' : 'no').padEnd(9)
    const connected = (app.connected ? 'yes' : 'no').padEnd(9)
    console.log([
      app.name.padEnd(nameWidth),
      app.displayName.padEnd(labelWidth),
      app.installed ? chalk.green(installed) : chalk.dim(installed),
      app.connected ? chalk.green(connected) : chalk.dim(connected),
      chalk.dim(app.configPath),
    ].join('  '))
  }
}

function parseBuyerPort(value: string): number {
  const port = parsePositiveInteger(value)
  if (port > 65535) throw new InvalidArgumentError('Must be a port between 1 and 65535.')
  return port
}

function emit(report: AppsActionReport, json: boolean): void {
  if (!report.ok) process.exitCode = 1
  if (json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  if (!report.ok) {
    console.error(chalk.red(report.error ?? `${report.action} failed`))
    return
  }
  const label = report.displayName ?? report.app
  if (report.action === 'connect') {
    console.log(chalk.green(`${label}: connected to the AntSeed buyer on port ${report.buyerPort}`))
    console.log(chalk.dim(`Config: ${report.configPath}`))
    console.log(chalk.dim('The app uses the model "antseed", which the buyer resolves to its current default route. Restart the app if it is running.'))
  } else if (report.changed) {
    console.log(chalk.green(`${label}: disconnected; AntSeed's settings were removed from ${report.configPath}`))
  } else {
    console.log(chalk.dim(`${label}: nothing to disconnect (no AntSeed settings found)`))
  }
  for (const warning of report.warnings ?? []) console.log(chalk.yellow(warning))
}

export function registerAppsCommands(program: Command): void {
  const apps = program
    .command('apps')
    .description('Connect local AI tools (Codex, Claude Code, OpenCode, …) to the AntSeed buyer by editing their config')
    .option('--json', 'print machine-readable JSON')
    .action((options: { json?: boolean }) => {
      runStatus(apps, options.json === true)
    })

  apps.command('status')
    .description('List every supported app: installed, connected, and its config path')
    .option('--json', 'print machine-readable JSON')
    .action((options: { json?: boolean }, command: Command) => {
      runStatus(command, options.json === true || command.optsWithGlobals()['json'] === true)
    })

  apps.command('connect')
    .description('Point an app\'s config at the AntSeed buyer proxy (backs up the original first)')
    .argument('<app>', 'app name, as listed by `antseed apps`')
    .option('--port <buyerPort>', 'buyer proxy port (default: running buyer / buyer.proxyPort / 8377)', parseBuyerPort)
    .option('--json', 'print machine-readable JSON')
    .action(async (app: string, options: { port?: number; json?: boolean }, command: Command) => {
      const ctx = context(command)
      emit(await connectApp(ctx, app, options.port), options.json === true || command.optsWithGlobals()['json'] === true)
    })

  apps.command('disconnect')
    .description('Remove only what AntSeed added to an app\'s config, restoring replaced values')
    .argument('<app>', 'app name, as listed by `antseed apps`')
    .option('--json', 'print machine-readable JSON')
    .action((app: string, options: { json?: boolean }, command: Command) => {
      emit(disconnectApp(context(command), app), options.json === true || command.optsWithGlobals()['json'] === true)
    })
}

function context(command: Command): AppsContext {
  const globalOptions = getGlobalOptions(command)
  return { dataDir: globalOptions.dataDir, configPath: globalOptions.config }
}

function runStatus(command: Command, json: boolean): void {
  const report = getAppsStatus(context(command))
  if (json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }
  printStatus(report)
}
