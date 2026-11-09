import type { Command } from 'commander'
import chalk from 'chalk'
import { realpathSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { PASSPHRASE_ENV, PASSPHRASE_FILE_ENV } from '@antseed/node'
import { loadConfig } from '../../../config/loader.js'
import { storedWalletKeys } from '../../../buyer-identities/store.js'
import {
  defaultExec,
  installService,
  isServiceActive,
  isServiceInstalled,
  LAUNCHD_LABEL,
  portAnswers,
  servicePlatform,
  SYSTEMD_UNIT,
  uninstallService,
  type ServiceDeps,
  type ServicePlatform,
  type ServiceSpec,
} from '../../../gateway/service.js'
import { anyKeyEncrypted } from '../../wallet-passphrase.js'
import { getGlobalOptions } from '../types.js'
import { parsePositiveInteger } from '../parse-positive-integer.js'
import { DEFAULT_GATEWAY_PORT } from './shared.js'

function serviceDeps(): ServiceDeps {
  const platform = servicePlatform()
  if (!platform) throw new Error('`antseed gateway service` supports macOS (launchd) and Linux (systemd). On Windows, run `antseed gateway start` or use the desktop app.')
  return {
    platform,
    home: homedir(),
    uid: userInfo().uid,
    exec: defaultExec,
    probe: (port) => portAnswers(port),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  }
}

function logsHint(platform: ServicePlatform, dataDir: string): string {
  return platform === 'darwin'
    ? `tail -n 50 ${join(dataDir, 'logs', 'gateway.log')}`
    : `journalctl --user -u ${SYSTEMD_UNIT} -n 50`
}

/** The CLI script this process runs, resolved; refuses a temporary npx copy that would vanish. */
function installedCliPath(): string {
  const script = process.argv[1]
  if (!script) throw new Error('Cannot tell where the antseed CLI is installed.')
  const cliPath = realpathSync(script)
  if (/[\\/]_npx[\\/]/.test(cliPath)) {
    throw new Error('This antseed runs from a temporary npx copy. Install it first (npm install -g @antseed/cli), then run `antseed gateway service install`.')
  }
  return cliPath
}

/**
 * The service cannot ask for a passphrase, and the passphrase itself is never
 * written into a service file: encrypted wallet keys need ANTSEED_PASSPHRASE_FILE.
 */
async function passphraseFileFor(dataDir: string): Promise<string | undefined> {
  const file = process.env[PASSPHRASE_FILE_ENV]
  if (file) return resolve(file)
  if (await anyKeyEncrypted(await storedWalletKeys(dataDir))) {
    throw new Error(
      `A wallet key in ${dataDir} is encrypted, and the service cannot ask for its passphrase. ` +
      `Put the passphrase in a file only you can read (chmod 600), then run this again with ${PASSPHRASE_FILE_ENV}=<that file>` +
      (process.env[PASSPHRASE_ENV] ? ` (${PASSPHRASE_ENV} is not copied into the service).` : '.'),
    )
  }
  return undefined
}

export function registerGatewayServiceCommands(gateway: Command): void {
  const service = gateway.command('service')
    .description('Run the gateway (and its buyer) as a background service that starts at login, without root')

  service.command('install')
    .description('Install and start the gateway as a launchd (macOS) or systemd user (Linux) service; re-run to update it')
    .option('--port <number>', 'gateway listen port', parsePositiveInteger, DEFAULT_GATEWAY_PORT)
    .option('--wait <seconds>', 'how long to wait for the gateway to answer (0: do not wait)', parsePositiveIntegerOrZero, 120)
    .action(async (options: { port: number; wait: number }) => {
      const deps = serviceDeps()
      const globals = getGlobalOptions(gateway)
      const spec: ServiceSpec = {
        nodePath: process.execPath,
        cliPath: installedCliPath(),
        dataDir: globals.dataDir,
        configPath: globals.config,
        port: options.port,
        buyerPort: (await loadConfig(globals.config)).buyer.proxyPort,
        pathEnv: [dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(delimiter),
        logFile: join(globals.dataDir, 'logs', 'gateway.log'),
      }
      const passphraseFile = await passphraseFileFor(globals.dataDir)
      if (passphraseFile) spec.passphraseFile = passphraseFile

      const result = await installService(spec, deps, { waitMs: options.wait * 1_000 })
      console.log(chalk.dim(`Service file: ${result.file}`))
      if (result.ready) {
        console.log(chalk.green(`Gateway running at http://127.0.0.1:${options.port}/v1`))
        console.log(chalk.dim('Next: `antseed gateway console-link` to claim the console, or `antseed gateway key create` for an API key.'))
      } else if (options.wait > 0) {
        const what = result.gatewayAnswered ? `its buyer did not answer on port ${spec.buyerPort}` : `the gateway did not answer on port ${options.port}`
        console.log(chalk.yellow(`The service is installed but ${what} within ${options.wait}s. Check: ${logsHint(deps.platform, globals.dataDir)}`))
        process.exitCode = 1
      } else {
        console.log(chalk.green('Service installed and started.'))
      }
      if (result.lingering === false) {
        console.log(chalk.yellow(`It stops when you log out. To keep it running, run once: sudo loginctl enable-linger ${process.env['USER'] ?? '$USER'}`))
      }
    })

  service.command('status')
    .description('Show whether the gateway service is installed, running and answering, with its buyer; exits 1 when either is not answering')
    .option('--port <number>', 'gateway listen port', parsePositiveInteger, DEFAULT_GATEWAY_PORT)
    .action(async (options: { port: number }) => {
      const deps = serviceDeps()
      const globals = getGlobalOptions(gateway)
      const installed = isServiceInstalled(deps)
      const active = installed && isServiceActive(deps)
      const buyerPort = (await loadConfig(globals.config)).buyer.proxyPort
      const answering = await deps.probe(options.port)
      const buyerAnswering = await deps.probe(buyerPort)
      const yesNo = (value: boolean): string => (value ? chalk.green('yes') : chalk.yellow('no'))
      console.log(`Service (${deps.platform === 'darwin' ? LAUNCHD_LABEL : SYSTEMD_UNIT}) installed: ${yesNo(installed)}`)
      console.log(`Running: ${yesNo(active)}`)
      console.log(`Answering on http://127.0.0.1:${options.port}/v1: ${yesNo(answering)}`)
      console.log(`Buyer answering on port ${buyerPort}: ${yesNo(buyerAnswering)}`)
      if (installed && !(answering && buyerAnswering)) console.log(chalk.dim(`Logs: ${logsHint(deps.platform, globals.dataDir)}`))
      if (!(answering && buyerAnswering)) process.exitCode = 1
    })

  service.command('uninstall')
    .description('Stop the gateway service and remove it; keys, wallets and settings stay in the data dir')
    .action(async () => {
      const deps = serviceDeps()
      console.log(await uninstallService(deps) ? chalk.green('Gateway service stopped and removed.') : chalk.dim('The gateway service is not installed.'))
    })
}

function parsePositiveIntegerOrZero(value: string): number {
  return value.trim() === '0' ? 0 : parsePositiveInteger(value)
}
