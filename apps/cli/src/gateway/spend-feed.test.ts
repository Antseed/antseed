import assert from 'node:assert/strict'
import test from 'node:test'
import { SPEND_FEED_UNAUTHORIZED_HINT, SpendFeedPoller } from './spend-feed.js'

function pollerAnswering(status: number, body: unknown, logs: string[]): SpendFeedPoller {
  return new SpendFeedPoller({
    buyerPort: 1,
    controlSecret: 'secret',
    onPage: () => {},
    onLog: (message) => logs.push(message),
    fetchImpl: async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }),
  })
}

test('a buyer that rejects the control secret makes the feed unauthorized, with the fix in the log', async () => {
  const logs: string[] = []
  const feed = pollerAnswering(401, { ok: false, error: 'gateway_auth_required' }, logs)
  await feed.pollOnce()
  assert.equal(feed.state, 'unauthorized')
  assert.equal(logs.length, 1)
  assert.ok(logs[0]!.includes(SPEND_FEED_UNAUTHORIZED_HINT), logs[0])
  // The same state again is not logged again.
  await feed.pollOnce()
  assert.equal(logs.length, 1)
})

test('other states keep their meaning: 404 is unsupported, 5xx is unreachable, a page is reporting', async () => {
  assert.equal(await stateAfter(404, { ok: false }), 'unsupported')
  assert.equal(await stateAfter(503, { ok: false }), 'unreachable')
  assert.equal(await stateAfter(200, { ok: true, bootId: 'b', oldestSeq: 1, cursor: 0, events: [] }), 'reporting')
})

async function stateAfter(status: number, body: unknown): Promise<string> {
  const feed = pollerAnswering(status, body, [])
  await feed.pollOnce()
  return feed.state
}
