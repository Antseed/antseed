import { join } from 'node:path'
import chalk from 'chalk'
import type { Command } from 'commander'
import { getAddress } from 'ethers'
import { modelHash, serviceHash, type KbfModel } from '@antseed/node/payments'
import { loadConfig } from '../../../config/loader.js'
import type { AntseedConfig } from '../../../config/types.js'
import { resolveAuditPriceCaps } from '../../../verifier/audit-price.js'
import { verifierModelServices } from '../../../verifier/model-config.js'
import { buildModelReference } from '../../../verifier/model-reference.js'
import { classifyVerificationTargetServices, loadBuyerProxySnapshot } from '../../../verifier/model-run.js'
import {
  loadConfiguredVerifierModelCatalog,
  loadHighestEndpointPrice,
  loadVerifierModelCatalog,
} from '../../../verifier/openrouter-catalog.js'
import { publisherTick } from '../../../verifier/round/publisher-daemon.js'
import { boundTargets, sellerRegistryBindingReader, type SellerBindingReader } from '../../../verifier/round/seller-binding.js'
import { roundStorageFromEnv } from '../../../verifier/round/storage.js'
import type { EpochBankV1, RoundTargetV1 } from '../../../verifier/round/types.js'
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

/** Builds a fresh KBF reference for every audited model, skipping probes used in recent banks. */
export async function buildEpochBank(input: {
  config: AntseedConfig
  epoch: bigint
  models: KbfModel[]
  excludedProbeIds: ReadonlySet<string>
  referencesDir: string
  buyerPort: number
  log: (message: string) => void
}): Promise<EpochBankV1> {
  const catalog = await loadConfiguredVerifierModelCatalog(input.config.verifier)
  const bank: EpochBankV1 = { kind: 'antseed-kbf-epoch-bank', version: 1, epoch: input.epoch.toString(), models: {} }
  for (const model of input.models) {
    try {
      const built = await buildModelReference({
        model: model.service,
        referencesDir: join(input.referencesDir, input.epoch.toString()),
        config: input.config.verifier,
        catalog,
        buyerProxyPort: input.buyerPort,
        excludedProbeIds: input.excludedProbeIds,
        log: (message) => input.log(`[bank:${model.service}] ${message}`),
      })
      await built.finalize()
      bank.models[model.service] = built.reference
    } catch (error) {
      input.log(chalk.yellow(`[bank:${model.service}] skipped: ${error instanceof Error ? error.message : String(error)}`))
    }
  }
  if (Object.keys(bank.models).length === 0) throw new Error(`no model reference could be built for epoch ${input.epoch}`)
  return bank
}

/**
 * Staked sellers the buyer can reach that advertise an audited model at or below its genuine
 * price and sign their responses.
 */
export async function discoverRoundTargets(input: {
  config: AntseedConfig
  dataDir: string
  models: KbfModel[]
  bindings: TargetBindings
  log: (message: string) => void
}): Promise<RoundTargetV1[]> {
  const { peers } = await loadBuyerProxySnapshot(input.dataDir)
  const caps = await resolveAuditPriceCaps(
    input.config.verifier,
    input.models.map((model) => model.service),
    () => loadVerifierModelCatalog(input.config.verifier),
    (upstreamModel) => loadHighestEndpointPrice(input.config.verifier, upstreamModel),
  )
  for (const [model, reason] of caps.unpriced) input.log(chalk.yellow(`[targets] ${model} not audited: ${reason}`))
  const targets: RoundTargetV1[] = []
  for (const peer of peers) {
    if (!peer.onChainAgentId || !(peer.onChainPoolPowerShareBps && peer.onChainPoolPowerShareBps > 0)) continue
    for (const model of input.models) {
      const priceCap = caps.caps.get(model.service)
      if (!priceCap || modelHash(model.service) !== model.modelHash.toLowerCase()) continue
      const eligibility = classifyVerificationTargetServices(
        peer,
        verifierModelServices(input.config.verifier, model.service),
        { minReputation: input.config.buyer.minPeerReputation, priceCap },
      )
      if (!eligibility.eligible || !eligibility.service) continue
      const service = eligibility.service.trim().toLowerCase()
      targets.push({
        agentId: String(peer.onChainAgentId),
        peerId: getAddress(`0x${peer.peerId.replace(/^0x/, '')}`).slice(2).toLowerCase(),
        service,
        serviceHash: serviceHash(service),
        model: model.service,
        modelHash: model.modelHash.toLowerCase(),
      })
    }
  }
  const bound = await bindRoundTargets(targets, input.bindings, input.log)
  input.log(`[targets] ${bound.length} targets from ${peers.length} peers`)
  return bound
}

/** Where the publisher checks seller-to-agent bindings: verifiers drop unbound targets, so never plan them. */
export interface TargetBindings {
  reader: SellerBindingReader
  latestBlock: () => Promise<bigint>
}

export function targetBindingsFromConfig(config: AntseedConfig): TargetBindings {
  const registry = createSellerRegistryClient(config)
  return {
    reader: sellerRegistryBindingReader(registry),
    latestBlock: async () => BigInt(await registry.provider.getBlockNumber()),
  }
}

/** The targets whose peer and agent are bound to each other at the latest block. */
export async function bindRoundTargets(
  targets: RoundTargetV1[],
  bindings: TargetBindings,
  log: (message: string) => void,
): Promise<RoundTargetV1[]> {
  if (targets.length === 0) return targets
  return boundTargets(bindings.reader, targets, await bindings.latestBlock(), (message) => log(`[targets] ${message}`))
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
      const bindings = targetBindingsFromConfig(config)
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
