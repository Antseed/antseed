import assert from 'node:assert/strict'
import test from 'node:test'
import type { RoundTargetV1 } from './types.js'
import { CONNECTION_CAPABILITY_RESPONSE_AUTH_V1, type PeerId, type PeerInfo } from '@antseed/node'
import { affordableTargets, bindRoundTargets } from './target-discovery.js'

function target(agentId: string, peerId: string): RoundTargetV1 {
  return { agentId, peerId, service: 'model-a', serviceHash: '0x01', model: 'model-a', modelHash: '0x02' }
}

test('the publisher plans only targets whose peer and agent are bound at the latest block', async () => {
  const reads: Array<{ peerId: string; agentId: bigint; blockTag: bigint }> = []
  const logs: string[] = []
  const bound = await bindRoundTargets(
    [target('1', 'aa'.repeat(20)), target('2', 'bb'.repeat(20))],
    {
      reader: {
        async isBound(peerId, agentId, blockTag) {
          reads.push({ peerId, agentId, blockTag })
          return agentId === 1n
        },
      },
      latestBlock: async () => 1234n,
    },
    (message) => logs.push(message),
  )
  assert.deepEqual(bound.map((entry) => entry.agentId), ['1'])
  assert.ok(reads.every((read) => read.blockTag === 1234n))
  assert.ok(logs.some((line) => line.includes('not bound to agent 2')))
})

test('no targets means no chain reads', async () => {
  let reads = 0
  const bound = await bindRoundTargets([], {
    reader: { async isBound() { reads += 1; return true } },
    latestBlock: async () => { reads += 1; return 1n },
  }, () => {})
  assert.deepEqual(bound, [])
  assert.equal(reads, 0)
})

test('a collector pays only targets its own audit caps allow at current prices', async () => {
  const seller = (id: string, price: number): PeerInfo => ({
    peerId: id.repeat(20) as PeerId,
    displayName: 'seller',
    lastSeen: Date.now(),
    providers: ['test'],
    capabilities: [CONNECTION_CAPABILITY_RESPONSE_AUTH_V1],
    onChainAgentId: 1,
    providerPricing: { test: {
      defaults: { inputUsdPerMillion: price, outputUsdPerMillion: price },
      services: { 'model-a': { inputUsdPerMillion: price, outputUsdPerMillion: price } },
    } },
  })
  const caps = (input: number) => ({
    caps: new Map([['model-a', { model: 'model-a', reference: { inputUsdPerMillion: input, outputUsdPerMillion: input }, source: 'catalog' as const, ratio: 1 }]]),
    unpriced: new Map<string, string>(),
  })
  const targets = [target('1', 'aa'.repeat(20)), target('2', 'bb'.repeat(20)), target('3', 'cc'.repeat(20))]
  const logs: string[] = []
  // aa kept its price, bb raised it above this collector's cap after the plan, cc is not discovered.
  const affordable = affordableTargets({ targets, peers: [seller('aa', 1), seller('bb', 9)], caps: caps(2), minReputation: 0, log: (line) => logs.push(line) })
  assert.deepEqual(affordable.map((entry) => entry.agentId), ['1'])
  assert.ok(logs.some((line) => line.startsWith('not buying from 2:model-a') && line.includes('above')))
  assert.ok(logs.some((line) => line.startsWith('not buying from 3:model-a') && line.includes('not among the buyer')))
  // A collector with a looser policy than this one's would buy from bb too: the caps are its own.
  assert.deepEqual(affordableTargets({ targets, peers: [seller('aa', 1), seller('bb', 9)], caps: caps(10), minReputation: 0, log: () => {} }).map((entry) => entry.agentId), ['1', '2'])
  // A model this collector cannot price is not bought at all.
  assert.deepEqual(affordableTargets({ targets, peers: [seller('aa', 1)], caps: { caps: new Map(), unpriced: new Map([['model-a', 'no reference price']]) }, minReputation: 0, log: () => {} }), [])
})

test('a seller with several audited services is checked once per pass', async () => {
  let reads = 0
  const services = [target('1', 'aa'.repeat(20)), { ...target('1', 'aa'.repeat(20)), service: 'model-b' }, target('2', 'bb'.repeat(20))]
  const bound = await bindRoundTargets(services, {
    reader: { async isBound() { reads += 1; return true } },
    latestBlock: async () => 1n,
  }, () => {})
  assert.equal(bound.length, 3)
  assert.equal(reads, 2)
})
