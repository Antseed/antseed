import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it, beforeEach, afterEach } from 'node:test'
import { STATE_FILES, StateConflictError, StateFileSync, gcsObject, seal, snapshot, stateKey, stateSyncs, unseal } from './state.mjs'

const Database = createRequire(new URL('../../packages/node/package.json', import.meta.url))('better-sqlite3')
const LOCATION = 'gs://seller-state/tee/payments/sessions.db'
const KEY = stateKey('11'.repeat(32))
const [PAYMENTS, METERING] = STATE_FILES
const DAY_MS = 24 * 60 * 60 * 1000

/** A seller data dir with live (WAL) payment and metering databases. */
function sellerDataDir() {
  const dir = mkdtempSync(join(tmpdir(), 'seller-'))
  mkdirSync(join(dir, 'payments'))
  const sessions = new Database(join(dir, 'payments/sessions.db'))
  sessions.pragma('journal_mode = WAL')
  sessions.exec(`CREATE TABLE payment_channels (session_id TEXT PRIMARY KEY, latest_buyer_sig TEXT);
    INSERT INTO payment_channels VALUES ('ch1', '0xsig');`)
  const metering = new Database(join(dir, 'metering.db'))
  metering.pragma('journal_mode = WAL')
  metering.exec(`CREATE TABLE metering_events (event_id TEXT, timestamp INTEGER);
    CREATE TABLE free_tier_usage (buyer TEXT, tokens INTEGER);
    INSERT INTO metering_events VALUES ('recent', ${Date.now()});
    INSERT INTO metering_events VALUES ('old', ${Date.now() - 8 * DAY_MS});
    INSERT INTO free_tier_usage VALUES ('b1', 500);`)
  return { dir, sessions, metering }
}

/** An in-memory Cloud Storage object with generation preconditions. */
function memoryStore() {
  const store = { object: null, generation: 0, writes: 0 }
  return Object.assign(store, {
    async read() { return store.object ? { data: store.object, generation: String(store.generation) } : null },
    async write(data, ifGenerationMatch) {
      if (String(store.generation) !== ifGenerationMatch) throw new StateConflictError('written by another seller instance')
      store.object = data
      store.generation += 1
      store.writes += 1
      return String(store.generation)
    },
  })
}

const rows = (path, sql) => {
  const db = new Database(path, { readonly: true })
  try { return db.prepare(sql).all() } finally { db.close() }
}

describe('seller state snapshots', () => {
  let seller
  beforeEach(() => { seller = sellerDataDir() })
  afterEach(() => {
    seller.sessions.close()
    seller.metering.close()
    rmSync(seller.dir, { recursive: true, force: true })
  })

  it('restores the payment channels and a week of request log', async () => {
    const restored = mkdtempSync(join(tmpdir(), 'restored-'))
    for (const file of STATE_FILES) {
      const data = await snapshot(seller.dir, file, Database)
      const store = memoryStore()
      store.object = seal(KEY, data, LOCATION)
      assert.equal(await new StateFileSync({ file, store, key: KEY, location: LOCATION, dataDir: restored, Database }).restore(), true)
    }
    assert.deepEqual(rows(join(restored, 'payments/sessions.db'), 'SELECT * FROM payment_channels'), [{ session_id: 'ch1', latest_buyer_sig: '0xsig' }])
    assert.deepEqual(rows(join(restored, 'metering.db'), 'SELECT event_id FROM metering_events'), [{ event_id: 'recent' }])
    assert.deepEqual(rows(join(restored, 'metering.db'), 'SELECT * FROM free_tier_usage'), [{ buyer: 'b1', tokens: 500 }])
    rmSync(restored, { recursive: true, force: true })
  })

  it('leaves the live databases untouched', async () => {
    await snapshot(seller.dir, METERING, Database)
    assert.equal(seller.metering.prepare('SELECT count(*) AS n FROM metering_events').get().n, 2)
  })

  it('saves only when the database changed, over the generation it last saw', async () => {
    const store = memoryStore()
    const sync = new StateFileSync({ file: PAYMENTS, store, key: KEY, location: LOCATION, dataDir: seller.dir, Database })
    assert.equal(await sync.restore(), false)
    assert.equal(await sync.save(), true)
    assert.equal(await sync.save(), false)
    seller.sessions.exec("UPDATE payment_channels SET latest_buyer_sig = '0xnewer'")
    assert.equal(await sync.save(), true)
    assert.equal(store.writes, 2)
    store.generation += 1 // another instance wrote
    seller.sessions.exec("UPDATE payment_channels SET latest_buyer_sig = '0xnewest'")
    await assert.rejects(sync.save(), StateConflictError)
  })

  it('keeps local state after a container restart on the same VM, if it is the version saved last', async () => {
    const store = memoryStore()
    const sync = new StateFileSync({ file: PAYMENTS, store, key: KEY, location: LOCATION, dataDir: seller.dir, Database })
    await sync.restore()
    await sync.save()
    seller.sessions.exec("UPDATE payment_channels SET latest_buyer_sig = '0xunsaved'")
    const restarted = new StateFileSync({ file: PAYMENTS, store, key: KEY, location: LOCATION, dataDir: seller.dir, Database })
    assert.equal(await restarted.restore(), false)
    assert.equal(restarted.generation, '1')
    assert.equal(seller.sessions.prepare('SELECT latest_buyer_sig FROM payment_channels').get().latest_buyer_sig, '0xunsaved')
  })

  it('replaces a local copy that another instance has saved over since', async () => {
    const store = memoryStore()
    const loser = new StateFileSync({ file: PAYMENTS, store, key: KEY, location: LOCATION, dataDir: seller.dir, Database })
    await loser.restore()
    await loser.save()
    // Another instance with this identity saves newer payments; this one loses its next save.
    const winnerDir = mkdtempSync(join(tmpdir(), 'winner-'))
    const winner = new StateFileSync({ file: PAYMENTS, store, key: KEY, location: LOCATION, dataDir: winnerDir, Database })
    assert.equal(await winner.restore(), true)
    const winnerDb = new Database(join(winnerDir, 'payments/sessions.db'))
    winnerDb.exec("UPDATE payment_channels SET latest_buyer_sig = '0xwinner'")
    winnerDb.close()
    await winner.save()
    seller.sessions.exec("UPDATE payment_channels SET latest_buyer_sig = '0xstale'")
    await assert.rejects(loser.save(), StateConflictError)
    // The loser restarts on the same VM: the winner's payments replace its stale copy.
    seller.sessions.close()
    const restarted = new StateFileSync({ file: PAYMENTS, store, key: KEY, location: LOCATION, dataDir: seller.dir, Database })
    assert.equal(await restarted.restore(), true)
    assert.deepEqual(rows(join(seller.dir, 'payments/sessions.db'), 'SELECT latest_buyer_sig FROM payment_channels'), [{ latest_buyer_sig: '0xwinner' }])
    seller.sessions = new Database(join(seller.dir, 'payments/sessions.db'))
    rmSync(winnerDir, { recursive: true, force: true })
  })

  it('retries the last save until it lands, after a save still running fails', async () => {
    const store = memoryStore()
    const write = store.write
    let failures = 2
    store.write = async (data, generation) => {
      if (failures-- > 0) throw new Error('storage unavailable')
      return write(data, generation)
    }
    const sync = new StateFileSync({ file: PAYMENTS, store, key: KEY, location: LOCATION, dataDir: seller.dir, Database })
    await sync.restore()
    const running = sync.save()
    running.catch(() => {})
    assert.equal(await sync.saveFinal({ delayMs: 1 }), true)
    await assert.rejects(running, /storage unavailable/)
    assert.equal(store.writes, 1)
  })

  it('gives up on the last save after its attempts, and at once on a conflict', async () => {
    const store = memoryStore()
    let calls = 0
    store.write = async () => { calls += 1; throw new Error('storage unavailable') }
    const sync = new StateFileSync({ file: PAYMENTS, store, key: KEY, location: LOCATION, dataDir: seller.dir, Database })
    await assert.rejects(sync.saveFinal({ attempts: 3, delayMs: 1 }), /storage unavailable/)
    assert.equal(calls, 3)
    store.write = async () => { calls += 1; throw new StateConflictError('written by another seller instance') }
    calls = 0
    await assert.rejects(sync.saveFinal({ attempts: 3, delayMs: 1 }), StateConflictError)
    assert.equal(calls, 1)
  })

  it('keeps each database in its own object under the prefix', () => {
    const syncs = stateSyncs({ bucket: 'seller-state', prefix: 'tee' }, async () => 'tok', '11'.repeat(32), seller.dir, Database)
    assert.deepEqual(syncs.map((s) => s.location), ['gs://seller-state/tee/payments/sessions.db', 'gs://seller-state/tee/metering.db'])
  })
})

