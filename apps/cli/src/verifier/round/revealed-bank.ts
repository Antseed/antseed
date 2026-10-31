import type { KbfReferenceV1 } from '@antseed/fingerprints'
import { isZeroHash, type KbfRoundClient } from '@antseed/node/payments'
import { openBank } from './sealing.js'
import { ROUND_FILE_MAX_BYTES, type RoundStorage } from './storage.js'
import type { EpochBankV1 } from './types.js'

export interface RevealedBankReference {
  epoch: bigint
  bankUri: string
  reference: KbfReferenceV1
}

/**
 * The model's reference from the newest epoch whose bank key has been revealed, looking back at most
 * `lookback` epochs (or exactly `epoch` when given). The bank is checked against its on-chain hash
 * before it is decrypted.
 */
export async function loadRevealedBankReference(input: {
  client: Pick<KbfRoundClient, 'currentEpoch' | 'epochInfo' | 'bankCommits'>
  storage: Pick<RoundStorage, 'get'>
  model: string
  epoch?: bigint
  lookback?: number
}): Promise<RevealedBankReference> {
  const wanted = input.model.trim().toLowerCase()
  const newest = input.epoch ?? await input.client.currentEpoch()
  const oldest = input.epoch ?? (newest > BigInt(input.lookback ?? 8) ? newest - BigInt(input.lookback ?? 8) : 0n)
  for (let epoch = newest; epoch >= oldest; epoch--) {
    const info = await input.client.epochInfo(epoch)
    if (isZeroHash(info.bankKey) || isZeroHash(info.bankHash)) continue
    const commit = (await input.client.bankCommits(epoch)).filter((entry) => entry.bankHash === info.bankHash).at(-1)
    if (!commit) continue
    const bank = JSON.parse(openBank(info.bankKey, await input.storage.get(commit.bankUri, info.bankHash, ROUND_FILE_MAX_BYTES.bank)).toString('utf8')) as EpochBankV1
    const reference = Object.entries(bank.models).find(([model]) => model.trim().toLowerCase() === wanted)?.[1]
    if (reference) return { epoch, bankUri: commit.bankUri, reference }
    if (epoch === 0n) break
  }
  throw new Error(input.epoch === undefined
    ? `no revealed question bank in the last ${input.lookback ?? 8} epochs includes ${input.model}`
    : `epoch ${input.epoch} has no revealed question bank for ${input.model}`)
}
