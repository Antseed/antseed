import { join } from 'node:path'
import { getAddress } from 'ethers'
import type { AuditorSetEvent } from '@antseed/node/payments'
import { readJsonIfExists, writeJsonAtomic } from './atomic-files.js'

/** Reads `AuditorSet` events; `VerifierClient` implements it. */
export interface AuditorSetEventSource {
  readonly contractAddress: string
  latestBlockNumber(): Promise<number>
  queryAuditorSetEvents(fromBlock?: number, toBlock?: number | 'latest'): Promise<AuditorSetEvent[]>
}

interface AuditorSetCacheV1 {
  version: 1
  contract: string
  /** Last block whose events are cached; later blocks are re-read on every call. */
  scannedThrough: number
  events: AuditorSetEvent[]
}

/** Blocks re-read on every call instead of cached, so a reorg near the head cannot stick. */
export const AUDITOR_SET_CONFIRMATION_BLOCKS = 64

export function auditorSetCachePath(dataDir: string): string {
  return join(dataDir, 'verifier', 'auditor-set.json')
}

/**
 * The auditors approved when the epoch started: every `AuditorSet` event in a block before
 * `epochStartedAt`, replayed in order. Using the epoch start (not "now") means every auditor sees
 * the same set for the whole epoch; an auditor approved or removed mid-epoch joins or leaves the
 * rotation the next epoch. Sorted by address.
 */
export function approvedAuditorsAt(events: readonly AuditorSetEvent[], epochStartedAt: number): string[] {
  const approved = new Map<string, string>()
  const ordered = [...events].sort((left, right) => left.blockNumber - right.blockNumber || left.logIndex - right.logIndex)
  for (const event of ordered) {
    if (event.timestamp >= epochStartedAt) break
    const address = getAddress(event.auditor)
    if (event.approved) approved.set(address.toLowerCase(), address)
    else approved.delete(address.toLowerCase())
  }
  return [...approved.entries()].sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0)).map(([, address]) => address)
}

/**
 * Every `AuditorSet` event of the verification contract, reading only blocks the cache in
 * `<dataDir>/verifier/auditor-set.json` has not covered yet. The first call scans from the
 * contract's deployment block.
 */
export async function loadAuditorSetEvents(
  source: AuditorSetEventSource,
  dataDir: string,
  log: (message: string) => void = () => undefined,
): Promise<AuditorSetEvent[]> {
  const path = auditorSetCachePath(dataDir)
  const contract = getAddress(source.contractAddress)
  const cached = await readJsonIfExists<AuditorSetCacheV1>(path).catch(() => null)
  const usable = cached?.version === 1 && cached.contract === contract ? cached : null
  const latest = await source.latestBlockNumber()
  const fromBlock = usable ? usable.scannedThrough + 1 : undefined
  if (!usable) log('Reading the approved auditors from the verification contract (first run scans from its deployment block; cached afterwards)…')
  const fresh = fromBlock !== undefined && fromBlock > latest ? [] : await source.queryAuditorSetEvents(fromBlock, latest)
  const events = [...(usable?.events ?? []), ...fresh]
  const scannedThrough = latest - AUDITOR_SET_CONFIRMATION_BLOCKS
  if (scannedThrough > (usable?.scannedThrough ?? -1)) {
    await writeJsonAtomic(path, {
      version: 1,
      contract,
      scannedThrough,
      events: events.filter((event) => event.blockNumber <= scannedThrough),
    } satisfies AuditorSetCacheV1)
  }
  return events
}
