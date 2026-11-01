import type { KbfReferenceV1 } from '@antseed/fingerprints'
import { isZeroHash, type KbfRoundClient } from '@antseed/node/payments'
import { committedBankUri, openCommittedBank, UnusableBankError } from './round-files.js'
import type { RoundStorage } from './storage.js'
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
    const info = { ...await input.client.epochInfo(epoch), epoch }
    if (isZeroHash(info.bankKey) || isZeroHash(info.bankHash)) continue
    let bank: EpochBankV1
    try {
      bank = await openCommittedBank(input, info)
    } catch (error) {
      // An epoch whose bank the revealed key does not open has nothing to offer; look further back.
      if (error instanceof UnusableBankError) continue
      throw error
    }
    const reference = Object.entries(bank.models).find(([model]) => model.trim().toLowerCase() === wanted)?.[1]
    if (reference) return { epoch, bankUri: await committedBankUri(input.client, info), reference }
    if (epoch === 0n) break
  }
  throw new Error(input.epoch === undefined
    ? `no revealed question bank in the last ${input.lookback ?? 8} epochs includes ${input.model}`
    : `epoch ${input.epoch} has no revealed question bank for ${input.model}`)
}
