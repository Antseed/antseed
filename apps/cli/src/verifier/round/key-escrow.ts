import type { AbstractSigner } from 'ethers'
import { isZeroHash, kbfEpochDeadlines, type KbfRoundClient } from '@antseed/node/payments'
import { openKeyShare, recoverBankKey, type KeySharesFileV1 } from './key-shares.js'
import type { RoundStorage } from './storage.js'

/**
 * A verifier's side of the bank-key escrow: if the key is still hidden a little after the backup
 * deadline, post this verifier's share, and once enough shares are on-chain, rebuild the key and
 * reveal it so every verifier can score and attest in time.
 */
export interface KeyEscrowContext {
  client: Pick<
    KbfRoundClient,
    | 'currentEpoch' | 'epochInfo' | 'epochDuration' | 'now' | 'keySharesCommits' | 'keyShareRevealed'
    | 'revealKeyShare' | 'keyShareReveals' | 'revealBankKey'
  >
  signer: AbstractSigner
  address: string
  encryptionPrivateKey: string
  storage: RoundStorage
  log: (message: string) => void
  /** Seconds after the backup deadline the publisher gets to reveal the key itself. Default 600. */
  revealDelaySeconds?: number
}

export const DEFAULT_KEY_REVEAL_DELAY_SECONDS = 600

export async function keyEscrowTick(context: KeyEscrowContext): Promise<void> {
  const { client } = context
  const epoch = await client.currentEpoch()
  const info = await client.epochInfo(epoch)
  if (info.voided || !isZeroHash(info.bankKey) || isZeroHash(info.keySharesHash)) return
  const deadlines = kbfEpochDeadlines(info, await client.epochDuration())
  const now = await client.now()
  const delay = context.revealDelaySeconds ?? DEFAULT_KEY_REVEAL_DELAY_SECONDS
  if (now < deadlines.backupDeadline + delay || now >= deadlines.attestDeadline) return

  const commit = (await client.keySharesCommits(epoch)).filter((entry) => entry.hash === info.keySharesHash).at(-1)
  if (!commit) throw new Error(`no key-share file event for epoch ${epoch}`)
  const file = JSON.parse((await context.storage.get(commit.uri, commit.hash)).toString('utf8')) as KeySharesFileV1
  if (file.kind !== 'antseed-kbf-key-shares' || file.version !== 1 || file.epoch !== epoch.toString()) {
    throw new Error(`key-share file for epoch ${epoch} is malformed`)
  }

  if (!await client.keyShareRevealed(epoch, context.address)) {
    const share = openKeyShare(file, context.address, context.encryptionPrivateKey)
    if (share) {
      const hash = await client.revealKeyShare(context.signer, epoch, share)
      context.log(`epoch ${epoch}: bank key still hidden; posted this verifier's key share (${hash})`)
    }
  }

  const key = recoverBankKey(file, await client.keyShareReveals(epoch))
  if (!key) return
  if (!isZeroHash((await client.epochInfo(epoch)).bankKey)) return
  const hash = await client.revealBankKey(context.signer, epoch, key)
  context.log(`epoch ${epoch}: rebuilt the bank key from ${file.threshold} shares and revealed it (${hash})`)
}
