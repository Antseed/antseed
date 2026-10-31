import { AbiCoder, concat, getAddress, keccak256 } from 'ethers'
import { VERIFIER_VERDICT } from '@antseed/node/payments'
import type { RoundVerdict } from './types.js'

/**
 * Results roots in the exact format AntseedKbfVerification verifies: OpenZeppelin double-hashed
 * leaves, sorted-pair hashing, an odd node moves up unchanged. Leaves are sorted by hash first,
 * so every verifier builds the same tree from the same set of results.
 */

const LEAF_SERVICE = 1
const LEAF_COLLECTOR = 2
const abi = AbiCoder.defaultAbiCoder()

export function verdictCode(verdict: RoundVerdict): number {
  return VERIFIER_VERDICT[verdict]
}

export function serviceLeaf(
  epoch: bigint,
  result: { agentId: bigint; serviceHash: string; modelHash: string; verdict: RoundVerdict },
): string {
  return keccak256(
    keccak256(
      abi.encode(
        ['uint8', 'uint256', 'uint256', 'bytes32', 'bytes32', 'uint8'],
        [LEAF_SERVICE, epoch, result.agentId, result.serviceHash, result.modelHash, verdictCode(result.verdict)],
      ),
    ),
  )
}

export function collectorLeaf(epoch: bigint, collector: string, slices: number, totalSlices: number): string {
  return keccak256(
    keccak256(
      abi.encode(
        ['uint8', 'uint256', 'address', 'uint32', 'uint32'],
        [LEAF_COLLECTOR, epoch, getAddress(collector), slices, totalSlices],
      ),
    ),
  )
}

function hashPair(left: string, right: string): string {
  return BigInt(left) < BigInt(right) ? keccak256(concat([left, right])) : keccak256(concat([right, left]))
}

export class ResultsTree {
  readonly leaves: string[]
  private readonly layers: string[][]

  constructor(leaves: readonly string[]) {
    if (leaves.length === 0) throw new Error('results tree needs at least one leaf')
    const unique = [...new Set(leaves.map((leaf) => leaf.toLowerCase()))]
    this.leaves = unique.sort((left, right) => (BigInt(left) < BigInt(right) ? -1 : 1))
    this.layers = [this.leaves]
    while (this.layers[this.layers.length - 1]!.length > 1) {
      const layer = this.layers[this.layers.length - 1]!
      const next: string[] = []
      for (let i = 0; i < layer.length; i += 2) {
        next.push(i + 1 < layer.length ? hashPair(layer[i]!, layer[i + 1]!) : layer[i]!)
      }
      this.layers.push(next)
    }
  }

  get root(): string {
    return this.layers[this.layers.length - 1]![0]!
  }

  proof(leaf: string): string[] {
    let index = this.leaves.indexOf(leaf.toLowerCase())
    if (index < 0) throw new Error(`leaf ${leaf} is not in the tree`)
    const path: string[] = []
    for (let level = 0; level < this.layers.length - 1; level++) {
      const layer = this.layers[level]!
      const sibling = index ^ 1
      if (sibling < layer.length) path.push(layer[sibling]!)
      index = Math.floor(index / 2)
    }
    return path
  }
}

export function verifyProof(root: string, leaf: string, proof: readonly string[]): boolean {
  let computed = leaf.toLowerCase()
  for (const node of proof) computed = hashPair(computed, node)
  return computed === root.toLowerCase()
}
