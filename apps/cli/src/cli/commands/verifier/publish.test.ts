import assert from 'node:assert/strict'
import test from 'node:test'
import type { RoundTargetV1 } from '../../../verifier/round/types.js'
import { bindRoundTargets } from './publish.js'

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