describe('sealing', () => {
  it('opens only with the same seller identity and object', () => {
    const blob = seal(KEY, Buffer.from('state'), LOCATION)
    assert.equal(unseal(KEY, blob, LOCATION).toString(), 'state')
    assert.throws(() => unseal(stateKey('22'.repeat(32)), blob, LOCATION), /not written by this seller identity/)
    assert.throws(() => unseal(KEY, blob, 'gs://seller-state/tee/metering.db'), /not written by this seller identity/)
    assert.throws(() => unseal(KEY, Buffer.from('garbage'), LOCATION), /not an Antseed TEE seller state snapshot/)
  })
})

describe('gcsObject', () => {
  it('reads with the generation and writes with a precondition', async () => {
    const calls = []
    const fetchImpl = async (url, init) => {
      calls.push({ url, auth: init.headers.authorization })
      if (calls.length === 1) return new Response(null, { status: 404 })
      if (calls.length === 2) return Response.json({ items: [] })
      if (calls.length === 3) return Response.json({ generation: '7' })
      return new Response('conflict', { status: 412 })
    }
    const object = gcsObject({ bucket: 'seller-state', object: 'tee/metering.db' }, async () => 'tok', fetchImpl)
    assert.equal(await object.read(), null)
    assert.equal(await object.write(Buffer.from('x'), '0'), '7')
    await assert.rejects(object.write(Buffer.from('y'), '7'), StateConflictError)
    assert.equal(calls[0].url, 'https://storage.googleapis.com/storage/v1/b/seller-state/o/tee%2Fmetering.db?alt=media')
    assert.equal(calls[1].url, 'https://storage.googleapis.com/storage/v1/b/seller-state/o?maxResults=1&prefix=tee%2Fmetering.db')
    assert.equal(calls[2].url, 'https://storage.googleapis.com/upload/storage/v1/b/seller-state/o?uploadType=media&name=tee%2Fmetering.db&ifGenerationMatch=0')
    assert.ok(calls.every((c) => c.auth === 'Bearer tok'))
  })

  it('fails instead of starting empty when the bucket does not exist', async () => {
    const fetchImpl = async () => new Response('The specified bucket does not exist.', { status: 404 })
    const object = gcsObject({ bucket: 'mistyped', object: 'tee/metering.db' }, async () => 'tok', fetchImpl)
    await assert.rejects(object.read(), /bucket listing answered HTTP 404/)
  })
})
