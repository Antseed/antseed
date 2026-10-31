import pkg from '../../../../package.json' with { type: 'json' }
import { chmod, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import chalk from 'chalk'
import type { Command } from 'commander'
import { isZeroHash } from '@antseed/node/payments'
import { loadConfig } from '../../../config/loader.js'
import { requireCurrentVerifier } from '../../../verifier/release-check.js'
import { writeJsonAtomic } from '../../../verifier/atomic-files.js'
import { loadBuyerProxySnapshot } from '../../../verifier/model-run.js'
import { openResponseAuthReader } from '../../../verifier/response-auth-reader.js'
import { encryptionPublicKey, generateEncryptionKeyPair } from '../../../verifier/round/sealing.js'
import { roundStorageFromEnv } from '../../../verifier/round/storage.js'
import { verifierTick } from '../../../verifier/round/verifier-daemon.js'
import { createKbfRoundClient } from '../../payment-utils.js'
import { setupShutdownHandler } from '../../shutdown.js'
import { startGatewayBuyer } from '../gateway/shared.js'
import { getGlobalOptions } from '../types.js'
import { resolveAuditorSigner } from './auditor-identity.js'

interface StartOptions {
  keystore?: string
  buyer?: boolean
  buyerPort?: string
  interval?: string
  collect?: boolean
  skipVersionCheck?: boolean
}

/** The verifier's X25519 key pair for question envelopes, created once in the data dir. */
export async function loadOrCreateEncryptionKey(dataDir: string): Promise<{ publicKey: string; privateKey: string }> {
  const path = join(dataDir, 'verifier', 'round', 'encryption-key.json')
  try {
    const stored = JSON.parse(await readFile(path, 'utf8')) as { privateKey: string }
    return { privateKey: stored.privateKey, publicKey: encryptionPublicKey(stored.privateKey) }
  } catch {
    const pair = generateEncryptionKeyPair()
    await mkdir(join(dataDir, 'verifier', 'round'), { recursive: true })
    await writeJsonAtomic(path, { privateKey: pair.privateKey })
    await chmod(path, 0o600)
    return pair
  }
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
    .option('--skip-version-check', 'start even if this CLI is older than the latest release (it may attest a different results root)')
    .action(async (options: StartOptions, command: Command) => {
      const globalOptions = getGlobalOptions(command)
      const config = await loadConfig(globalOptions.config)
      const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`)
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
      const interval = Math.max(10, Number(options.interval ?? '60')) * 1_000
      log(chalk.bold(`verifier ${signer.address} on ${client.contractAddress}${collect ? '' : ' (attest only)'}`))
      let stopped = false
      setupShutdownHandler(async () => { stopped = true })
      while (!stopped) {
        try {
          const buyerUrl = collect ? (await loadBuyerProxySnapshot(globalOptions.dataDir)).baseUrl : ''
          await verifierTick({
            client,
            signer: signer.wallet,
            address: signer.address,
            encryptionPrivateKey: keys.privateKey,
            storage,
            stateDir: join(globalOptions.dataDir, 'verifier', 'round', 'epochs'),
            collector: collect && responseAuth ? { buyerUrl, responseAuth, log } : null,
            log,
          })
        } catch (error) {
          log(chalk.yellow(`pass failed: ${error instanceof Error ? error.message : String(error)}`))
        }
        await new Promise((resolve) => setTimeout(resolve, interval))
      }
    })
}
