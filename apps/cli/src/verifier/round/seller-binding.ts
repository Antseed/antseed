import { Contract, getAddress, type AbstractProvider } from 'ethers'
import type { RoundTargetV1 } from './types.js'

/**
 * Whether a target's seller peer and agent point at each other on the seller registry. Verdicts
 * are recorded against the agent while answers are signed by the peer, so a target the
 * publisher pairs with someone else's agent must never be scored.
 */
export interface SellerBindingReader {
  /** Reads at `blockTag`, so every verifier evaluates the same chain state. */
  isBound(peerId: string, agentId: bigint, blockTag: bigint): Promise<boolean>
}

const REGISTRY_ABI = [
  'function getAgentId(address seller) external view returns (uint256)',
  'function agentSeller(uint256 agentId) external view returns (address)',
] as const

/** Reads the AntseedSellerRegistry binding, the same two-way check `SellerRegistryClient.isRegisteredSeller` makes. */
export function sellerRegistryBindingReader(registry: { provider: AbstractProvider; contractAddress: string }): SellerBindingReader {
  const contract = new Contract(registry.contractAddress, REGISTRY_ABI, registry.provider)
  return {
    async isBound(peerId, agentId, blockTag) {
      if (agentId === 0n) return false
      const seller = getAddress(`0x${peerId.replace(/^0x/i, '')}`)
      const overrides = { blockTag: Number(blockTag) }
      const [boundAgentId, boundSeller] = await Promise.all([
        contract.getFunction('getAgentId')(seller, overrides) as Promise<bigint>,
        contract.getFunction('agentSeller')(agentId, overrides) as Promise<string>,
      ])
      return BigInt(boundAgentId) === agentId && boundSeller.toLowerCase() === seller.toLowerCase()
    },
  }
}

/**
 * The targets whose seller binding holds at `blockTag`. A failed read throws (the caller retries
 * later) rather than dropping the target, so a flaky RPC never changes the results.
 */
export async function boundTargets(
  reader: SellerBindingReader,
  targets: readonly RoundTargetV1[],
  blockTag: bigint,
  log: (message: string) => void,
): Promise<RoundTargetV1[]> {
  const checks = await Promise.all(targets.map((target) => reader.isBound(target.peerId, BigInt(target.agentId), blockTag)))
  return targets.filter((target, index) => {
    if (!checks[index]) log(`target ${target.agentId}/${target.service}: peer ${target.peerId} is not bound to agent ${target.agentId}; skipped`)
    return checks[index]
  })
}
