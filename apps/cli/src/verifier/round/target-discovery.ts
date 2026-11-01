import chalk from 'chalk'
import { getAddress, type AbstractProvider } from 'ethers'
import type { PeerInfo } from '@antseed/node'
import { modelHash, serviceHash, type KbfModel } from '@antseed/node/payments'
import type { AntseedConfig } from '../../config/types.js'
import { resolveAuditPriceCaps, type AuditPriceCap } from '../audit-price.js'
import { verifierModelServices } from '../model-config.js'
import { classifyVerificationTarget, classifyVerificationTargetServices, loadBuyerProxySnapshot } from '../model-run.js'
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
  // No peers is an answer here: the publisher keeps looking for a while, then plans an empty round.
  const { peers } = await loadBuyerProxySnapshot(input.dataDir, { allowEmptyPeers: true })
  if (peers.length === 0) {
    input.log('[targets] the buyer has discovered no peers yet')
    return []
  }
  const caps = await auditCaps(input.config, input.models)
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

/**
 * Where reference prices come from when `verifier.referenceEndpoint` is not set: OpenRouter's
 * public catalog, which needs no key. A verifier can collect without a reference source of its
 * own, and its spending is still capped by real reference prices.
 */
export const PUBLIC_PRICE_CATALOG = { baseUrl: 'https://openrouter.ai/api/v1', sourceId: 'openrouter', trust: 'trusted' as const }

function auditCaps(config: AntseedConfig, models: readonly KbfModel[]) {
  const verifier = config.verifier?.referenceEndpoint ? config.verifier : { ...config.verifier, referenceEndpoint: PUBLIC_PRICE_CATALOG }
  return resolveAuditPriceCaps(
    verifier,
    models.map((model) => model.service),
    () => loadVerifierModelCatalog(verifier),
    (upstreamModel) => loadHighestEndpointPrice(verifier, upstreamModel),
  )
}

/**
 * The targets this verifier may pay for right now, by its own audit policy rather than the
 * publisher's: the seller is still discovered by this verifier's buyer, its current offer for the
 * target's service is at or below this verifier's audit price cap for the model, and its reputation
 * meets the buyer's minimum. A seller that raised its price after the plan, or a publisher with a
 * looser policy, never gets paid above the operator's caps. The rest are logged and left alone.
 */
export async function affordableRoundTargets(input: {
  config: AntseedConfig
  dataDir: string
  models: KbfModel[]
  targets: readonly RoundTargetV1[]
  log: (message: string) => void
}): Promise<RoundTargetV1[]> {
  if (input.targets.length === 0) return []
  const { peers } = await loadBuyerProxySnapshot(input.dataDir, { allowEmptyPeers: true })
  return affordableTargets({
    targets: input.targets,
    peers,
    caps: await auditCaps(input.config, input.models),
    minReputation: input.config.buyer.minPeerReputation,
    log: input.log,
  })
}

/** `affordableRoundTargets` on given peers and caps. */
export function affordableTargets(input: {
  targets: readonly RoundTargetV1[]
  peers: readonly PeerInfo[]
  caps: { caps: ReadonlyMap<string, AuditPriceCap>; unpriced: ReadonlyMap<string, string> }
  minReputation: number
  log: (message: string) => void
}): RoundTargetV1[] {
  const byPeer = new Map(input.peers.map((peer) => [peer.peerId.replace(/^0x/, '').toLowerCase(), peer]))
  return input.targets.filter((target) => {
    const refuse = (reason: string) => {
      input.log(`not buying from ${target.agentId}:${target.service}: ${reason}`)
      return false
    }
    const peer = byPeer.get(target.peerId.replace(/^0x/, '').toLowerCase())
    if (!peer) return refuse('its seller is not among the buyer\'s discovered peers, so its current price is unknown')
    const priceCap = input.caps.caps.get(target.model)
    if (!priceCap) return refuse(input.caps.unpriced.get(target.model) ?? `no audit price cap for ${target.model}`)
    const eligibility = classifyVerificationTarget(peer, target.service.trim().toLowerCase(), { minReputation: input.minReputation, priceCap })
    return eligibility.eligible || refuse(eligibility.reason)
  })
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
