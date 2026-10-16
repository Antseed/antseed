import type { Command } from 'commander'
import chalk from 'chalk'
import { getGlobalOptions } from '../types.js'
import { loadOrCreateIdentity } from '@antseed/node'
import { DEFAULT_DHT_CONFIG, DHTNode, parseBootstrapList } from '@antseed/node/discovery'
import { setupShutdownHandler } from '../../shutdown.js'

export function registerNetworkBootstrapCommand(networkCmd: Command): void {
  networkCmd
    .command('bootstrap')
    .description('Run a dedicated DHT bootstrap node (no provider, no payments)')
    .option('-p, --port <port>', 'UDP port to listen on', '6881')
    .option(
      '-b, --bootstrap <nodes>',
      'comma-separated host:port list of peer bootstrap nodes (e.g. to cross-connect two bootstrap nodes)',
    )
    .action(async (options: { port: string; bootstrap?: string }) => {
      const globalOptions = getGlobalOptions(networkCmd)

      const port = parseInt(options.port, 10)
      if (!Number.isFinite(port) || port < 1 || port > 65535) {
        console.error(chalk.red(`Invalid port: ${options.port}`))
        process.exit(1)
      }

      const bootstrapNodes = options.bootstrap
        ? parseBootstrapList(options.bootstrap.split(',').map((s) => s.trim()))
        : []

      const identity = await loadOrCreateIdentity(globalOptions.dataDir)

      console.log(chalk.bold('Antseed bootstrap node'))
      console.log(chalk.gray(`  Peer ID : ${identity.peerId.slice(0, 20)}...`))
      console.log(chalk.gray(`  DHT port: ${port}`))
      if (bootstrapNodes.length > 0) {
        console.log(chalk.gray(`  Peers   : ${bootstrapNodes.map((n) => `${n.host}:${n.port}`).join(', ')}`))
      }

      const dht = new DHTNode({
        peerId: identity.peerId,
        port,
        bootstrapNodes,
        reannounceIntervalMs: DEFAULT_DHT_CONFIG.reannounceIntervalMs,
        operationTimeoutMs: DEFAULT_DHT_CONFIG.operationTimeoutMs,
      })

      await dht.start()
      const actualPort = dht.getPort()

      console.log(chalk.green(`\nListening on UDP port ${actualPort} — ready to accept bootstrap connections.`))

      setupShutdownHandler(async () => {
        process.stdout.write('\nShutting down bootstrap node...')
        await dht.stop()
        console.log(' done.')
      })
    })
}
