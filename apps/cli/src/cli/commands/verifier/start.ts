import pkg from '../../../../package.json' with { type: 'json' }
import { chmod, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import chalk from 'chalk'
import type { Command } from 'commander'
import { isZeroHash } from '@antseed/node/payments'
import { loadConfig } from '../../../config/loader.js'
import { requireCurrentVerifier } from '../../../verifier/release-check.js'
import { writeSecretJsonAtomic } from '../../../verifier/atomic-files.js'
import { loadBuyerProxySnapshot } from '../../../verifier/model-run.js'
import { openResponseAuthReader, type ResponseAuthReader } from '../../../verifier/response-auth-reader.js'
import type { CollectorContext } from '../../../verifier/round/collector.js'
import { fallbackPublisherTick } from '../../../verifier/round/fallback-publisher.js'
import { keyEscrowTick } from '../../../verifier/round/key-escrow.js'
import { encryptionPublicKey, generateEncryptionKeyPair, isUsableEncryptionKey } from '../../../verifier/round/sealing.js'
import { roundStorageFromEnv } from '../../../verifier/round/storage.js'
import { targetBindingsFromRegistry } from '../../../verifier/round/target-discovery.js'
import { DEFAULT_MAX_REQUESTS_PER_EPOCH, verifierTick } from '../../../verifier/round/verifier-daemon.js'
import { createKbfRoundClient, createSellerRegistryClient } from '../../payment-utils.js'
import { setupShutdownHandler } from '../../shutdown.js'
import { startGatewayBuyer } from '../gateway/shared.js'
import { getGlobalOptions } from '../types.js'
import { resolveAuditorSigner } from './auditor-identity.js'
import { createPublisherContext, parsePollInterval } from './daemon-setup.js'

interface StartOptions {
  keystore?: string
  buyer?: boolean
  buyerPort?: string
  interval?: string
  collect?: boolean
  maxEpochRequests?: string
  skipVersionCheck?: boolean
}

/**
 * This pass's slice buyer, or null when collection is off or the buyer is unavailable. A buyer
 * outage only pauses buying: scoring, attesting, applying results and claiming need nothing but
 * the chain and storage, so the pass still runs without it.
 */
export async function collectorForPass(input: {
  responseAuth: ResponseAuthReader | null
  loadBuyerUrl: () => Promise<string>
  log: (message: string) => void
}): Promise<CollectorContext | null> {
  if (!input.responseAuth) return null
  try {
    return { buyerUrl: await input.loadBuyerUrl(), responseAuth: input.responseAuth, log: input.log }
  } catch (error) {
    input.log(chalk.yellow(`buyer unavailable, not collecting this pass: ${error instanceof Error ? error.message : String(error)}`))
    return null
  }
}

/** The verifier's X25519 key pair for question envelopes, created once in the data dir (owner-only). */
export async function loadOrCreateEncryptionKey(dataDir: string): Promise<{ publicKey: string; privateKey: string }> {
  const path = join(dataDir, 'verifier', 'round', 'encryption-key.json')
  let text: string | null = null
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  if (text !== null) {
    // Repair a key file left readable by an older build.
    if (((await stat(path)).mode & 0o077) !== 0) await chmod(path, 0o600)
    const stored = JSON.parse(text) as { privateKey: string }
    return { privateKey: stored.privateKey, publicKey: encryptionPublicKey(stored.privateKey) }
  }
  const pair = generateEncryptionKeyPair()
  await writeSecretJsonAtomic(path, { privateKey: pair.privateKey })
  return pair
}

export function registerVerifierStartCommand(verifier: Command): void {
  verifier
    .command('start')
    .description('Run a verifier: collect assigned slices, score every epoch, attest results and claim rewards')
    .option('--keystore <path>', 'sign with this encrypted JSON keystore instead of the data-dir identity (password from ANTSEED_KEYSTORE_PASSWORD)')
    .option('--no-buyer', 'use a buyer that is already running instead of starting one')
    .option('--buyer-port <port>', 'buyer proxy port (default: buyer.proxyPort from the config)')
    .option('--interval <seconds>', 'seconds between passes', '60')
    .option('--no-collect', 'only score and attest; never buy slices')
    .option('--max-epoch-requests <n>', 'most seller requests to send per epoch, retries included, own and backup slices together', String(DEFAULT_MAX_REQUESTS_PER_EPOCH))
    .option('--skip-version-check', 'start even if this CLI is older than the latest release (it may attest a different results root)')
    .action(async (options: StartOptions, command: Command) => {
      const globalOptions = getGlobalOptions(command)
      const config = await loadConfig(globalOptions.config)
      const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`)
      // Option errors first, before anything is published on-chain or a buyer is started.
      const interval = parsePollInterval(options.interval)
      const maxRequestsPerEpoch = Number(options.maxEpochRequests ?? DEFAULT_MAX_REQUESTS_PER_EPOCH)
      if (!Number.isSafeInteger(maxRequestsPerEpoch) || maxRequestsPerEpoch < 0) {
        throw new Error(`--max-epoch-requests must be a whole number, got ${options.maxEpochRequests}`)
      }
      // An outdated verifier scores differently and attests a root the others don't.
      await requireCurrentVerifier({
        command: 'start',
        currentVersion: pkg.version,
        skip: options.skipVersionCheck === true,
        strictWhenUnavailable: false,
        warn: (text) => log(chalk.yellow(text)),
      })
      const client = createKbfRoundClient(config)
      const signer = await resolveAuditorSigner({ config: config.verifier, dataDir: globalOptions.dataDir, keystoreFlag: options.keystore })
      if (!await client.isVerifier(signer.address)) {
        throw new Error(`${signer.address} is not an approved verifier on ${client.contractAddress}`)
      }
      const keys = await loadOrCreateEncryptionKey(globalOptions.dataDir)
      if (!isUsableEncryptionKey(keys.publicKey)) throw new Error('the stored encryption key cannot receive envelopes; remove verifier/round/encryption-key.json to make a new one')
      const onChainKey = await client.encryptionKey(signer.address)
      if (isZeroHash(onChainKey) || onChainKey.toLowerCase() !== keys.publicKey.toLowerCase()) {
        log(`publishing encryption key ${keys.publicKey}`)
        await client.setEncryptionKey(signer.wallet, keys.publicKey)
      }

      const collect = options.collect !== false
      const buyerPort = Number(options.buyerPort ?? config.buyer.proxyPort)
      if (collect && options.buyer !== false) await startGatewayBuyer(buyerPort, globalOptions, log)
      const responseAuth = collect ? await openResponseAuthReader({ dataDir: globalOptions.dataDir }) : null
      if (responseAuth) setupShutdownHandler(async () => responseAuth.close())

      const storage = roundStorageFromEnv()
      const targetBindings = targetBindingsFromRegistry(createSellerRegistryClient(config))
      const bindings = targetBindings.reader
      const publisherContext = createPublisherContext({
        config, dataDir: globalOptions.dataDir, client, signer: signer.wallet, storage, bindings: targetBindings, buyerPort, log,
      })
      log(chalk.bold(`verifier ${signer.address} on ${client.contractAddress}${collect ? '' : ' (attest only)'}`))
      let stopped = false
      setupShutdownHandler(async () => { stopped = true })
      while (!stopped) {
        try {
          const collector = await collectorForPass({
            responseAuth,
            loadBuyerUrl: async () => (await loadBuyerProxySnapshot(globalOptions.dataDir)).baseUrl,
            log,
          })
          await verifierTick({
            client,
            signer: signer.wallet,
            address: signer.address,
            encryptionPrivateKey: keys.privateKey,
            storage,
            bindings,
            stateDir: join(globalOptions.dataDir, 'verifier', 'round', 'epochs'),
            collector,
            maxRequestsPerEpoch,
            log,
          })
        } catch (error) {
          log(chalk.yellow(`pass failed: ${error instanceof Error ? error.message : String(error)}`))
        }
        // Liveness without the publisher: reveal the escrowed bank key, and take over an epoch
        // whose publisher never planned it (needs the buyer, to build a bank and find targets).
        try {
          await keyEscrowTick({ client, signer: signer.wallet, address: signer.address, encryptionPrivateKey: keys.privateKey, storage, log })
        } catch (error) {
          log(chalk.yellow(`key escrow pass failed: ${error instanceof Error ? error.message : String(error)}`))
        }
        if (collect) {
          try {
            await fallbackPublisherTick({ ...publisherContext, address: signer.address })
          } catch (error) {
            log(chalk.yellow(`fallback publisher pass failed: ${error instanceof Error ? error.message : String(error)}`))
          }
        }
        await new Promise((resolve) => setTimeout(resolve, interval))
      }
    })
}
