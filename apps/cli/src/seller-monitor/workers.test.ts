import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { readSellerWorkers, COLONY_POOL_LEDGER_FILE, COLONY_POOL_LEDGER_POINTER_FILE } from './workers.js'

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

/** The colony-pool provider's ledger tables (plugins/provider-colony-pool/src/ledger.ts), with a few rows. */
function writeLedger(dataDir: string, file = join(dataDir, COLONY_POOL_LEDGER_FILE)): void {
  const db = new Database(file)
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
  it('is unavailable for a seller without a colony pool', () => {
    assert.deepEqual(readSellerWorkers(mkdtempSync(join(tmpdir(), 'workers-')), NOW), { available: false })
  })

  it('reads a ledger COLONY_POOL_LEDGER_PATH moved, not an old default one', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'workers-'))
    const moved = join(mkdtempSync(join(tmpdir(), 'ledger-')), 'pool.db')
    writeLedger(dataDir, moved)
    new Database(join(dataDir, COLONY_POOL_LEDGER_FILE)).close() // stale, empty default
    writeFileSync(join(dataDir, COLONY_POOL_LEDGER_POINTER_FILE), `${moved}\n`)
    const result = readSellerWorkers(dataDir, NOW)
    assert.equal(result.available, true)
    assert.equal(result.available && result.workers.length, 2)
  })

  it('stops open connections at a stale seller\'s last heartbeat', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'workers-'))
    writeLedger(dataDir)
    // The seller died an hour ago without closing 0xaa's connection (opened 2 hours ago).
    for (const at of [NOW, NOW + 5 * HOUR]) {
      const result = readSellerWorkers(dataDir, at, NOW - HOUR)
      assert.equal(result.available, true)
      const aa = result.available ? result.workers.find((w) => w.address === '0xaa') : undefined
      assert.equal(aa?.connected, false)
      assert.equal(aa?.lastSeenAt, NOW - HOUR)
      assert.equal(aa?.onlineHoursWeek, 1)
    }
    // A seller with no heartbeat at all: the open connection counts no time.
    const unknown = readSellerWorkers(dataDir, NOW, null)
    const aa = unknown.available ? unknown.workers.find((w) => w.address === '0xaa') : undefined
    assert.equal(aa?.connected, false)
    assert.equal(aa?.lastSeenAt, NOW - 2 * HOUR)
    assert.equal(aa?.onlineHoursWeek, 0)
  })

  it('summarizes each worker from the pool ledger, online ones first', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'workers-'))
    writeLedger(dataDir)
    assert.deepEqual(readSellerWorkers(dataDir, NOW), { available: true, workers: [
      {
        address: '0xaa', agent: 'antseed-mac/0.1.0 (Studio)', connected: true, lastSeenAt: NOW, onlineHoursWeek: 2,
        // Speed only from timed requests: 200 tokens in 0.4 s.
        requestsWeek: 2, outputTokensWeek: 300, tokensPerSecond: 500, earnedWeekUsdc: 0.001, earnedTotalUsdc: 0.001,
        // A ledger from before routing outcomes were recorded: no rates, ranked by the defaults.
        successRateDay: null, successRateWeek: null, firstByteMsMedian: null, benchedUntil: null, priority: 1, rank: 1,
      },
      {
        address: '0xbb', agent: 'antseed-pool-worker/0.1.0', connected: false, lastSeenAt: NOW - 26 * HOUR, onlineHoursWeek: 4,
        requestsWeek: 0, outputTokensWeek: 0, tokensPerSecond: null, earnedWeekUsdc: 0, earnedTotalUsdc: 0.0015,
        successRateDay: null, successRateWeek: null, firstByteMsMedian: null, benchedUntil: null, priority: 1, rank: null,
      },
    ] })
  })

  it('ranks connected workers by the pool\'s score and shows benched and excluded ones without a rank', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'workers-'))
    writeLedger(dataDir)
    const db = new Database(join(dataDir, COLONY_POOL_LEDGER_FILE))
    db.exec(`
      CREATE TABLE dispatches (id INTEGER PRIMARY KEY AUTOINCREMENT, worker TEXT NOT NULL, at INTEGER NOT NULL, ok INTEGER NOT NULL, reason TEXT, first_byte_ms INTEGER);
      CREATE TABLE worker_rank (worker TEXT PRIMARY KEY, reliability REAL, first_byte_ms REAL, failures INTEGER NOT NULL, benched_until INTEGER NOT NULL, priority REAL NOT NULL, updated_at INTEGER NOT NULL);
    `)
    const connect = db.prepare('INSERT INTO connections (worker, agent, connected_at, disconnected_at) VALUES (?, ?, ?, ?)')
    for (const worker of ['0xcc', '0xdd', '0xee']) connect.run(worker, 'antseed-mac/0.1.0', NOW - HOUR, null)
    const dispatch = db.prepare('INSERT INTO dispatches (worker, at, ok, reason, first_byte_ms) VALUES (?, ?, ?, ?, ?)')
    // 0xaa: 3 of 4 answered today, one failure two days ago; first bytes 100, 200, 300.
    dispatch.run('0xaa', NOW - HOUR, 1, null, 100)
    dispatch.run('0xaa', NOW - HOUR, 1, null, 300)
    dispatch.run('0xaa', NOW - HOUR, 1, null, 200)
    dispatch.run('0xaa', NOW - HOUR, 0, 'timeout', null)
    dispatch.run('0xaa', NOW - 48 * HOUR, 0, 'disconnect', null)
    const rank = db.prepare('INSERT INTO worker_rank VALUES (?, ?, ?, ?, ?, ?, ?)')
    rank.run('0xaa', 0.6, 200, 0, 0, 1, NOW)
    rank.run('0xcc', 1, 150, 0, 0, 1, NOW) // reliable: outranks 0xaa
    rank.run('0xdd', 0.4, null, 2, NOW + 60_000, 1, NOW) // benched for another minute
    rank.run('0xee', 1, null, 0, 0, 0, NOW) // the operator routes nothing to it
    db.close()
    const result = readSellerWorkers(dataDir, NOW)
    assert.equal(result.available, true)
    const workers = result.available ? result.workers : []
    assert.deepEqual(workers.map((w) => [w.address, w.rank]), [['0xcc', 1], ['0xaa', 2], ['0xdd', null], ['0xee', null], ['0xbb', null]])
    const aa = workers.find((w) => w.address === '0xaa')!
    assert.equal(aa.successRateDay, 0.75)
    assert.equal(aa.successRateWeek, 0.6)
    assert.equal(aa.firstByteMsMedian, 200)
    assert.equal(workers.find((w) => w.address === '0xdd')!.benchedUntil, NOW + 60_000)
    assert.equal(workers.find((w) => w.address === '0xee')!.priority, 0)
    // A stopped seller benches nobody.
    const stale = readSellerWorkers(dataDir, NOW, NOW - HOUR)
    assert.equal(stale.available && stale.workers.find((w) => w.address === '0xdd')!.benchedUntil, null)
  })

  it('ranks by the decode speed the pool routes by, not the weekly average it shows', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'workers-'))
    const db = new Database(join(dataDir, COLONY_POOL_LEDGER_FILE))
    db.exec(`
      CREATE TABLE earnings (request_id TEXT PRIMARY KEY, worker TEXT NOT NULL, service TEXT, gross_usdc INTEGER NOT NULL, worker_usdc INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, stream_ms INTEGER, created_at INTEGER NOT NULL);
      CREATE TABLE connections (id INTEGER PRIMARY KEY AUTOINCREMENT, worker TEXT NOT NULL, agent TEXT, connected_at INTEGER NOT NULL, disconnected_at INTEGER);
      CREATE TABLE worker_rank (worker TEXT PRIMARY KEY, reliability REAL, first_byte_ms REAL, failures INTEGER NOT NULL, benched_until INTEGER NOT NULL,
        priority REAL NOT NULL, updated_at INTEGER NOT NULL, tokens_per_second REAL NOT NULL DEFAULT 0);
    `)
    const connect = db.prepare('INSERT INTO connections (worker, agent, connected_at, disconnected_at) VALUES (?, ?, ?, ?)')
    connect.run('0xaa', 'antseed-mac/0.1.0', NOW - HOUR, null)
    connect.run('0xbb', 'antseed-mac/0.1.0', NOW - HOUR, null)
    const earn = db.prepare('INSERT INTO earnings VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    // 0xaa ran at 100 tok/s, then 1 tok/s: 50.5 on average, 80.2 as the pool smooths it. 0xbb runs at 60.
    earn.run('a1', '0xaa', 'qwen', 1000, 500, 10, 100, 1000, NOW - 2 * HOUR)
    earn.run('a2', '0xaa', 'qwen', 1000, 500, 10, 1, 1000, NOW - HOUR)
    earn.run('b1', '0xbb', 'qwen', 1000, 500, 10, 60, 1000, NOW - HOUR)
    const rank = db.prepare('INSERT INTO worker_rank VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    rank.run('0xaa', 1, 100, 0, 0, 1, NOW, 80.2)
    rank.run('0xbb', 1, 100, 0, 0, 1, NOW, 60)
    db.close()
    const result = readSellerWorkers(dataDir, NOW)
    const workers = result.available ? result.workers : []
    assert.deepEqual(workers.map((w) => [w.address, w.rank]), [['0xaa', 1], ['0xbb', 2]])
    assert.equal(workers[0]!.tokensPerSecond, 50.5)
  })

  it('takes each worker\'s first-byte median over its own latest 500 samples', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'workers-'))
    writeLedger(dataDir)
    const db = new Database(join(dataDir, COLONY_POOL_LEDGER_FILE))
    db.exec('CREATE TABLE dispatches (id INTEGER PRIMARY KEY AUTOINCREMENT, worker TEXT NOT NULL, at INTEGER NOT NULL, ok INTEGER NOT NULL, reason TEXT, first_byte_ms INTEGER)')
    const dispatch = db.prepare('INSERT INTO dispatches (worker, at, ok, reason, first_byte_ms) VALUES (?, ?, 1, null, ?)')
    // 0xaa: 600 old slow samples, then 500 newer fast ones; only the newest 500 count.
    for (let i = 0; i < 600; i++) dispatch.run('0xaa', NOW - 5 * HOUR + i, 900)
    for (let i = 0; i < 500; i++) dispatch.run('0xaa', NOW - HOUR + i, 100)
    // 0xbb: its own samples, unaffected by 0xaa's.
    dispatch.run('0xbb', NOW - HOUR, 40)
    dispatch.run('0xbb', NOW - HOUR, 60)
    // Older than a week: not counted.
    dispatch.run('0xbb', NOW - 8 * 24 * HOUR, 5000)
    db.close()
    const result = readSellerWorkers(dataDir, NOW)
    const workers = result.available ? result.workers : []
    assert.equal(workers.find((w) => w.address === '0xaa')!.firstByteMsMedian, 100)
    assert.equal(workers.find((w) => w.address === '0xbb')!.firstByteMsMedian, 50)
    assert.equal(workers.find((w) => w.address === '0xbb')!.successRateWeek, 1)
  })
})
