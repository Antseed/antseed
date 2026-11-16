import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import Database from 'better-sqlite3'
import { SpendAttributionFeed } from './spend-attribution.js'

const spend = (requestId: string) => ({
  requestId, sellerPeerId: 'a'.repeat(40), amountUsdc: '1000',
  inputTokens: '0', cachedInputTokens: '0', outputTokens: '0', outputImages: '0',
})

test('spend of a request tracked as routing is reported as a routing purchase', () => {
  const feed = new SpendAttributionFeed()
  try {
    feed.track('rank-1', 'gw_tag', 'routing')
    feed.track('infer-1', 'gw_tag')
    feed.record(spend('rank-1'))
    feed.record(spend('infer-1'))
    const events = feed.page(0).events
    assert.deepEqual(events.map((event) => [event.requestId, event.purpose]), [['rank-1', 'routing'], ['infer-1', undefined]])
  } finally {
    feed.close()
  }
})

test('a feed database from before routing purposes gains the column and keeps its events', () => {
  const dir = mkdtempSync(join(tmpdir(), 'antseed-spend-feed-'))
  const path = join(dir, 'attributed-spend.db')
  try {
    const old = new Database(path)
    old.exec(`
      CREATE TABLE request_tags (request_id TEXT PRIMARY KEY, tag TEXT NOT NULL, tracked_at INTEGER NOT NULL);
      CREATE TABLE feed_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE spend_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, tag TEXT NOT NULL, request_id TEXT, buyer_identity TEXT NOT NULL,
        seller_peer_id TEXT NOT NULL, amount_usdc TEXT NOT NULL, input_tokens TEXT NOT NULL, cached_input_tokens TEXT NOT NULL,
        output_tokens TEXT NOT NULL, output_images TEXT NOT NULL, at INTEGER NOT NULL
      );
    `)
    old.prepare("INSERT INTO spend_events (tag, request_id, buyer_identity, seller_peer_id, amount_usdc, input_tokens, cached_input_tokens, output_tokens, output_images, at) VALUES ('gw_old', 'r0', 'default', ?, '5', '0', '0', '0', '0', ?)")
      .run('a'.repeat(40), Date.now())
    old.close()

    const feed = new SpendAttributionFeed(undefined, { path })
    try {
      feed.track('rank-1', 'gw_new', 'routing')
      feed.record(spend('rank-1'))
      assert.deepEqual(feed.page(0).events.map((event) => [event.tag, event.purpose]), [['gw_old', undefined], ['gw_new', 'routing']])
    } finally {
      feed.close()
    }

    // A buyer rolled back to the older version still writes and reads the same file as it did.
    const older = new Database(path)
    older.prepare('INSERT OR REPLACE INTO request_tags VALUES (?, ?, ?)').run('r1', 'gw_after_rollback', Date.now())
    older.prepare('INSERT INTO spend_events (tag, request_id, buyer_identity, seller_peer_id, amount_usdc, input_tokens, cached_input_tokens, output_tokens, output_images, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run('gw_after_rollback', 'r1', 'default', 'a'.repeat(40), '5', '0', '0', '0', '0', Date.now())
    older.close()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
