/**
 * Payment-channel close flow, as the desktop's Activity view runs it:
 *   1. ask the seller to close cooperatively (instant, no transaction);
 *   2. if that fails or the seller cannot, the authorized wallet requests an
 *      on-chain close (AntseedChannels.requestClose);
 *   3. after the 15-minute grace period it withdraws the unused reserve
 *      (AntseedChannels.withdraw), which returns to the workspace balance.
 * Both transactions must come from the workspace's authorized wallet.
 */
import type { Channel, Usdc, Wallet } from '../api/types'
import { formatUsd, usdcToNumber } from './format'

/** AntseedChannels' grace period between a close request and the withdrawal (mirrors the gateway's CHANNEL_CLOSE_GRACE_MS). */
export const CHANNEL_CLOSE_GRACE_MS = 15 * 60_000

export type ChannelAction = 'cooperative' | 'on-chain' | 'withdraw' | 'none'

/** Statuses the gateway still counts as holding funds. */
export function isOpenChannel(channel: Pick<Channel, 'status'>): boolean {
  return channel.status === 'active' || channel.status === 'open' || channel.status === 'closing' || channel.status === 'withdrawable'
}

/**
 * The close action a row offers. A cooperative close is tried first while the
 * seller supports it and it has not failed for this channel; otherwise the
 * on-chain request. A requested close offers nothing until the grace period
 * ends, then the withdrawal.
 */
export function channelAction(channel: Channel, cooperativeFailed: boolean): ChannelAction {
  if (channel.status === 'withdrawable') return 'withdraw'
  if (channel.status !== 'active' && channel.status !== 'open') return 'none'
  return channel.canCooperativeClose && !cooperativeFailed ? 'cooperative' : 'on-chain'
}

/** When the unused reserve of a requested close can be withdrawn (ms), or null. */
export function withdrawableAt(channel: Pick<Channel, 'closeRequestedAt'>): number | null {
  return channel.closeRequestedAt === null ? null : channel.closeRequestedAt + CHANNEL_CLOSE_GRACE_MS
}

/** "12 min", "45 s": time left until `at`, never negative. */
export function formatCountdown(at: number, now = Date.now()): string {
  const left = Math.max(0, at - now)
  if (left >= 60_000) return `${Math.ceil(left / 60_000)} min`
  return `${Math.ceil(left / 1000)} s`
}

/** What a row's status badge says, e.g. "closing · 12 min left". */
export function channelStatusLabel(channel: Channel, now = Date.now()): string {
  if (channel.status === 'closing') {
    const at = withdrawableAt(channel)
    return at === null ? 'closing' : `closing · ${formatCountdown(at, now)} left`
  }
  if (channel.status === 'withdrawable') return 'ready to withdraw'
  if (channel.status === 'timedout') return 'withdrawn'
  return channel.status
}


export type BadgeTone = 'success' | 'warning' | 'info' | 'neutral'

export function channelStatusTone(channel: Pick<Channel, 'status'>): BadgeTone {
  if (channel.status === 'active' || channel.status === 'open') return 'success'
  if (channel.status === 'withdrawable') return 'warning'
  if (channel.status === 'closing') return 'info'
  return 'neutral'
}

type ChannelAmounts = Pick<Channel, 'reserved' | 'spent' | 'held' | 'unsettled'>

/**
 * What closing a channel returns to the balance, as a range. A withdraw
 * returns what the chain holds (deposit − settled), less whatever the seller
 * settles first with the authorizations it holds: `max` if it settles
 * nothing more, `min` if it settles all of them. Before the chain is read
 * (or from an older gateway) both are reserved minus spent.
 */
export function returnsOnClose(channel: ChannelAmounts): { min: number; max: number } {
  if (channel.held === null || channel.held === undefined) {
    const left = Math.max(0, usdcToNumber(channel.reserved) - usdcToNumber(channel.spent))
    return { min: left, max: left }
  }
  const max = usdcToNumber(channel.held)
  if (channel.unsettled === null || channel.unsettled === undefined) return { min: 0, max }
  return { min: Math.max(0, max - usdcToNumber(channel.unsettled)), max }
}

/** What certainly comes back on close: nothing the seller can still settle. */
export function unspent(channel: ChannelAmounts): number {
  return returnsOnClose(channel).min
}

/** "$0.70", "up to $1.00" or "$0.70–$1.00". */
export function formatReturns(channel: ChannelAmounts): string {
  const { min, max } = returnsOnClose(channel)
  if (max - min < 0.005) return formatUsd(max)
  return min < 0.005 ? `up to ${formatUsd(max)}` : `${formatUsd(min)}–${formatUsd(max)}`
}

/**
 * What the chain holds for an open channel: "$1.00", or "$0.75 unsettled"
 * when the buyer signed all of it away and the seller has not settled it
 * yet. "—" before the chain is read.
 */
export function formatHeld(channel: Pick<Channel, 'held' | 'unsettled'>): string {
  if (channel.held === null || channel.held === undefined) return '—'
  const held = usdcToNumber(channel.held)
  const unsettled = channel.unsettled === null || channel.unsettled === undefined ? null : usdcToNumber(channel.unsettled)
  return held > 0 && unsettled !== null && unsettled >= held ? `${formatUsd(held)} unsettled` : formatUsd(held)
}

/** Channels whose grace period ended, and the most withdrawing them returns. */
export function withdrawableSummary(channels: Channel[]): { count: number; amount: number } {
  const ready = channels.filter((channel) => channel.status === 'withdrawable')
  return { count: ready.length, amount: ready.reduce((sum, channel) => sum + returnsOnClose(channel).max, 0) }
}

