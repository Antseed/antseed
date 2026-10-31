import { join } from 'node:path'
import chalk from 'chalk'
import type { Command } from 'commander'
import { loadConfig } from '../../../config/loader.js'
import { publisherTick } from '../../../verifier/round/publisher-daemon.js'
import { CachedRoundStorage, roundStorageFromEnv } from '../../../verifier/round/storage.js'
import { targetBindingsFromRegistry } from '../../../verifier/round/target-discovery.js'
import { createKbfRoundClient, createSellerRegistryClient } from '../../payment-utils.js'
import { setupShutdownHandler } from '../../shutdown.js'
import { startGatewayBuyer } from '../gateway/shared.js'
import { getGlobalOptions } from '../types.js'
import { resolveAuditorSigner, sharedIdentityWarning } from './auditor-identity.js'
import { acquireDaemonLock, createPublisherContext, parsePollInterval } from './daemon-setup.js'

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
      const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`)
      const interval = parsePollInterval(options.interval)
      // Before any key, bank or paid request: a second daemon on this data dir would race this one.
      const lock = await acquireDaemonLock(globalOptions.dataDir)
      setupShutdownHandler(async () => lock.release())
      try {
        const client = createKbfRoundClient(config)
        const signer = await resolveAuditorSigner({ config: config.verifier, dataDir: globalOptions.dataDir, keystoreFlag: options.keystore })
        const identityWarning = sharedIdentityWarning(signer)
        if (identityWarning) log(chalk.yellow(identityWarning))
        const publisher = await client.publisher()
        if (publisher.toLowerCase() !== signer.address.toLowerCase()) {
          throw new Error(`${signer.address} is not the publisher on ${client.contractAddress} (publisher: ${publisher})`)
        }
        const buyerPort = Number(options.buyerPort ?? config.buyer.proxyPort)
        if (options.buyer !== false) await startGatewayBuyer(buyerPort, globalOptions, log)
        const context = createPublisherContext({
          config,
          dataDir: globalOptions.dataDir,
          client,
          signer: signer.wallet,
          storage: new CachedRoundStorage(roundStorageFromEnv(), join(globalOptions.dataDir, 'verifier', 'round', 'cache')),
          bindings: targetBindingsFromRegistry(createSellerRegistryClient(config)),
          buyerPort,
          log,
        })
        log(chalk.bold(`publisher ${signer.address} on ${client.contractAddress}`))
        let stopped = false
        setupShutdownHandler(async () => { stopped = true })
        while (!stopped) {
          try {
            await publisherTick(context)
          } catch (error) {
            log(chalk.yellow(`pass failed: ${error instanceof Error ? error.message : String(error)}`))
          }
          await new Promise((resolve) => setTimeout(resolve, interval))
        }
      } finally {
        await lock.release()
      }
    })
}
