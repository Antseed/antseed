import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import http from 'node:http'
import { dirname, join } from 'node:path'
import { BUYER_STOP_TIMEOUT_MS } from './buyer-process.js'
import { SHUTDOWN_DRAIN_MS } from './server.js'

/**
 * `antseed gateway service`: runs `antseed gateway start` (which also runs the
 * buyer) as a per-user background service, so it starts at login and comes
 * back if it exits. macOS uses a launchd agent, Linux a systemd user unit;
 * neither needs root. The service runs this same node and CLI script, by
 * absolute path, so it works with nvm and other managers that keep node off
 * the default PATH.
 */

export const LAUNCHD_LABEL = 'com.antseed.gateway'
export const SYSTEMD_UNIT = 'antseed-gateway.service'

export type ServicePlatform = 'darwin' | 'linux'

/**
 * How long the service manager waits after asking the gateway to stop before
 * killing it: the gateway drains requests in flight, then stops its buyer
 * (which drains its own), so both budgets run one after the other, plus slack.
 */
export const SERVICE_STOP_TIMEOUT_S = Math.ceil((SHUTDOWN_DRAIN_MS + BUYER_STOP_TIMEOUT_MS) / 1_000) + 30

export interface ServiceSpec {
  /** Absolute path of the node binary to run. */
  nodePath: string
  /** Absolute path of the CLI entry script. */
  cliPath: string
  dataDir: string
  configPath: string
  port: number
  /** Port of the buyer the gateway runs (buyer.proxyPort); install waits for it too. */
  buyerPort: number
  /** PATH for the service: node's directory first. */
  pathEnv: string
  /** ANTSEED_PASSPHRASE_FILE for encrypted wallet keys; the path only, never the passphrase. */
  passphraseFile?: string
  /** macOS only: where stdout and stderr go. Linux logs to the journal. */
  logFile: string
}

export function servicePlatform(platform: NodeJS.Platform = process.platform): ServicePlatform | null {
  return platform === 'darwin' || platform === 'linux' ? platform : null
}

export function serviceFilePath(platform: ServicePlatform, home: string): string {
  return platform === 'darwin'
    ? join(home, 'Library', 'LaunchAgents', `${LAUNCHD_LABEL}.plist`)
    : join(home, '.config', 'systemd', 'user', SYSTEMD_UNIT)
}

/** The command line the service runs. */
export function serviceCommand(spec: ServiceSpec): string[] {
  return [
    spec.nodePath, spec.cliPath,
    '--data-dir', spec.dataDir,
    '--config', spec.configPath,
    'gateway', 'start', '--port', String(spec.port),
  ]
}

function serviceEnv(spec: ServiceSpec): Array<[string, string]> {
  const env: Array<[string, string]> = [['PATH', spec.pathEnv]]
  if (spec.passphraseFile) env.push(['ANTSEED_PASSPHRASE_FILE', spec.passphraseFile])
  return env
}

function xml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function launchdPlist(spec: ServiceSpec): string {
  const args = serviceCommand(spec).map((arg) => `    <string>${xml(arg)}</string>`).join('\n')
  const env = serviceEnv(spec).map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${args}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ExitTimeOut</key><integer>${SERVICE_STOP_TIMEOUT_S}</integer>
  <key>StandardOutPath</key><string>${xml(spec.logFile)}</string>
  <key>StandardErrorPath</key><string>${xml(spec.logFile)}</string>
</dict>
</plist>
`
}

/** A quoted systemd value, with specifiers (%) escaped. Environment= takes it as is. */
function systemdQuoted(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%')}"`
}

/** One ExecStart word: also escapes $, which ExecStart (unlike Environment=) expands. */
function systemdExecWord(value: string): string {
  return systemdQuoted(value.replace(/\$/g, '$$$$'))
}

export function systemdUnit(spec: ServiceSpec): string {
  const env = serviceEnv(spec).map(([k, v]) => `Environment=${systemdQuoted(`${k}=${v}`)}`).join('\n')
  return `[Unit]
Description=Antseed API-key gateway and buyer
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=${serviceCommand(spec).map(systemdExecWord).join(' ')}
${env}
Restart=always
RestartSec=10
# Stop signals the gateway alone: it drains requests in flight, then stops its
# buyer. Anything still running when the timeout ends is killed.
KillMode=mixed
TimeoutStopSec=${SERVICE_STOP_TIMEOUT_S}

[Install]
WantedBy=default.target
`
}

/** Runs a command; throws on a non-zero exit. Returns stdout. */
export type Exec = (file: string, args: string[]) => string

export const defaultExec: Exec = (file, args) =>
  execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

/** True when something answers HTTP on 127.0.0.1:port. */
export function portAnswers(port: number, timeoutMs = 2_000): Promise<boolean> {
  return new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/v1/models', timeout: timeoutMs }, (res) => {
      res.resume()
      resolve(true)
    })
    req.on('timeout', () => { req.destroy(); resolve(false) })
    req.on('error', () => resolve(false))
  })
}

export interface ServiceDeps {
  platform: ServicePlatform
  home: string
  uid: number
  exec: Exec
  probe: (port: number) => Promise<boolean>
  sleep: (ms: number) => Promise<void>
}

