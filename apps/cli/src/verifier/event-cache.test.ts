import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { serviceHash, type ModelAuditedEvent, type ServiceAuditedEvent } from '@antseed/node/payments'
import { REORG_BLOCKS, VerifierEventCache, eventCachePath, type RawEventSource } from './event-cache.js'

const CONTRACT = '0x' + '86'.repeat(20)
const A = '0x' + '1'.repeat(40)
const B = '0x' + '2'.repeat(40)

function service(blockNumber: number, agentId: number, auditor = A, name = 'model-a'): ServiceAuditedEvent {
  return {
    agentId: BigInt(agentId), serviceHash: serviceHash(name), auditor, modelHash: '0x' + 'aa'.repeat(32),
    verdict: 1, round: 0, reports: 1, required: 1, blockNumber, logIndex: 0, transactionHash: `0x${blockNumber.toString(16)}`,
  } as ServiceAuditedEvent
}

function model(blockNumber: number, auditor = A, hash = '0x' + 'aa'.repeat(32)): ModelAuditedEvent {
  return {
    modelHash: hash, auditor, epoch: 7n, evidenceHash: '0x' + 'ee'.repeat(32), evidenceUri: '',
    resultCount: 1, blockNumber, logIndex: 0, transactionHash: `0x${blockNumber.toString(16)}`,
  }
}

/** A chain whose events and head the test moves; records every ranged read. */
function chain(deploymentBlock = 1_000) {
  const state = {
    head: 50_000,
    services: [] as ServiceAuditedEvent[],
    models: [] as ModelAuditedEvent[],
    reads: [] as Array<[string, number, number]>,
    timestamps: (block: number) => block * 10,
  }
  const raw: RawEventSource = {
    contractAddress: CONTRACT,
    deploymentBlock,
    async queryServiceAudits(_agent, _service, from = deploymentBlock, to = 'latest') {
      const end = to === 'latest' ? state.head : to
      state.reads.push(['service', from, end])
      return state.services.filter((event) => event.blockNumber >= from && event.blockNumber <= end)
    },
    async queryModelAudits(_filter, from = deploymentBlock, to = 'latest') {
      const end = to === 'latest' ? state.head : to
      state.reads.push(['model', from, end])
      return state.models.filter((event) => event.blockNumber >= from && event.blockNumber <= end)
    },
    async firstBlockAtOrAfter(timestamp) {
      state.reads.push(['first', timestamp, 0])
      return Math.min(Math.ceil(timestamp / 10), state.head)
    },
    async latestBlockNumber() { return state.head },
    provider: { getBlock: async (block: number) => (block <= state.head ? { timestamp: state.timestamps(block) } : null) },
  }
  return { state, raw }
}

