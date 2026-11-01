import chalk from 'chalk'
import type { Command } from 'commander'
import { loadConfig } from '../../../config/loader.js'
import { publisherTick } from '../../../verifier/round/publisher-daemon.js'
import { targetBindingsFromRegistry } from '../../../verifier/round/target-discovery.js'
import { createKbfRoundClient, createSellerRegistryClient } from '../../payment-utils.js'
import { setupShutdownHandler } from '../../shutdown.js'
import { startGatewayBuyer } from '../gateway/shared.js'
import { getGlobalOptions } from '../types.js'
import { resolveAuditorSigner } from './auditor-identity.js'
import { acquireDaemonLock, cachedRoundStorage, createPublisherContext, parsePollInterval, runDaemonLoop, timestampedLog } from './daemon-setup.js'

interface PublishOptions {
  keystore?: string
  buyer?: boolean
  buyerPort?: string
  interval?: string
}

export function registerVerifierPublishCommand(verifier: Command): void {
  verifier
    .command('publish')
    .description('Run the reference publisher: build and seal each epoch\'s question bank, publish plans, reveal bank keys')
    .option('--keystore <path>', 'sign with this encrypted JSON keystore instead of the data-dir identity (password from ANTSEED_KEYSTORE_PASSWORD)')
    .option('--no-buyer', 'use a buyer that is already running instead of starting one')
    .option('--buyer-port <port>', 'buyer proxy port (default: buyer.proxyPort from the config)')
    .option('--interval <seconds>', 'seconds between passes', '60')
    .action(async (options: PublishOptions, command: Command) => {
      const globalOptions = getGlobalOptions(command)
      const config = await loadConfig(globalOptions.config)
      const log = timestampedLog
      const interval = parsePollInterval(options.interval)
      // Before any key, bank or paid request: a second daemon on this data dir would race this one.
      const lock = await acquireDaemonLock(globalOptions.dataDir)
      setupShutdownHandler(async () => lock.release())
      try {
        const client = createKbfRoundClient(config)
        const signer = await resolveAuditorSigner({ config: config.verifier, dataDir: globalOptions.dataDir, keystoreFlag: options.keystore })
        const publisher = await client.publisher()
        // A publisher the owner replaced still owes the epochs whose banks it committed: their
        // escrow, plan and key reveal. It finishes those and builds no new banks.
        const newBanks = publisher.toLowerCase() === signer.address.toLowerCase()
        if (!newBanks) {
          const current = await client.currentEpoch()
          const owed = []
          for (const epoch of [current, current + 1n]) {
            if ((await client.epochInfo(epoch)).publisher.toLowerCase() === signer.address.toLowerCase()) owed.push(epoch)
          }
          if (owed.length === 0) {
            throw new Error(`${signer.address} is not the publisher on ${client.contractAddress} (publisher: ${publisher}) and publishes no open epoch`)
          }
          log(chalk.yellow(`${signer.address} is no longer the publisher: finishing epoch ${owed.join(' and ')}, no new banks`))
        }
        const buyerPort = Number(options.buyerPort ?? config.buyer.proxyPort)
        if (options.buyer !== false) await startGatewayBuyer(buyerPort, globalOptions, log)
        const context = createPublisherContext({
          config,
          dataDir: globalOptions.dataDir,
          client,
          signer: signer.wallet,
          storage: cachedRoundStorage(globalOptions.dataDir),
          bindings: targetBindingsFromRegistry(createSellerRegistryClient(config)),
          buyerPort,
          log,
        })
        context.newBanks = newBanks
        log(chalk.bold(`publisher ${signer.address} on ${client.contractAddress}`))
        await runDaemonLoop(interval, (message) => log(chalk.yellow(message)), () => publisherTick(context))
      } finally {
        await lock.release()
      }
    })
}