function launchdTarget(deps: ServiceDeps): string {
  return `gui/${deps.uid}`
}

function tryExec(deps: ServiceDeps, file: string, args: string[]): boolean {
  try {
    deps.exec(file, args)
    return true
  } catch {
    return false
  }
}

export function isServiceInstalled(deps: Pick<ServiceDeps, 'platform' | 'home'>): boolean {
  return existsSync(serviceFilePath(deps.platform, deps.home))
}

/** Whether the service manager has the service loaded and running. */
export function isServiceActive(deps: ServiceDeps): boolean {
  if (deps.platform === 'darwin') {
    try {
      return /\bstate = running\b/.test(deps.exec('launchctl', ['print', `${launchdTarget(deps)}/${LAUNCHD_LABEL}`]))
    } catch {
      return false
    }
  }
  return tryExec(deps, 'systemctl', ['--user', 'is-active', '--quiet', SYSTEMD_UNIT])
}

export interface InstallResult {
  file: string
  /** Whether the gateway and its buyer both answered before the wait ran out (always false with waitMs 0). */
  ready: boolean
  /** Whether the gateway itself answered; with ready false, the buyer is the one that did not come up. */
  gatewayAnswered: boolean
  /** Linux: false when the user's services stop at logout (no lingering). */
  lingering: boolean | null
}

/** Writes the service file and (re)starts the service. Safe to run again: it replaces an earlier install. */
export async function installService(spec: ServiceSpec, deps: ServiceDeps, options: { waitMs: number }): Promise<InstallResult> {
  const file = serviceFilePath(deps.platform, deps.home)
  const reinstall = existsSync(file)
  if (!reinstall && await deps.probe(spec.port)) {
    throw new Error(
      `Something already answers on port ${spec.port}: a gateway started in a terminal, the desktop app, or another service. ` +
      'Stop it first, or pick another port with --port.',
    )
  }
  await mkdir(dirname(file), { recursive: true })

  if (deps.platform === 'darwin') {
    await mkdir(dirname(spec.logFile), { recursive: true })
    // An earlier install must be unloaded before launchd reads the new file.
    if (reinstall) await unloadLaunchdAgent(deps)
    await writeFile(file, launchdPlist(spec), { mode: 0o644 })
    deps.exec('launchctl', ['bootstrap', launchdTarget(deps), file])
  } else {
    await writeFile(file, systemdUnit(spec), { mode: 0o644 })
    deps.exec('systemctl', ['--user', 'daemon-reload'])
    deps.exec('systemctl', ['--user', 'enable', SYSTEMD_UNIT])
    deps.exec('systemctl', ['--user', 'restart', SYSTEMD_UNIT])
  }

  // The gateway listens even when its buyer fails to start, so wait for both.
  let gatewayAnswered = false
  let ready = false
  for (let waited = 0; waited < options.waitMs; waited += 1_000) {
    gatewayAnswered ||= await deps.probe(spec.port)
    if (gatewayAnswered && await deps.probe(spec.buyerPort)) { ready = true; break }
    await deps.sleep(1_000)
  }
  return { file, ready, gatewayAnswered, lingering: deps.platform === 'linux' ? lingering(deps) : null }
}

/** Stops the service and removes its file. False when it was not installed. */
export async function uninstallService(deps: ServiceDeps): Promise<boolean> {
  const file = serviceFilePath(deps.platform, deps.home)
  if (!existsSync(file)) return false
  if (deps.platform === 'darwin') {
    await unloadLaunchdAgent(deps)
    await rm(file, { force: true })
  } else {
    tryExec(deps, 'systemctl', ['--user', 'disable', '--now', SYSTEMD_UNIT])
    await rm(file, { force: true })
    tryExec(deps, 'systemctl', ['--user', 'daemon-reload'])
  }
  return true
}

/**
 * `launchctl bootout` returns before the agent is gone (its process may still
 * be draining requests), and bootstrapping the label again until then fails
 * with "Input/output error". Waits for it to unload, as long as launchd
 * itself lets the gateway take to stop (ExitTimeOut), plus a little.
 */
async function unloadLaunchdAgent(deps: ServiceDeps): Promise<void> {
  const service = `${launchdTarget(deps)}/${LAUNCHD_LABEL}`
  if (!tryExec(deps, 'launchctl', ['bootout', service])) return
  for (let waited = 0; waited < (SERVICE_STOP_TIMEOUT_S + 15) * 1_000; waited += 500) {
    if (!tryExec(deps, 'launchctl', ['print', service])) return
    await deps.sleep(500)
  }
  throw new Error(`launchd did not unload ${LAUNCHD_LABEL} within ${SERVICE_STOP_TIMEOUT_S + 15}s; try again, or run: launchctl bootout ${service}`)
}

/** Linux: whether user services keep running after logout. Null when unknown. */
function lingering(deps: ServiceDeps): boolean | null {
  try {
    const user = process.env['USER'] ?? ''
    return deps.exec('loginctl', ['show-user', user, '--property=Linger', '--value']).trim() === 'yes'
  } catch {
    return null
  }
}
