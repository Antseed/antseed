import { join } from 'node:path'
import { getAddress } from 'ethers'
import {
  serviceHash as hashService,
  type ModelAuditedEvent,
  type ServiceAuditedEvent,
  type VerifierVerdict,
} from '@antseed/node/payments'
import { readJsonIfExists, writeJsonAtomic } from './atomic-files.js'

/**
 * The KBF audits contract's `ServiceAudited` and `ModelAudited` events, kept in
 * `<dataDir>/verifier/chain-cache/` with the block range they cover, so a scan only reads blocks
 * no earlier scan of the data dir has read.
 *
 * Base mines a block every 200 ms (since 2026-11-05), so a scan of one 7-day epoch is about 3,000
 * `eth_getLogs` requests of 1,000 blocks and the contract's whole history grows by 432 a day.
 * `verifier run` and `verifier submit` read these events several times per process (planner,
 * stand-ins, confirmations, third opinions, the delta filter, duplicate checks), and every
 * `verifier watch` tick is new processes: without a cache one tick made about 19,000 requests.
 *
 * Every read first catches up to the chain head and re-reads the last `REORG_BLOCKS` blocks, so a
 * short reorg, or a load-balanced RPC whose nodes lag each other, is corrected on the next read. One
 * cache is shared by every client of the process for the same file.
 */
export const REORG_BLOCKS = 600

export interface RawEventSource {
  readonly contractAddress: string
  readonly deploymentBlock: number | undefined
  queryServiceAudits(agentId: bigint | number | null, service: string | null, fromBlock?: number, toBlock?: number | 'latest'): Promise<ServiceAuditedEvent[]>
  queryModelAudits(filter: { model?: string | null; auditor?: string | null }, fromBlock?: number, toBlock?: number | 'latest'): Promise<ModelAuditedEvent[]>
  firstBlockAtOrAfter(timestamp: number, floor?: number): Promise<number>
  latestBlockNumber(): Promise<number>
  readonly provider: { getBlock(block: number): Promise<{ timestamp: number } | null> }
}

interface Range<T> {
  from: number
  through: number
  events: T[]
}

type Stored<T> = { [K in keyof T]: T[K] extends bigint ? string : T[K] }

interface EventCacheFileV1 {
  version: 1
  contract: string
  service: Range<Stored<ServiceAuditedEvent>> | null
  model: Range<Stored<ModelAuditedEvent>> | null
  /** Epoch start timestamp (seconds) to its first block. */
  firstBlocks: Record<string, number>
}

export function eventCachePath(dataDir: string, contract: string): string {
  return join(dataDir, 'verifier', 'chain-cache', `kbf-events-${getAddress(contract).toLowerCase()}.json`)
}

const caches = new Map<string, VerifierEventCache>()

/** The process's cache for `path` (null: memory only), created on first use. */
export function sharedEventCache(raw: RawEventSource, path: string | null, log?: (message: string) => void): VerifierEventCache {
  const key = path ?? `memory:${getAddress(raw.contractAddress)}`
  let cache = caches.get(key)
  if (!cache) {
    cache = new VerifierEventCache(raw, path, log)
    caches.set(key, cache)
  }
  return cache
}

/** For tests: forget the process's caches. */
export function resetSharedEventCaches(): void {
  caches.clear()
}

export class VerifierEventCache {
  private service: Range<ServiceAuditedEvent> | null = null
  private model: Range<ModelAuditedEvent> | null = null
  private firstBlocks: Record<string, number> = {}
  private loaded: Promise<void> | null = null
  private queue: Promise<unknown> = Promise.resolve()
  /** eth_getLogs ranges read, for the load measurement in tests and logs. */
  readonly stats = { serviceRanges: 0, modelRanges: 0 }

  constructor(
    private readonly raw: RawEventSource,
    private readonly path: string | null,
    private readonly log: (message: string) => void = () => undefined,
  ) {}

  /** `queryServiceAudits` from the cache, after catching up with the chain. */
  async serviceAudits(
    agentId: bigint | number | null, service: string | null, fromBlock?: number, toBlock: number | 'latest' = 'latest',
  ): Promise<ServiceAuditedEvent[]> {
    const { events, from, to } = await this.serialized(() => this.ensure('service', fromBlock, toBlock))
    const agent = agentId === null ? null : BigInt(agentId)
    const serviceKey = service === null ? null : hashService(service).toLowerCase()
    return (events as ServiceAuditedEvent[]).filter((event) => (
      event.blockNumber >= from && event.blockNumber <= to
      && (agent === null || event.agentId === agent)
      && (serviceKey === null || event.serviceHash.toLowerCase() === serviceKey)
    ))
  }

  /** `queryModelAudits` from the cache, after catching up with the chain. */
  async modelAudits(
    filter: { model?: string | null; auditor?: string | null } = {}, fromBlock?: number, toBlock: number | 'latest' = 'latest',
  ): Promise<ModelAuditedEvent[]> {
    const { events, from, to } = await this.serialized(() => this.ensure('model', fromBlock, toBlock))
    const model = filter.model ? filter.model.toLowerCase() : null
    const auditor = filter.auditor ? getAddress(filter.auditor) : null
    return (events as ModelAuditedEvent[]).filter((event) => (
      event.blockNumber >= from && event.blockNumber <= to
      && (model === null || event.modelHash.toLowerCase() === model)
      && (auditor === null || event.auditor === auditor)
    ))
  }

