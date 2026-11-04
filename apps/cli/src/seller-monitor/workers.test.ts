import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readSellerWorkers, WORKER_POOL_LEDGER_FILE } from './workers.js'

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

/** The worker-pool provider's ledger tables (plugins/provider-worker-pool/src/ledger.ts), with a few rows. */
function writeLedger(dataDir: string): void {
  const db = new Database(join(dataDir, WORKER_POOL_LEDGER_FILE))
  db.exec(`
    CREATE TABLE earnings (request_id TEXT PRIMARY KEY, worker TEXT NOT NULL, service TEXT, gross_usdc INTEGER NOT NULL, worker_usdc INTEGER NOT NULL,
      input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, stream_ms INTEGER, created_at INTEGER NOT NULL);
    CREATE TABLE connections (id INTEGER PRIMARY KEY AUTOINCREMENT, worker TEXT NOT NULL, agent TEXT, connected_at INTEGER NOT NULL, disconnected_at INTEGER);
  `)
  const connect = db.prepare('INSERT INTO connections (worker, agent, connected_at, disconnected_at) VALUES (?, ?, ?, ?)')
  connect.run('0xaa', 'antseed-mac/0.1.0 (Studio)', NOW - 2 * HOUR, null)
  connect.run('0xbb', 'antseed-pool-worker/0.1.0', NOW - 30 * HOUR, NOW - 26 * HOUR)
  const earn = db.prepare('INSERT INTO earnings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
  earn.run('r1', '0xaa', 'qwen', 1000, 500, 10, 200, 400, NOW - HOUR)
  earn.run('r2', '0xaa', 'qwen', 1000, 500, 10, 100, null, NOW - HOUR)
  earn.run('r3', '0xbb', 'qwen', 3000, 1500, 10, 300, 1000, NOW - 8 * 24 * HOUR)
  db.close()
}

describe('readSellerWorkers', () => {
  it('is unavailable for a seller without a worker pool', () => {
    assert.deepEqual(readSellerWorkers(mkdtempSync(join(tmpdir(), 'workers-')), NOW), { available: false })
  })

  it('summarizes each worker from the pool ledger, online ones first', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'workers-'))
    writeLedger(dataDir)
    assert.deepEqual(readSellerWorkers(dataDir, NOW), { available: true, workers: [
      {
        address: '0xaa', agent: 'antseed-mac/0.1.0 (Studio)', connected: true, lastSeenAt: NOW, onlineHoursWeek: 2,
        // Speed only from timed requests: 200 tokens in 0.4 s.
        requestsWeek: 2, outputTokensWeek: 300, tokensPerSecond: 500, earnedWeekUsdc: 0.001, earnedTotalUsdc: 0.001,
      },
      {
        address: '0xbb', agent: 'antseed-pool-worker/0.1.0', connected: false, lastSeenAt: NOW - 26 * HOUR, onlineHoursWeek: 4,
        requestsWeek: 0, outputTokensWeek: 0, tokensPerSecond: null, earnedWeekUsdc: 0, earnedTotalUsdc: 0.0015,
      },
    ] })
  })
})
