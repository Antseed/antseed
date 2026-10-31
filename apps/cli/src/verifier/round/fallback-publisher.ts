import { AbiCoder, keccak256 } from 'ethers'
import { isZeroHash, kbfEpochDeadlines } from '@antseed/node/payments'
import { advanceEpochAsPublisher, prepareBank, type PublisherDaemonContext } from './publisher-daemon.js'

/**
 * Lets verifiers carry a round whose publisher went missing. When no plan is committed
 * `publisherGraceSeconds` into the epoch (or after the previous takeover), verifiers take turns,
 * in an order seeded by the epoch, to build their own bank and take the epoch over; the one that
 * does then runs the rest of the round exactly like the publisher.
 */
export interface FallbackPublisherContext extends PublisherDaemonContext {
  /** This verifier's address. */
  address: string
  /** Seconds between consecutive verifiers' turns, so they do not all build a bank at once. Default 600. */
  turnSeconds?: number
}

export const DEFAULT_TAKEOVER_TURN_SECONDS = 600

/**
 * Unix time this verifier may take `epoch` over: grace after `since`, then one turn per verifier
 * ranked ahead of it. Null when it is not among `verifiers`.
 */
export function takeoverTime(input: {
  epoch: bigint
  since: number
  graceSeconds: number
  turnSeconds: number
  verifiers: readonly string[]
  address: string
}): number | null {
  const coder = AbiCoder.defaultAbiCoder()
  const rank = (address: string) => keccak256(coder.encode(['uint256', 'uint256', 'address'], [input.epoch, input.since, address]))
  const ordered = [...input.verifiers].sort((a, b) => (rank(a) < rank(b) ? -1 : rank(a) > rank(b) ? 1 : 0))
  const index = ordered.findIndex((entry) => entry.toLowerCase() === input.address.toLowerCase())
  if (index < 0) return null
  return input.since + input.graceSeconds + index * input.turnSeconds
}

export async function fallbackPublisherTick(context: FallbackPublisherContext): Promise<void> {
  const { client } = context
  const epoch = await client.currentEpoch()
  const info = await client.epochInfo(epoch)
  const deadlines = kbfEpochDeadlines(info, await client.epochDuration())
  const now = await client.now()
  if (info.voided) return
  if (info.publisher.toLowerCase() === context.address.toLowerCase()) {
    await advanceEpochAsPublisher(context, info, deadlines, now)
    return
  }
  if (!isZeroHash(info.planHash) || now >= deadlines.commitDeadline) return
  const since = info.takenOverAt || info.startedAt
  const turn = takeoverTime({
    epoch,
    since,
    graceSeconds: await client.publisherGraceSeconds(),
    turnSeconds: context.turnSeconds ?? DEFAULT_TAKEOVER_TURN_SECONDS,
    verifiers: info.seedBlock !== 0n ? await client.epochVerifiers(epoch) : await client.verifiers(),
    address: context.address,
  })
  if (turn === null || now < turn) return
  context.log(`epoch ${epoch}: no plan from the publisher; taking the epoch over`)
  await prepareBank(context, epoch, 'takeover')
}
