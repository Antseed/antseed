import type { Command } from 'commander'
import chalk from 'chalk'
import { startGatewayRuntime } from '../../../gateway/runtime.js'
import { setupShutdownHandler } from '../../shutdown.js'
import { getGlobalOptions } from '../types.js'
import { parsePositiveInteger } from '../parse-positive-integer.js'
import { registerGatewayKeyCommands } from './key.js'
import { DEFAULT_GATEWAY_PORT, topupConfig } from './shared.js'

export function registerGatewayCommands(program: Command): void {
  const gateway = program
    .command('gateway')
    .description('Serve the buyer API to multiple users with per-key spend limits and usage')

  gateway.command('start')
    .description('Run the API-key gateway locally (use `antseed tunnel start` to publish it)')
    .option('--port <number>', 'gateway listen port', parsePositiveInteger, DEFAULT_GATEWAY_PORT)
    .option('--host <host>', 'listen address; use 0.0.0.0 to serve your LAN', '127.0.0.1')
    .option('--buyer-port <number>', 'port of the running buyer (default: buyer.proxyPort from config)', parsePositiveInteger)
    .option('--x402-facilitator <url>', 'accept x402 top-ups of key wallets, settled by this facilitator (env: ANTSEED_X402_FACILITATOR_URL)')
    .option('--topup-min-usd <usd>', 'smallest top-up accepted (default: 2)')
    .option('--topup-max-usd <usd>', 'largest top-up accepted (default: 500)')
    .action(async (options: { port: number; host: string; buyerPort?: number; x402Facilitator?: string; topupMinUsd?: string; topupMaxUsd?: string }) => {
      const topup = topupConfig(options)
      const globalOptions = getGlobalOptions(gateway)
      const runtime = await startGatewayRuntime({
        dataDir: globalOptions.dataDir,
        configPath: globalOptions.config,
        listenPort: options.port,
        listenHost: options.host,
        ...(options.buyerPort ? { buyerPort: options.buyerPort } : {}),
        ...(topup ? { topup } : {}),
        onLog: (message) => process.stderr.write(`[gateway] ${message}\n`),
      })
      console.log(chalk.green(`API-key gateway listening on http://${options.host}:${runtime.port}/v1`))
      console.log(chalk.dim(`${runtime.store.countActiveKeys()} active key(s). Manage them with \`antseed gateway key …\`.`))
      if (topup) console.log(chalk.dim(`x402 top-ups: POST /v1/key/topup, settled by ${topup.facilitatorUrl}`))
      setupShutdownHandler(async () => {
        await runtime.stop()
        console.log(chalk.dim('API-key gateway stopped.'))
      })
    })

  registerGatewayKeyCommands(gateway)
}