async function withDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-event-cache-'))
  try {
    await body(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

test('a second read only scans the blocks after the first one, plus the reorg margin', async () => {
  const { state, raw } = chain()
  state.services = [service(20_000, 1), service(40_000, 2)]
  const cache = new VerifierEventCache(raw, null)

  assert.deepEqual((await cache.serviceAudits(null, null, 10_000)).map((event) => event.blockNumber), [20_000, 40_000])
  assert.deepEqual(state.reads, [['service', 10_000, 50_000]])

  state.head = 60_000
  state.services.push(service(55_000, 3))
  state.reads.length = 0
  assert.deepEqual((await cache.serviceAudits(null, null, 10_000)).map((event) => event.blockNumber), [20_000, 40_000, 55_000])
  assert.deepEqual(state.reads, [['service', 50_000 - REORG_BLOCKS + 1, 60_000]])

  state.reads.length = 0
  await cache.serviceAudits(null, null, 30_000)
  assert.deepEqual(state.reads, [], 'nothing new on-chain and the range is covered: no eth_getLogs at all')
})

test('an event replaced by a short reorg is corrected on the next read', async () => {
  const { state, raw } = chain()
  state.services = [service(49_900, 1, A)]
  const cache = new VerifierEventCache(raw, null)
  assert.equal((await cache.serviceAudits(null, null, 10_000))[0]!.auditor, A)

  state.services = [service(49_950, 1, B)]
  state.head = 50_100
  const events = await cache.serviceAudits(null, null, 10_000)
  assert.deepEqual(events.map((event) => [event.blockNumber, event.auditor]), [[49_950, B]])
})

test('a read from an earlier block fills in only the missing part', async () => {
  const { state, raw } = chain()
  state.models = [model(5_000), model(30_000)]
  const cache = new VerifierEventCache(raw, null)
  assert.equal((await cache.modelAudits({}, 20_000)).length, 1)
  state.reads.length = 0
  assert.equal((await cache.modelAudits({})).length, 2)
  assert.deepEqual(state.reads, [['model', 1_000, 19_999]])
})

test('filters match what the contract filters would return', async () => {
  const { state, raw } = chain()
  state.services = [service(20_000, 1, A, 'model-a'), service(21_000, 2, B, 'model-b'), service(22_000, 1, B, 'model-b')]
  state.models = [model(20_000, A, '0x' + 'aa'.repeat(32)), model(21_000, B, '0x' + 'bb'.repeat(32))]
  const cache = new VerifierEventCache(raw, null)
  assert.deepEqual((await cache.serviceAudits(1n, null, 10_000)).map((event) => event.blockNumber), [20_000, 22_000])
  assert.deepEqual((await cache.serviceAudits(null, 'MODEL-B ', 10_000)).map((event) => event.blockNumber), [21_000, 22_000])
  assert.deepEqual((await cache.serviceAudits(null, null, 10_000, 21_000)).map((event) => event.blockNumber), [20_000, 21_000])
  assert.deepEqual((await cache.modelAudits({ auditor: B.toUpperCase().replace('0X', '0x') })).map((event) => event.blockNumber), [21_000])
  assert.deepEqual((await cache.modelAudits({ model: '0x' + 'AA'.repeat(32) })).map((event) => event.blockNumber), [20_000])
})

test('the cache outlives the process: a new one reads the file and only scans new blocks', () => withDir(async (dir) => {
  const { state, raw } = chain()
  state.services = [service(20_000, 1)]
  state.models = [model(21_000)]
  const path = eventCachePath(dir, CONTRACT)
  await new VerifierEventCache(raw, path).serviceAudits(null, null, 10_000)
  await new VerifierEventCache(raw, path).modelAudits({})

  state.head = 50_500
  state.reads.length = 0
  const next = new VerifierEventCache(raw, path)
  const services = await next.serviceAudits(null, null, 10_000)
  const models = await next.modelAudits({})
  assert.equal(services[0]!.agentId, 1n, 'bigints survive the file')
  assert.equal(models[0]!.epoch, 7n)
  assert.deepEqual(state.reads, [['service', 50_000 - REORG_BLOCKS + 1, 50_500], ['model', 50_000 - REORG_BLOCKS + 1, 50_500]])
}))

test('an epoch\'s first block is searched once, but not remembered before it is mined', () => withDir(async (dir) => {
  const { state, raw } = chain()
  const path = eventCachePath(dir, CONTRACT)
  const cache = new VerifierEventCache(raw, path)
  assert.equal(await cache.firstBlockAtOrAfter(300_000), 30_000)
  assert.equal(await new VerifierEventCache(raw, path).firstBlockAtOrAfter(300_000), 30_000)
  assert.equal(state.reads.filter(([kind]) => kind === 'first').length, 1)

  // An epoch that has not started: the search answers the head, which is not its first block.
  assert.equal(await cache.firstBlockAtOrAfter(900_000), 50_000)
  state.head = 95_000
  assert.equal(await cache.firstBlockAtOrAfter(900_000), 90_000)
}))

test('a failed read leaves the cache as it was, and the next read tries again', async () => {
  const { state, raw } = chain()
  state.services = [service(20_000, 1)]
  const cache = new VerifierEventCache(raw, null)
  await cache.serviceAudits(null, null, 10_000)
  const query = raw.queryServiceAudits
  raw.queryServiceAudits = async () => { throw new Error('rpc down') }
  state.head = 70_000
  await assert.rejects(cache.serviceAudits(null, null, 10_000), /rpc down/)
  raw.queryServiceAudits = query
  state.services.push(service(65_000, 2))
  assert.equal((await cache.serviceAudits(null, null, 10_000)).length, 2)
})
