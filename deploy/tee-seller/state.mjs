// Seller state across restarts on Google Confidential Space, which keeps no data when its VM
// restarts (its only mounts are memory-backed). The image snapshots the databases the seller
// needs after a restart, encrypts them with a key derived from the seller identity and keeps each
// in a Cloud Storage object under the prefix the operator names (ANTSEED_GCP_STATE); on boot it
// restores them.
//
// Only payment and metering state leaves the TEE. The seller runs in content-free mode, so these
// databases hold no prompts or answers, nor upstream error text about a request (e2e/tests/seller-content-leak.test.ts).
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { gunzipSync, gzipSync } from 'node:zlib'

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * What a seller needs after a restart, each saved on its own schedule:
 *   - its payment channels, with the latest buyer-signed spending authorizations it settles with;
 *   - its metering: free-tier usage, pending resource charges and the last week of its request
 *     log (older history would make every snapshot grow with the seller's age).
 * `trim` lists `[table, statement]` pairs run on the copy before it is saved.
 */
export const STATE_FILES = [
  {
    name: 'payments/sessions.db',
    everyMs: 30_000,
    trim: () => [],
  },
  {
    name: 'metering.db',
    everyMs: 5 * 60_000,
    trim: (now) => [
      ['metering_events', `DELETE FROM metering_events WHERE timestamp < ${now - 7 * DAY_MS}`],
      ['usage_receipts', `DELETE FROM usage_receipts WHERE timestamp < ${now - 7 * DAY_MS}`],
      ['receipt_verifications', 'DELETE FROM receipt_verifications WHERE receipt_id NOT IN (SELECT receipt_id FROM usage_receipts)'],
      ['sessions', `DELETE FROM sessions WHERE ended_at IS NOT NULL AND ended_at < ${now - 7 * DAY_MS}`],
    ],
  },
]

const MAGIC = Buffer.from('antseed-tee-state-v1')

export class StateConflictError extends Error {}

/** The snapshot key: HKDF-SHA256 of the seller identity, so only that seller's TEE can read its state. */
export function stateKey(identityHex) {
  return Buffer.from(hkdfSync('sha256', Buffer.from(identityHex.replace(/^0x/, ''), 'hex'), Buffer.alloc(0), 'antseed-tee-seller-state-v1', 32))
}

/** Gzip and AES-256-GCM, bound to the object it is stored as so a snapshot can't be moved to another object. */
export function seal(key, data, location) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv).setAAD(Buffer.from(location))
  const body = Buffer.concat([cipher.update(gzipSync(data)), cipher.final()])
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body])
}

export function unseal(key, blob, location) {
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error(`${location} is not an Antseed TEE seller state snapshot`)
  const iv = blob.subarray(MAGIC.length, MAGIC.length + 12)
  const tag = blob.subarray(MAGIC.length + 12, MAGIC.length + 28)
  const decipher = createDecipheriv('aes-256-gcm', key, iv).setAAD(Buffer.from(location)).setAuthTag(tag)
  let packed
  try {
    packed = Buffer.concat([decipher.update(blob.subarray(MAGIC.length + 28)), decipher.final()])
  } catch {
    throw new Error(`${location} was not written by this seller identity`)
  }
  return gunzipSync(packed)
}

/** A consistent copy of a state database (SQLite online backup), trimmed, or null if it doesn't exist yet. */
export async function snapshot(dataDir, file, Database, now = Date.now()) {
  const source = join(dataDir, file.name)
  if (!existsSync(source)) return null
  const work = mkdtempSync(join(tmpdir(), 'antseed-state-'))
  try {
    const copy = join(work, 'state.db')
    const live = new Database(source, { fileMustExist: true, timeout: 5000 })
    try {
      await live.backup(copy)
    } finally {
      live.close()
    }
    const db = new Database(copy)
    try {
      db.pragma('journal_mode = DELETE')
      const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").pluck().all())
      // A table an older schema lacks has nothing to trim.
      for (const [table, sql] of file.trim(now)) if (tables.has(table)) db.exec(sql)
      db.exec('VACUUM')
    } finally {
      db.close()
    }
    return readFileSync(copy)
  } finally {
    rmSync(work, { recursive: true, force: true })
  }
}

