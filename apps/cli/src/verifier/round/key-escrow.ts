import type { AbstractSigner } from 'ethers'
import { isZeroHash, kbfEpochDeadlines, type KbfEpochInfo, type KbfRoundClient } from '@antseed/node/payments'
import { checkKeySharesFile, openKeyShare, recoverBankKey, type KeySharesFileV2 } from './key-shares.js'
import { ROUND_FILE_MAX_BYTES, type RoundStorage } from './storage.js'

/**
 * A verifier's side of the bank-key escrow: if the key is still hidden a little after the backup
 * deadline, post this verifier's share, and once enough shares are on-chain, rebuild the key and
 * reveal it so every verifier can score and attest in time.
 */
export interface KeyEscrowContext {
  client: Pick<
    KbfRoundClient,
    | 'currentEpoch' | 'epochInfo' | 'epochDuration' | 'now' | 'keySharesCommits' | 'keyShareRevealed'
    | 'revealKeyShare' | 'keyShareReveals' | 'revealBankKey' | 'threshold' | 'epochVerifiers'
  >
  signer: AbstractSigner
  address: string
  encryptionPrivateKey: string
  storage: RoundStorage
  log: (message: string) => void
  /**
   * Seconds after the backup deadline the publisher gets to reveal the key itself. Default 600;
   * always capped at a quarter of the attestation window so shares, recovery and attesting fit.
   */
  revealDelaySeconds?: number
}

export const DEFAULT_KEY_REVEAL_DELAY_SECONDS = 600

/** How long verifiers wait for the publisher's own reveal before posting shares. */
export function keyRevealDelay(attestSeconds: number, requested = DEFAULT_KEY_REVEAL_DELAY_SECONDS): number {
  return Math.max(0, Math.min(requested, Math.floor(attestSeconds / 4)))
}

export async function keyEscrowTick(context: KeyEscrowContext): Promise<void> {
  const { client } = context
  const epoch = await client.currentEpoch()
  const info = await client.epochInfo(epoch)
  if (info.voided || !info.planActive || !isZeroHash(info.bankKey) || isZeroHash(info.keySharesHash)) return
  const deadlines = kbfEpochDeadlines(info, await client.epochDuration())
  const now = await client.now()
  const delay = keyRevealDelay(info.schedule.attestSeconds, context.revealDelaySeconds)
  if (now < deadlines.backupDeadline + delay || now >= deadlines.attestDeadline) return

  const file = await loadKeySharesFile(context, info)

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

/**
 * The epoch's current key-share file, fetched against its on-chain hash and checked against the
 * chain: the epoch's bank key, threshold and verifiers (`checkKeySharesFile`).
 */
export async function loadKeySharesFile(
  context: { client: Pick<KbfRoundClient, 'keySharesCommits' | 'threshold' | 'epochVerifiers'>; storage: RoundStorage },
  info: KbfEpochInfo,
): Promise<KeySharesFileV2> {
  const commit = (await context.client.keySharesCommits(info.epoch, undefined, info.publisher))
    .filter((entry) => entry.hash === info.keySharesHash).at(-1)
  if (!commit) throw new Error(`no key-share file event for epoch ${info.epoch}`)
  const bytes = await context.storage.get(commit.uri, commit.hash, ROUND_FILE_MAX_BYTES.keyShares)
  let value: unknown
  try {
    value = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new Error(`key-share file for epoch ${info.epoch} is not JSON`)
  }
  return checkKeySharesFile(value, {
    epoch: info.epoch,
    bankKeyHash: info.bankKeyHash,
    threshold: await context.client.threshold(info.epoch),
    members: await context.client.epochVerifiers(info.epoch),
  })
}
