import chalk from 'chalk'
import { getAddress, type AbstractProvider } from 'ethers'
import { modelHash, serviceHash, type KbfModel } from '@antseed/node/payments'
import type { AntseedConfig } from '../../config/types.js'
import { resolveAuditPriceCaps } from '../audit-price.js'
import { verifierModelServices } from '../model-config.js'
import { classifyVerificationTargetServices, loadBuyerProxySnapshot } from '../model-run.js'
import { loadHighestEndpointPrice, loadVerifierModelCatalog } from '../openrouter-catalog.js'
import { boundTargets, sellerRegistryBindingReader, type SellerBindingReader } from './seller-binding.js'
import type { RoundTargetV1 } from './types.js'

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

export function targetBindingsFromRegistry(registry: { provider: AbstractProvider; contractAddress: string }): TargetBindings {
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
