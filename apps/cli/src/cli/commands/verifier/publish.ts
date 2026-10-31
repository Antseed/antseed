import { join } from 'node:path'
import chalk from 'chalk'
import type { Command } from 'commander'
import { loadConfig } from '../../../config/loader.js'
import { buildEpochBank } from '../../../verifier/round/bank-builder.js'
import { publisherTick } from '../../../verifier/round/publisher-daemon.js'
import { roundStorageFromEnv } from '../../../verifier/round/storage.js'
import { discoverRoundTargets, targetBindingsFromRegistry } from '../../../verifier/round/target-discovery.js'
import { createKbfRoundClient, createSellerRegistryClient } from '../../payment-utils.js'
import { setupShutdownHandler } from '../../shutdown.js'
import { startGatewayBuyer } from '../gateway/shared.js'
import { getGlobalOptions } from '../types.js'
import { resolveAuditorSigner } from './auditor-identity.js'

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
      const client = createKbfRoundClient(config)
      const signer = await resolveAuditorSigner({ config: config.verifier, dataDir: globalOptions.dataDir, keystoreFlag: options.keystore })
      const publisher = await client.publisher()
      if (publisher.toLowerCase() !== signer.address.toLowerCase()) {
        throw new Error(`${signer.address} is not the publisher on ${client.contractAddress} (publisher: ${publisher})`)
      }
      const buyerPort = Number(options.buyerPort ?? config.buyer.proxyPort)
      if (options.buyer !== false) await startGatewayBuyer(buyerPort, globalOptions, log)
      const stateDir = join(globalOptions.dataDir, 'verifier', 'publisher')
      const bindings = targetBindingsFromRegistry(createSellerRegistryClient(config))
      const storage = roundStorageFromEnv()
      const interval = Math.max(10, Number(options.interval ?? '60')) * 1_000
      log(chalk.bold(`publisher ${signer.address} on ${client.contractAddress}`))
      let stopped = false
      setupShutdownHandler(async () => { stopped = true })
      while (!stopped) {
        try {
          await publisherTick({
            client,
            signer: signer.wallet,
            storage,
            stateDir,
            buildBank: ({ epoch, models, excludedProbeIds }) => buildEpochBank({
              config, epoch, models, excludedProbeIds, referencesDir: join(stateDir, 'references'), buyerPort, log,
            }),
            discoverTargets: (models) => discoverRoundTargets({ config, dataDir: globalOptions.dataDir, models, bindings, log }),
            log,
          })
        } catch (error) {
          log(chalk.yellow(`pass failed: ${error instanceof Error ? error.message : String(error)}`))
        }
        await new Promise((resolve) => setTimeout(resolve, interval))
      }
    })
}
