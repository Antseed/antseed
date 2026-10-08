import type { Command } from 'commander'
import chalk from 'chalk'
import { gatewayConsole, normalizePublicUrl } from '../../../gateway/console.js'
import { detectExposure, detectHostFacts } from '../../../gateway/exposure.js'
import { startGatewayRuntime, type GatewayRuntime } from '../../../gateway/runtime.js'
import { setupShutdownHandler } from '../../shutdown.js'
import { getGlobalOptions } from '../types.js'
import { parsePositiveInteger } from '../parse-positive-integer.js'
import { registerGatewayActivityCommands } from './activity.js'
import { registerGatewayAdminTokenCommands } from './admin-token.js'
import { registerGatewayConsoleLinkCommand } from './console-link.js'
import { registerGatewayKeyCommands } from './key.js'
import { registerGatewayMemberCommands } from './member.js'
import { registerGatewayMigrateCommands } from './migrate.js'
import { registerGatewayPeerListCommands } from './peer-list.js'
import { registerGatewayPresetCommands } from './preset.js'
import { registerGatewayRoutingCommands } from './routing.js'
import { registerGatewayPeersCommand, registerGatewaySettingsCommands } from './settings.js'
import { DEFAULT_GATEWAY_PORT, topupConfig } from './shared.js'
import { registerGatewayWorkspaceCommands } from './workspace.js'

/**
 * Console URL; shared by `gateway start` and `tunnel start`. The owner setup
 * link is never printed here, since service output ends up in the journal
 * where anyone with log access could claim the console with it; only
 * `antseed gateway console-link` prints one, on demand.
 */
export function printConsoleInfo(runtime: GatewayRuntime, consoleUrl: string, log: (line: string) => void = console.log): void {
  if (!runtime.console) return
  log(`${chalk.bold('Console:')} ${consoleUrl}`)
  if (!runtime.store.isSetupComplete()) {
    log(chalk.dim('The console has no owner yet. Get a one-time setup link with `antseed gateway console-link`.'))
  }
}

export function registerGatewayCommands(program: Command): void {
  const gateway = program
    .command('gateway')
    .description('Serve the buyer API to multiple users with per-key spend limits and usage, and a management console')

  gateway.command('start')
    .description('Run the API-key gateway and its console locally (use `antseed tunnel start` to publish it)')
    .option('--port <number>', 'gateway listen port', parsePositiveInteger, DEFAULT_GATEWAY_PORT)
    .option('--host <host>', 'listen address; use 0.0.0.0 to serve your LAN', '127.0.0.1')
    .option('--buyer-port <number>', 'port of the running buyer (default: buyer.proxyPort from config)', parsePositiveInteger)
    .option('--public-url <url>', 'origin the console is reached at, e.g. https://llm.example.com (env: ANTSEED_GATEWAY_PUBLIC_URL); needed for passkeys and single sign-on off this machine')
    .option('--no-console', 'serve only the API, without the /console management console')
    .option('--x402-facilitator <url>', 'accept x402 top-ups of key wallets, settled by this facilitator: a URL, "cdp" or "payai" (env: ANTSEED_X402_FACILITATOR_URL)')
    .option('--topup-min-usd <usd>', 'smallest top-up accepted (default: 2)')
    .option('--topup-max-usd <usd>', 'largest top-up accepted (default: 500)')
    .action(async (options: {
      port: number
      host: string
      buyerPort?: number
      publicUrl?: string
      console: boolean
      x402Facilitator?: string
      topupMinUsd?: string
      topupMaxUsd?: string
    }) => {
      const topup = topupConfig(options)
      const globalOptions = getGlobalOptions(gateway)
      const publicUrl = normalizePublicUrl(options.publicUrl ?? process.env['ANTSEED_GATEWAY_PUBLIC_URL'])
      const log = (message: string): void => { process.stderr.write(`[gateway] ${message}\n`) }
      const runtime = await startGatewayRuntime({
        dataDir: globalOptions.dataDir,
        configPath: globalOptions.config,
        listenPort: options.port,
        listenHost: options.host,
        ...(options.buyerPort ? { buyerPort: options.buyerPort } : {}),
        ...(topup ? { topup } : {}),
        ...(options.console
          ? { createConsole: gatewayConsole({ dataDir: globalOptions.dataDir, configPath: globalOptions.config, publicUrl, log }) }
          : {}),
        onLog: log,
      })
      console.log(chalk.green(`API-key gateway listening on http://${options.host}:${runtime.port}/v1`))
      console.log(chalk.dim(`${runtime.store.countActiveKeys()} active key(s). Manage them in the console or with \`antseed gateway key …\`.`))
      printConsoleInfo(runtime, `${publicUrl ?? `http://localhost:${runtime.port}`}/console`)
      if (topup) console.log(chalk.dim(`x402 top-ups: POST /v1/key/topup, settled by ${topup.facilitatorUrl}`))
      const exposure = detectExposure({ publicUrl, listenHost: options.host, host: detectHostFacts() })
      if (exposure.mode !== 'public') {
        console.log(chalk.dim(exposure.mode === 'local'
          ? 'Only this computer can reach this gateway. To serve a team, move it to a server: antseed gateway export --out antseed-gateway.bundle'
          : 'No public URL: only your network can reach this gateway, over plain HTTP. To serve a team, move it to a server: antseed gateway export --out antseed-gateway.bundle'))
      }
      setupShutdownHandler(async () => {
        await runtime.stop()
        console.log(chalk.dim('API-key gateway stopped.'))
      })
    })

  registerGatewayKeyCommands(gateway)
  registerGatewayConsoleLinkCommand(gateway)
  registerGatewayMemberCommands(gateway)
  registerGatewayWorkspaceCommands(gateway)
  registerGatewayAdminTokenCommands(gateway)
  registerGatewayRoutingCommands(gateway)
  registerGatewayPeerListCommands(gateway)
  registerGatewayPresetCommands(gateway)
  registerGatewayActivityCommands(gateway)
  registerGatewaySettingsCommands(gateway)
  registerGatewayPeersCommand(gateway)
  registerGatewayMigrateCommands(gateway)
}
