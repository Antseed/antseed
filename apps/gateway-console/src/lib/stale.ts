/** The note under chain-backed figures served from the gateway's last good read of the chain RPC. */
export const STALE_CHAIN_HINT = 'Showing last known values — the chain RPC is busy.'

/** The note while the buyer has not yet read its channels from the chain (after an upgrade, or just after it started). */
export const STALE_CHANNELS_HINT = 'Showing last known values — channel figures are still being read from the chain.'

/**
 * Which note a read gets: the RPC's while it is busy (`stale`), which also
 * leaves channel figures unconfirmed and comes with the advice to use one's
 * own endpoint; else the channel figures' while no chain read confirms them
 * yet (`channelsStale` alone: an upgrade, a buyer just started); null when
 * the figures are current.
 */
export function staleHint(read: { stale?: boolean; channelsStale?: boolean }): string | null {
  if (read.stale) return STALE_CHAIN_HINT
  return read.channelsStale ? STALE_CHANNELS_HINT : null
}
