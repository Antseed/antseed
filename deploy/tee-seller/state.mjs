// Seller state across restarts on Google Confidential Space, which keeps no data when its VM
// restarts (its only mounts are memory-backed). The image snapshots the databases the seller
// needs after a restart, encrypts them with a key derived from the seller identity and keeps each
// in a Cloud Storage object under the prefix the operator names (ANTSEED_GCP_STATE); on boot it
// restores them.
//
// Only payment and metering state leaves the TEE. The seller runs in content-free mode, so these
// databases hold no prompts, answers or upstream error text (e2e/tests/seller-content-leak.test.ts).
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from 'node:crypto'
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

/** One Cloud Storage object, written only over the generation this seller last saw. */
export function gcsObject({ bucket, object }, accessToken, fetchImpl = fetch) {
  const name = encodeURIComponent(object)
  return {
    async read() {
      const res = await fetchImpl(`https://storage.googleapis.com/storage/v1/b/${bucket}/o/${name}?alt=media`, {
        headers: { authorization: `Bearer ${await accessToken()}` },
        redirect: 'error',
      })
      if (res.status === 404) {
        // No snapshot yet, unless the bucket itself is missing: then a mistyped location would start the seller empty.
        const list = await fetchImpl(`https://storage.googleapis.com/storage/v1/b/${bucket}/o?maxResults=1&prefix=${name}`, {
          headers: { authorization: `Bearer ${await accessToken()}` },
          redirect: 'error',
        })
        if (list.ok) return null
        throw new Error(`reading gs://${bucket}/${object}: bucket listing answered HTTP ${list.status} ${(await list.text()).slice(0, 300)}`)
      }
      if (!res.ok) throw new Error(`reading gs://${bucket}/${object}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
      return { data: Buffer.from(await res.arrayBuffer()), generation: res.headers.get('x-goog-generation') ?? '0' }
    },
    async write(data, ifGenerationMatch) {
      const res = await fetchImpl(`https://storage.googleapis.com/upload/storage/v1/b/${bucket}/o?uploadType=media&name=${name}&ifGenerationMatch=${ifGenerationMatch}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/octet-stream' },
        body: data,
        redirect: 'error',
      })
      if (res.status === 412) throw new StateConflictError(`gs://${bucket}/${object} was written by another seller instance`)
      if (!res.ok) throw new Error(`writing gs://${bucket}/${object}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
      return String((await res.json()).generation)
    },
  }
}

/** Restores one state database on boot, then saves it whenever it changed. */
export class StateFileSync {
  constructor({ file, store, key, location, dataDir, Database }) {
    Object.assign(this, { file, store, key, location, dataDir, Database })
    this.generation = '0'
    this.savedHash = ''
    this.saving = null
  }

  /** Restore the latest snapshot unless the data dir already holds the database (a container restart on the same VM). */
  async restore() {
    const found = await this.store.read()
    if (found) this.generation = found.generation
    const path = join(this.dataDir, this.file.name)
    if (!found || existsSync(path)) return false
    const data = unseal(this.key, found.data, this.location)
    mkdirSync(dirname(path), { recursive: true })
    rmSync(`${path}-wal`, { force: true })
    rmSync(`${path}-shm`, { force: true })
    writeFileSync(path, data, { mode: 0o600 })
    return true
  }

  /** Upload a snapshot if the database changed since the last one. One save runs at a time. */
  save() {
    this.saving ??= this._save().finally(() => { this.saving = null })
    return this.saving
  }

  async _save() {
    const data = await snapshot(this.dataDir, this.file, this.Database)
    if (!data) return false
    const hash = createHash('sha256').update(data).digest('hex')
    if (hash === this.savedHash) return false
    this.generation = await this.store.write(seal(this.key, data, this.location), this.generation)
    this.savedHash = hash
    return true
  }
}

/** A sync per state file, each stored at `<prefix>/<file name>` in the operator's bucket. */
export function stateSyncs({ bucket, prefix }, accessToken, identityHex, dataDir, Database, fetchImpl = fetch) {
  const key = stateKey(identityHex)
  return STATE_FILES.map((file) => {
    const object = `${prefix}/${file.name}`
    return new StateFileSync({ file, store: gcsObject({ bucket, object }, accessToken, fetchImpl), key, location: `gs://${bucket}/${object}`, dataDir, Database })
  })
}
