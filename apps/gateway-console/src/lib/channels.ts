/**
 * Payment-channel close flow, as the desktop's Activity view runs it:
 *   1. ask the seller to close cooperatively (instant, no transaction);
 *   2. if that fails or the seller cannot, the authorized wallet requests an
 *      on-chain close (AntseedChannels.requestClose);
 *   3. after the 15-minute grace period it withdraws the unused reserve
 *      (AntseedChannels.withdraw), which returns to the workspace balance.
 * Both transactions must come from the workspace's authorized wallet.
 */
import type { Channel, Usdc } from '../api/types'
import { usdcToNumber } from './format'

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

/** Unspent reserve that comes back on close: reserved minus spent, never negative. */
export function unspent(channel: Pick<Channel, 'reserved' | 'spent'>): number {
  return Math.max(0, usdcToNumber(channel.reserved) - usdcToNumber(channel.spent))
}

/** Channels whose grace period ended, and what withdrawing them returns. */
export function withdrawableSummary(channels: Channel[]): { count: number; amount: number } {
  const ready = channels.filter((channel) => channel.status === 'withdrawable')
  return { count: ready.length, amount: ready.reduce((sum, channel) => sum + unspent(channel), 0) }
}

/**
 * Spend the buyer authorized but the seller has not settled on chain yet: it
 * is charged from the channel's reserve at the next settlement. A channel the
 * chain was not read for counts as nothing settled, which overstates pending
 * (conservative), as the desktop does.
 */
export function pendingSpend(channels: Channel[]): number {
  return channels.filter(isOpenChannel).reduce((sum, channel) => sum + Math.max(0, usdcToNumber(channel.spent) - usdcToNumber(channel.settled ?? '0')), 0)
}

/** Nothing available and nothing waiting in the wallet, yet funds sit in channels: closing them frees it. */
export function isEntireBalanceLocked(wallet: { available: Usdc; reserved: Usdc; walletUsdc: Usdc }): boolean {
  return usdcToNumber(wallet.reserved) > 0 && usdcToNumber(wallet.available) <= 0 && usdcToNumber(wallet.walletUsdc) <= 0
}

/**
 * What the USDC waiting in the workspace wallet is doing. Near the credit
 * limit it stays there and tops the credits up as they are spent.
 */
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
  if (text.includes('does not support cooperative close')) return 'This seller does not support a cooperative close. Close on chain instead.'
  return `${message} The channel is unchanged; close on chain instead.`
}

export type { Usdc }
