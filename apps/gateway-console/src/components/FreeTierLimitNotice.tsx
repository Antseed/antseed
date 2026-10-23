import type { ChatFreeTierError } from '../api/types'
import { nextTier, stakeInPoolPath, tierAllowance, tierAnts } from '../lib/free-tier'
import { shortId } from '../lib/format'
import { usePeers } from '../lib/queries'
import { href, linkHandler } from '../lib/router'

/** The free-tier limit in a chat error's text (the gateway sends it as JSON), or null. */
export function parseChatFreeTierError(message: string): ChatFreeTierError | null {
  if (!message.startsWith('{')) return null
  try {
    const parsed = JSON.parse(message) as Partial<ChatFreeTierError>
    return parsed.code === 'free_tier_exhausted' && typeof parsed.message === 'string' && parsed.freeTier ? parsed as ChatFreeTierError : null
  } catch {
    return null
  }
}

/**
 * A seller's free limit ran out: which seller, when it resets, and, when it
 * has staked tiers, the next tier and a link to stake in that seller's pool.
 */
export function FreeTierLimitNotice({ error, onAuto }: { error: ChatFreeTierError; onAuto: (() => void) | null }) {
  const peers = usePeers()
  const { freeTier } = error
  const peer = freeTier.peerId ? peers.data?.find((entry) => entry.peerId.toLowerCase() === freeTier.peerId!.toLowerCase()) : undefined
  const seller = peer?.displayName ?? (freeTier.peerId ? shortId(freeTier.peerId, 6, 4) : 'this seller')
  const next = nextTier(freeTier.stakeTiers, freeTier.stakePower)
  const pool = peer?.agentId ?? null
  const reached = freeTier.limitedBy === 'stake' ? `Your staked free allowance on ${seller} is used up.` : `Free limit reached on ${seller}.`
  return (
    <div className="flex items-start gap-2 rounded-lg border p-3 text-sm" role="status">
      <span aria-hidden className="mt-1.5 size-2 shrink-0 rounded-full bg-amber-500" />
      <span>
        <span className="font-medium">{reached}</span>{' '}
        {freeTier.retryAfterSeconds !== null && <>It resets in {formatWait(freeTier.retryAfterSeconds)}. </>}
        {next && <>Lock {tierAnts(next)} for a year in {seller}'s pool for {tierAllowance(next).toLowerCase()}; stake in other pools doesn't count here.{' '}</>}
        {next && pool !== null && <a className="font-medium underline underline-offset-2" href={href(stakeInPoolPath(pool))} onClick={linkHandler(stakeInPoolPath(pool))}>Stake in {seller}'s pool</a>}
        {onAuto && <>{next && pool !== null ? ' or ' : ''}<button type="button" className="font-medium underline underline-offset-2" onClick={onAuto}>switch to Auto</button> to use another free seller.</>}
      </span>
    </div>
  )
}

function formatWait(seconds: number): string {
  if (seconds < 90) return `${Math.max(1, Math.round(seconds))}s`
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min`
  return `${Math.round(seconds / 3600)} h`
}