  /** `firstBlockAtOrAfter`, remembered once the block is mined (an epoch's first block never changes). */
  async firstBlockAtOrAfter(timestamp: number, floor = 0): Promise<number> {
    await this.load()
    const known = this.firstBlocks[String(timestamp)]
    if (known !== undefined && known >= floor) return known
    const block = await this.raw.firstBlockAtOrAfter(timestamp, floor)
    // The search returns the head when no block is that late yet: only a block at or after the time is final.
    const found = await this.raw.provider.getBlock(block).catch(() => null)
    if (found && found.timestamp >= timestamp) {
      this.firstBlocks[String(timestamp)] = block
      await this.serialized(() => this.persist())
    }
    return block
  }

  private serialized<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task)
    this.queue = run.catch(() => undefined)
    return run
  }

  private load(): Promise<void> {
    this.loaded ??= (async () => {
      if (!this.path) return
      const file = await readJsonIfExists<EventCacheFileV1>(this.path).catch(() => null)
      if (!file || file.version !== 1 || file.contract !== getAddress(this.raw.contractAddress)) return
      this.service = file.service ? { ...file.service, events: file.service.events.map(reviveService) } : null
      this.model = file.model ? { ...file.model, events: file.model.events.map(reviveModel) } : null
      this.firstBlocks = { ...file.firstBlocks }
    })()
    return this.loaded
  }

  private async ensure(
    kind: 'service' | 'model', fromBlock: number | undefined, toBlock: number | 'latest',
  ): Promise<{ events: Array<ServiceAuditedEvent | ModelAuditedEvent>; from: number; to: number }> {
    await this.load()
    const from = fromBlock ?? this.raw.deploymentBlock
    if (from === undefined) throw new Error('verification contract deployment block is unknown; pass an explicit fromBlock to query events')
    const to = toBlock === 'latest' ? await this.raw.latestBlockNumber() : toBlock
    let range = (kind === 'service' ? this.service : this.model) as Range<ServiceAuditedEvent | ModelAuditedEvent> | null
    let changed = false
    if (!range || range.through < range.from) {
      if (to - from > 100_000) this.log(`Reading the KBF audits contract's ${kind === 'service' ? 'seller results' : 'model audits'} from block ${from} (first read of this data dir; cached afterwards)…`)
      range = { from, through: to, events: await this.read(kind, from, to) }
      changed = true
    } else {
      if (from < range.from) {
        const older = await this.read(kind, from, range.from - 1)
        range = { from, through: range.through, events: [...older, ...range.events] }
        changed = true
      }
      if (to > range.through) {
        const refetchFrom = Math.max(range.from, range.through - REORG_BLOCKS + 1)
        const newer = await this.read(kind, refetchFrom, to)
        range = { from: range.from, through: to, events: [...range.events.filter((event) => event.blockNumber < refetchFrom), ...newer] }
        changed = true
      }
    }
    if (kind === 'service') this.service = range as Range<ServiceAuditedEvent>
    else this.model = range as Range<ModelAuditedEvent>
    if (changed) await this.persist()
    return { events: range.events, from, to }
  }

  private async read(kind: 'service' | 'model', from: number, to: number): Promise<Array<ServiceAuditedEvent | ModelAuditedEvent>> {
    if (from > to) return []
    if (kind === 'service') {
      this.stats.serviceRanges += 1
      return this.raw.queryServiceAudits(null, null, from, to)
    }
    this.stats.modelRanges += 1
    const events = await this.raw.queryModelAudits({}, from, to)
    return [...events].sort((left, right) => left.blockNumber - right.blockNumber || left.logIndex - right.logIndex)
  }

  private async persist(): Promise<void> {
    if (!this.path) return
    try {
      await writeJsonAtomic(this.path, {
        version: 1,
        contract: getAddress(this.raw.contractAddress),
        service: this.service ? { ...this.service, events: this.service.events.map(storeService) } : null,
        model: this.model ? { ...this.model, events: this.model.events.map(storeModel) } : null,
        firstBlocks: this.firstBlocks,
      } satisfies EventCacheFileV1)
    } catch (error) {
      // The cache only saves requests: a full disk must not fail an audit or a submit.
      this.log(`Could not write the chain event cache ${this.path}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

function storeService(event: ServiceAuditedEvent): Stored<ServiceAuditedEvent> {
  return { ...event, agentId: event.agentId.toString() }
}

function reviveService(event: Stored<ServiceAuditedEvent>): ServiceAuditedEvent {
  return { ...event, agentId: BigInt(event.agentId), verdict: event.verdict as VerifierVerdict }
}

function storeModel(event: ModelAuditedEvent): Stored<ModelAuditedEvent> {
  return { ...event, epoch: event.epoch.toString() }
}

function reviveModel(event: Stored<ModelAuditedEvent>): ModelAuditedEvent {
  return { ...event, epoch: BigInt(event.epoch) }
}

/**
 * Serves `client`'s event queries from the process's shared cache (on disk under `dataDir` when
 * given). The client is changed in place and returned.
 */
export function withEventCache<T extends RawEventSource>(client: T, dataDir: string | null, log?: (message: string) => void): T {
  const raw: RawEventSource = {
    contractAddress: client.contractAddress,
    deploymentBlock: client.deploymentBlock,
    provider: client.provider,
    queryServiceAudits: client.queryServiceAudits.bind(client),
    queryModelAudits: client.queryModelAudits.bind(client),
    firstBlockAtOrAfter: client.firstBlockAtOrAfter.bind(client),
    latestBlockNumber: client.latestBlockNumber.bind(client),
  }
  const cache = sharedEventCache(raw, dataDir ? eventCachePath(dataDir, client.contractAddress) : null, log)
  Object.assign(client, {
    queryServiceAudits: cache.serviceAudits.bind(cache),
    queryModelAudits: cache.modelAudits.bind(cache),
    firstBlockAtOrAfter: cache.firstBlockAtOrAfter.bind(cache),
    eventCache: cache,
  })
  return client
}