/**
 * One Cloud Storage object, written only over the generation this seller last saw. Each request
 * gives up after `timeoutMs`, or sooner when `signal` (a write's ownership deadline) aborts.
 */
export function gcsObject({ bucket, object }, accessToken, fetchImpl = fetch, { timeoutMs = 300_000 } = {}) {
  const name = encodeURIComponent(object)
  const request = async (url, { signal, ...init } = {}) => {
    const token = await accessToken()
    const timeout = AbortSignal.timeout(timeoutMs)
    return fetchImpl(url, {
      ...init,
      headers: { authorization: `Bearer ${token}`, ...init.headers },
      redirect: 'error',
      signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
    })
  }
  return {
    async read() {
      const res = await request(`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${name}?alt=media`)
      if (res.status === 404) {
        // No snapshot yet, unless the bucket itself is missing: then a mistyped location would start the seller empty.
        const list = await request(`https://storage.googleapis.com/storage/v1/b/${bucket}/o?maxResults=1&prefix=${name}`)
        if (list.ok) return null
        throw new Error(`reading gs://${bucket}/${object}: bucket listing answered HTTP ${list.status} ${(await list.text()).slice(0, 300)}`)
      }
      if (!res.ok) throw new Error(`reading gs://${bucket}/${object}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
      return { data: Buffer.from(await res.arrayBuffer()), generation: res.headers.get('x-goog-generation') ?? '0' }
    },
    async write(data, ifGenerationMatch, { signal } = {}) {
      const res = await request(`https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${name}&ifGenerationMatch=${ifGenerationMatch}`, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: data,
        signal,
      })
      if (res.status === 412) throw new StateConflictError(`gs://${bucket}/${object} changed since this seller last wrote it`)
      if (!res.ok) throw new Error(`writing gs://${bucket}/${object}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
      return String((await res.json()).generation)
    },
    async remove(ifGenerationMatch) {
      const res = await request(`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${name}?ifGenerationMatch=${ifGenerationMatch}`, { method: 'DELETE' })
      if (!res.ok && res.status !== 404 && res.status !== 412) throw new Error(`removing gs://${bucket}/${object}: HTTP ${res.status}`)
    },
  }
}

const sha256 = (data) => createHash('sha256').update(data).digest('hex')

/**
 * One seller instance at a time. An instance holds the lease (`<prefix>/lease`) before it restores
 * state or serves, renews it while it runs and releases it when it stops. Another instance with
 * this identity (a replacement VM, a duplicate deployment) waits until the lease is released or
 * expires, so two instances never take payments against the same restored state. The holder stops
 * serving if it can't renew well before expiry (see launch.mjs).
 */
export class StateLease {
  constructor({ store, holder, ttlMs = 120_000, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
    Object.assign(this, { store, holder, ttlMs, now, sleep })
    this.generation = '0'
  }

  async _read() {
    const found = await this.store.read()
    if (!found) return { generation: '0', lease: null }
    try {
      const lease = JSON.parse(found.data.toString('utf8'))
      return { generation: found.generation, lease: typeof lease?.holder === 'string' && Number.isFinite(lease?.expiresAt) ? lease : null }
    } catch {
      return { generation: found.generation, lease: null }
    }
  }

  async _write(ifGenerationMatch) {
    // The lease runs from when this write was sent, so `confirmedAt` never overstates it.
    const sentAt = this.now()
    const body = Buffer.from(JSON.stringify({ holder: this.holder, expiresAt: sentAt + this.ttlMs }))
    this.generation = await this.store.write(body, ifGenerationMatch)
    this.confirmedAt = sentAt
  }

  /** Wait until the lease is free, expired or already this holder's, then take it. `onWait(lease)` reports each wait. */
  async acquire({ onWait } = {}) {
    for (;;) {
      const { generation, lease } = await this._read()
      if (!lease || lease.holder === this.holder || lease.expiresAt <= this.now()) {
        try {
          return await this._write(generation)
        } catch (err) {
          if (!(err instanceof StateConflictError)) throw err
          continue // another instance took it first: look again
        }
      }
      onWait?.(lease)
      await this.sleep(Math.min(Math.max(lease.expiresAt - this.now(), 1000), 10_000))
    }
  }

  /** Extend the lease. Throws StateConflictError if another instance holds it now. */
  async renew() {
    try {
      await this._write(this.generation)
    } catch (err) {
      if (!(err instanceof StateConflictError)) throw err
      // A renewal whose answer was lost may have landed: still this holder's lease, carry on from it.
      const { generation, lease } = await this._read()
      if (lease?.holder !== this.holder) throw err
      await this._write(generation)
    }
  }

  /** Let the next instance in at once instead of after expiry. */
  async release() {
    await this.store.remove(this.generation)
  }
}

/**
 * Keeps a held lease and fences its holder. Renewals run one at a time; a watchdog, independent of
 * them, calls `onLost` once the last confirmed renewal is `fenceMs` old (or a renewal finds another
 * holder), so a stalled network can't leave this holder serving after its lease could expire.
 * `fenceMs` is well under the lease's lifetime, leaving the holder time to stop.
 */
export function keepLease(lease, { renewMs = 20_000, fenceMs = 60_000, checkMs = 5_000, onLost, onRetry, now = Date.now, every = setInterval, cancel = clearInterval }) {
  let lost = false
  let renewing = false
  const timers = []
  const stop = () => { for (const timer of timers) cancel(timer) }
  const lose = (reason) => {
    if (lost) return
    lost = true
    stop()
    onLost(reason)
  }
  timers.push(every(async () => {
    if (renewing || lost) return
    renewing = true
    try {
      await lease.renew()
    } catch (err) {
      if (err instanceof StateConflictError) lose(`lost the state lease: ${err.message}`)
      else onRetry?.(err)
    } finally {
      renewing = false
    }
  }, renewMs))
  timers.push(every(() => {
    if (now() - lease.confirmedAt > fenceMs) lose(`could not renew the state lease for ${fenceMs / 1000} s`)
  }, checkMs))
  // Until when this holder surely holds the lease: the lease outlives it by its lifetime less fenceMs.
  const ownedUntil = () => (lost ? 0 : lease.confirmedAt + fenceMs)
  return { valid: () => now() < ownedUntil(), ownedUntil, stop }
}

/** This data dir's lease holder id, kept so a container restarted on the same VM takes its lease back at once. */
export function leaseHolder(dataDir) {
  const path = join(dataDir, 'state-lease-holder')
  if (existsSync(path)) return readFileSync(path, 'utf8').trim()
  const holder = randomUUID()
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(path, holder)
  return holder
}

/**
 * Restores one state database on boot, then saves it whenever it changed. Every write must finish
 * while this seller surely holds the state lease (`ownedUntil`, from keepLease): it is aborted at
 * that deadline and not started after it, so a seller that lost its lease (even while shutting
 * down) never writes over the state its successor restored.
 */
export class StateFileSync {
  constructor({ file, store, key, location, dataDir, Database, ownedUntil = () => Infinity, now = Date.now }) {
    Object.assign(this, { file, store, key, location, dataDir, Database, ownedUntil, now })
    this.generation = '0'
    this.savedHash = ''
    // Hashes of snapshots sent since the last confirmed write: one may have landed with its answer lost.
    this.unconfirmed = new Set()
    this.saving = null
  }

  /** Where the generation of the snapshot the local database matches is kept. */
  get generationPath() {
    return join(this.dataDir, `${this.file.name}.generation`)
  }

  /**
   * Restore the latest snapshot. A database already in the data dir (a container restart on the
   * same VM) is kept only if it matches that snapshot's generation: otherwise another instance
   * with this identity saved since, and its state replaces this one's older copy.
   */
  async restore() {
    const found = await this.store.read()
    const path = join(this.dataDir, this.file.name)
    if (!found) return false
    this.generation = found.generation
    const local = existsSync(path) && existsSync(this.generationPath) ? readFileSync(this.generationPath, 'utf8').trim() : null
    if (local === found.generation) return false
    const data = unseal(this.key, found.data, this.location)
    mkdirSync(dirname(path), { recursive: true })
    rmSync(`${path}-wal`, { force: true })
    rmSync(`${path}-shm`, { force: true })
    writeFileSync(path, data, { mode: 0o600 })
    writeFileSync(this.generationPath, found.generation)
    return true
  }

  /**
   * The last save, after the seller has stopped: waits out a save still running (even one that
   * fails), then retries with backoff, since nothing saves this state again before the VM goes.
   * Throws if it still fails, or at once on a conflict.
   */
  async saveFinal({ attempts = 5, delayMs = 1000 } = {}) {
    await this.saving?.catch(() => {})
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.save()
      } catch (err) {
        if (err instanceof StateConflictError || attempt >= attempts) throw err
        await new Promise((resolve) => setTimeout(resolve, delayMs * 2 ** (attempt - 1)))
      }
    }
  }

  /** Upload a snapshot if the database changed since the last one. One save runs at a time. */
  save() {
    this.saving ??= this._save().finally(() => { this.saving = null })
    return this.saving
  }

  async _save() {
    const data = await snapshot(this.dataDir, this.file, this.Database)
    if (!data) return false
    const hash = sha256(data)
    if (hash === this.savedHash) return false
    try {
      await this._write(data, hash)
    } catch (err) {
      // If the object holds a snapshot this seller sent but never heard back about, carry on from it
      // rather than taking it for another instance's write.
      if (!(err instanceof StateConflictError) || !(await this._adoptOwnWrite())) throw err
      await this._write(data, hash)
    }
    return true
  }

  async _write(data, hash) {
    const remainingMs = this.ownedUntil() - this.now()
    if (remainingMs <= 0) throw new StateConflictError(`${this.location}: this seller no longer holds the state lease`)
    this.unconfirmed.add(hash)
    const signal = Number.isFinite(remainingMs) ? AbortSignal.timeout(remainingMs) : undefined
    this.generation = await this.store.write(seal(this.key, data, this.location), this.generation, { signal })
    this.unconfirmed.clear()
    writeFileSync(this.generationPath, this.generation)
    this.savedHash = hash
  }

  async _adoptOwnWrite() {
    const found = await this.store.read()
    if (!found) return false
    let data
    try {
      data = unseal(this.key, found.data, this.location)
    } catch {
      return false
    }
    if (!this.unconfirmed.has(sha256(data))) return false
    this.generation = found.generation
    writeFileSync(this.generationPath, found.generation)
    return true
  }
}

/** The lease on a seller's state, at `<prefix>/lease`. */
export function stateLease({ bucket, prefix }, accessToken, holder, fetchImpl = fetch) {
  return new StateLease({ store: gcsObject({ bucket, object: `${prefix}/lease` }, accessToken, fetchImpl, { timeoutMs: 15_000 }), holder })
}

/** A sync per state file, each stored at `<prefix>/<file name>` in the operator's bucket, written only while `ownedUntil` allows. */
export function stateSyncs({ bucket, prefix }, accessToken, identityHex, dataDir, Database, ownedUntil, fetchImpl = fetch) {
  const key = stateKey(identityHex)
  return STATE_FILES.map((file) => {
    const object = `${prefix}/${file.name}`
    return new StateFileSync({ file, store: gcsObject({ bucket, object }, accessToken, fetchImpl), key, location: `gs://${bucket}/${object}`, dataDir, Database, ownedUntil })
  })
}