/**
 * Spend the buyer authorized but the seller has not settled on chain yet,
 * summed over the listed channels: for a gateway that does not send the
 * buyer's own figure (`Wallet.pending`, see `authorizedNotCharged`). Each
 * channel counts what the seller can still settle (`unsettled`); one the
 * chain was not read for counts as nothing settled (conservative).
 */
export function pendingSpend(channels: Channel[]): number {
  return channels.filter(isOpenChannel).reduce((sum, channel) => {
    if (channel.unsettled !== null && channel.unsettled !== undefined) return sum + usdcToNumber(channel.unsettled)
    return sum + Math.max(0, usdcToNumber(channel.spent) - usdcToNumber(channel.settled ?? '0'))
  }, 0)
}

/**
 * Signed but not yet charged: the buyer's own figure from its stored chain
 * records, the same one the desktop's balance uses; from an older gateway
 * that does not send it, the sum over the listed channels. Null while unknown.
 */
export function authorizedNotCharged(wallet: Pick<Wallet, 'pending'>, channels: Channel[] | undefined): number | null {
  if (wallet.pending !== undefined) return usdcToNumber(wallet.pending)
  return channels ? pendingSpend(channels) : null
}

/**
 * One calm line for reserve the chain holds that no listed channel explains,
 * with the next step; null when there is none (or the buyer could not judge).
 * Only the workspace's authorized wallet can close a channel. The CLI on the
 * gateway host signs with the wallet the gateway holds, so it is the next
 * step only when that wallet is its own authorized wallet (`gatewaySigns`).
 */
export function unaccountedReserveNote(reserve: Pick<Wallet, 'unaccounted'> | null | undefined, { gatewaySigns = false }: { gatewaySigns?: boolean } = {}): string | null {
  const amount = usdcToNumber(reserve?.unaccounted ?? null)
  if (!reserve || amount < 0.005) return null
  const held = `${formatUsd(amount)} of the reserve is held by a channel this workspace's buyer has no record of. With its channel id (a block explorer lists it),`
  return gatewaySigns
    ? `${held} run on the gateway host: antseed buyer channels request-close <channelId>, then withdraw 15 minutes later.`
    : `${held} the authorized wallet closes it on chain: requestClose on the payment channels contract, then withdraw 15 minutes later.`
}

/** Nothing available and nothing waiting in the wallet, yet funds sit in channels: closing them frees it. */
export function isEntireBalanceLocked(wallet: { available: Usdc; reserved: Usdc; walletUsdc: Usdc }): boolean {
  return usdcToNumber(wallet.reserved) > 0 && usdcToNumber(wallet.available) <= 0 && usdcToNumber(wallet.walletUsdc) <= 0
}

/**
 * What the USDC waiting in the workspace wallet is doing. Near the credit
 * limit it stays there and tops the credits up as they are spent.
 */
/**
 * USDC that arrived in the workspace wallet and is on its way into the credits (a card payment or a
 * transfer the buyer has not deposited yet). Not USDC held back because the credits are at their limit.
 */
export function isDepositPending(wallet: { available: Usdc; reserved: Usdc; walletUsdc: Usdc; creditLimit: Usdc | null }): boolean {
  const inWallet = usdcToNumber(wallet.walletUsdc)
  if (inWallet <= 0) return false
  const limit = wallet.creditLimit === null ? 0 : usdcToNumber(wallet.creditLimit)
  const headroom = Math.max(0, limit - usdcToNumber(wallet.available) - usdcToNumber(wallet.reserved))
  return !(limit > 0 && inWallet > headroom)
}

export function walletUsdcMessage(wallet: { available: Usdc; reserved: Usdc; walletUsdc: Usdc; creditLimit: Usdc | null }): string {
  const inWallet = usdcToNumber(wallet.walletUsdc)
  const limit = wallet.creditLimit === null ? 0 : usdcToNumber(wallet.creditLimit)
  const headroom = Math.max(0, limit - usdcToNumber(wallet.available) - usdcToNumber(wallet.reserved))
  if (limit > 0 && inWallet > headroom) return 'Credits are at or near the credit limit, so this USDC waits in the workspace wallet and tops the credits up as they are spent.'
  return 'This USDC is in the workspace wallet and moves into the credits automatically.'
}

/**
 * Copy for a failed cooperative close. Every failure leaves the channel
 * unchanged, and the on-chain close is always the way forward.
 */
export function cooperativeCloseError(message: string): string {
  const text = message.toLowerCase()
  if (text.includes('already in flight')) return 'A close request to this seller is still waiting for an answer (it gives up after a minute). Close on chain instead, or try again shortly.'
  if (text.includes('busy') || text.includes('still processing')) return 'The seller is still processing a request. Try again shortly, or close on chain.'
  if (text.includes('pending_auth') || text.includes('latest payment authorization')) return 'The seller is waiting for the latest payment authorization. Try again shortly, or close on chain.'
  if (text.includes('no_channel') || text.includes('no longer has this channel')) return 'The seller no longer has this channel open. It may already be settled; refresh the list, or close on chain.'
  if (text.includes('did not answer') || text.includes('not connected') || text.includes('could not be found') || text.includes('disconnected')) return 'The seller did not answer. Close on chain instead: it does not need the seller.'
  if (text.includes('not the live channel')) return 'The seller can only close the channel it is serving now, and this is an older one. Close it on chain instead: it does not need the seller.'
  if (text.includes('does not support cooperative close')) return 'This seller does not support a cooperative close. Close on chain instead.'
  return `${message} The channel is unchanged; close on chain instead.`
}

export type { Usdc }
