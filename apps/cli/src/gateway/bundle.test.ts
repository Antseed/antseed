import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Worker } from 'node:worker_threads'
import Database from 'better-sqlite3'
import { identityFromPrivateKeyHex } from '@antseed/node'
import { AuthDb } from './auth/db.js'
import { allowedBundlePath, BUNDLE_MAGIC, BundleError, exportGatewayBundle, importGatewayBundle } from './bundle.js'
import { CONSOLE_LOCATION_SETTING, readConsoleLocation } from './console-location.js'
import { createRecoveryLink } from './console-recovery.js'
import { GatewayStore } from './store.js'

const FAST_KDF = { N: 2 ** 14, r: 8, p: 1 }
const PASSWORD = 'correct horse battery'
const NO_LIMITS = { daily: null, weekly: null, monthly: null, total: null }
const DEFAULT_KEY = '11'.repeat(32)
const ALPHA_KEY = '22'.repeat(32)
const posix = process.platform !== 'win32'

function mode(path: string): number {
  return statSync(path).mode & 0o777
}

/** A laptop data dir: gateway with an owner (passkey + session), workspaces, keys, two wallets, channels, config. */
function seedSource(root: string) {
  const dataDir = join(root, 'laptop')
  mkdirSync(dataDir, { recursive: true })
  writeFileSync(join(dataDir, 'identity.key'), DEFAULT_KEY, { mode: 0o600 })
  mkdirSync(join(dataDir, 'buyer-identities', 'ws-alpha'), { recursive: true })
  writeFileSync(join(dataDir, 'buyer-identities', 'ws-alpha', 'identity.key'), ALPHA_KEY, { mode: 0o600 })
  mkdirSync(join(dataDir, 'payments'), { recursive: true })
  const channels = new Database(join(dataDir, 'payments', 'sessions.db'))
  channels.pragma('journal_mode = WAL')
  channels.exec('CREATE TABLE payment_channels (id TEXT PRIMARY KEY, cumulative TEXT)')
  channels.prepare('INSERT INTO payment_channels VALUES (?, ?)').run('0xchannel-fake', '1500000')
  channels.close()
  const configPath = join(dataDir, 'config.json')
  writeFileSync(configPath, JSON.stringify({ buyer: { proxyPort: 8377, minPeerReputation: 40 } }))

  const store = new GatewayStore(dataDir)
  const owner = store.createOwner({ label: 'Dana', email: 'dana@example.test' })
  const alpha = store.createWorkspace({ name: 'Alpha', buyerIdentity: 'ws-alpha' })
  const key = store.createKey({ label: 'laptop key', workspaceId: alpha.id, limits: NO_LIMITS, expiresAt: null })
  store.setSetting(CONSOLE_LOCATION_SETTING, { publicUrl: null, port: 8379, host: '127.0.0.1' })
  const auth = new AuthDb(store.database, () => Date.now())
  auth.addCredential(owner.id, { kind: 'passkey', label: 'MacBook', webauthnId: 'cred-fake', publicKey: new Uint8Array([1, 2, 3]), counter: 0, transports: [] })
  auth.addCredential(owner.id, { kind: 'wallet', label: 'Wallet', address: '0x00000000000000000000000000000000000000aa' })
  auth.createSession({ kind: 'member', memberId: owner.id }, { userAgent: null, ip: null })
  createRecoveryLink(store, { publicUrl: null, port: 8379 }, owner.id)
  store.close()
  return { dataDir, configPath, ownerId: owner.id, apiKey: key.secret }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'antseed-bundle-'))
  const source = seedSource(root)
  const server = join(root, 'server', '.antseed')
  return { root, source, server, serverConfig: join(server, 'config.json'), bundle: join(root, 'antseed-gateway.bundle'), cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

async function exportFixture(f: ReturnType<typeof fixture>, extra: { force?: boolean } = {}) {
  return exportGatewayBundle({
    dataDir: f.source.dataDir,
    configPath: f.source.configPath,
    outFile: f.bundle,
    password: PASSWORD,
    cliVersion: '0.0.0-test',
    scryptParams: FAST_KDF,
    ...extra,
  })
}

test('export → import round trip restores keys, members, wallets and channels; sessions end, keys keep working', async () => {
  const f = fixture()
  try {
    const exported = await exportFixture(f)
    if (posix) assert.equal(mode(f.bundle), 0o600, 'the bundle is readable only by its owner')
    assert.ok(readFileSync(f.bundle).subarray(0, BUNDLE_MAGIC.length).toString() === BUNDLE_MAGIC)
    const raw = readFileSync(f.bundle)
    assert.ok(!raw.includes(Buffer.from(DEFAULT_KEY)) && !raw.includes(Buffer.from('dana@example.test')), 'nothing readable in the file')
    assert.deepEqual(exported.files.sort(), [
      'config/config.json', 'data/buyer-identities/ws-alpha/identity.key', 'data/gateway/gateway.db', 'data/identity.key', 'data/payments/sessions.db',
    ])
    assert.equal(exported.summary.activeKeys, 1)
    assert.ok(readdirSync(f.root).every((name) => !name.includes('.export-') && !name.includes('.partial-')), 'no staging left behind')
    await assert.rejects(exportFixture(f), /already exists/)
    await exportFixture(f, { force: true })

    const result = await importGatewayBundle({
      bundleFile: f.bundle, dataDir: f.server, configPath: f.serverConfig, password: PASSWORD, publicUrl: 'https://llm.example.com',
    })
    assert.equal(result.sessionsCleared, 1)
    assert.equal(result.passkeysStranded, true, 'localhost passkeys do not work on the new domain')
    assert.equal(result.previousOrigin, 'http://localhost:8379')
    assert.equal(result.newOrigin, 'https://llm.example.com')
    assert.deepEqual(result.backups, [])
    assert.equal(result.summary.workspaces.find((ws) => ws.name === 'Alpha')?.address, identityFromPrivateKeyHex(ALPHA_KEY).wallet.address)
    assert.equal(result.summary.wallets.find((wallet) => wallet.name === 'default')?.address, identityFromPrivateKeyHex(DEFAULT_KEY).wallet.address)
    assert.ok(!JSON.stringify(result).includes(DEFAULT_KEY) && !JSON.stringify(result).includes(f.source.apiKey), 'the summary holds no secrets')

    assert.equal(readFileSync(join(f.server, 'identity.key'), 'utf8'), DEFAULT_KEY)
    assert.equal(readFileSync(join(f.server, 'buyer-identities', 'ws-alpha', 'identity.key'), 'utf8'), ALPHA_KEY)
    assert.equal(JSON.parse(readFileSync(f.serverConfig, 'utf8')).buyer.minPeerReputation, 40)
    const channels = new Database(join(f.server, 'payments', 'sessions.db'), { readonly: true })
    assert.equal((channels.prepare('SELECT cumulative FROM payment_channels').get() as { cumulative: string }).cumulative, '1500000')
    channels.close()
    if (posix) {
      for (const dir of [f.server, join(f.server, 'gateway'), join(f.server, 'buyer-identities'), join(f.server, 'buyer-identities', 'ws-alpha'), join(f.server, 'payments')]) {
        assert.equal(mode(dir), 0o700, dir)
      }
      for (const file of ['identity.key', 'buyer-identities/ws-alpha/identity.key', 'gateway/gateway.db', 'payments/sessions.db']) assert.equal(mode(join(f.server, file)), 0o600, file)
      assert.equal(mode(f.serverConfig), 0o600)
    }

    const store = new GatewayStore(f.server)
    try {
      assert.ok(store.findKeyBySecret(f.source.apiKey), 'API keys keep working')
      assert.equal(store.getMember(f.source.ownerId)?.orgRole, 'owner')
      assert.deepEqual(readConsoleLocation(store), { publicUrl: 'https://llm.example.com', port: 8379 })
      const count = (table: string) => (store.database.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n
      assert.equal(count('auth_sessions'), 0)
      assert.equal(count('console_recovery_tokens'), 0)
      assert.equal(count('auth_credentials'), 2, 'sign-in methods are kept')
      assert.ok(store.listAudit({}).entries.some((entry) => entry.action === 'gateway.import'))
    } finally {
      store.close()
    }
    assert.ok(readdirSync(join(f.root, 'server')).every((name) => !name.includes('.import-')), 'no staging left behind')
  } finally {
    f.cleanup()
  }
})

test('a wrong password or any tampering fails without touching the target', async () => {
  const f = fixture()
  try {
    await exportFixture(f)
    const attempt = (bundleFile: string, password = PASSWORD) =>
      importGatewayBundle({ bundleFile, dataDir: f.server, configPath: f.serverConfig, password })

    await assert.rejects(attempt(f.bundle, 'not the password'), (error: unknown) => error instanceof BundleError && /password is wrong/.test(error.message))

    const original = readFileSync(f.bundle)
    const tampered = join(f.root, 'tampered.bundle')
    const body = Buffer.from(original)
    body[Math.floor(body.length / 2)]! ^= 0x01
    writeFileSync(tampered, body)
    await assert.rejects(attempt(tampered), BundleError)

    const header = Buffer.from(original)
    const salt = header.indexOf(Buffer.from('"iv":"')) + 6
    header[salt] = header[salt] === 0x41 ? 0x42 : 0x41
    writeFileSync(tampered, header)
    await assert.rejects(attempt(tampered), BundleError)

    writeFileSync(tampered, original.subarray(0, original.length - 5))
    await assert.rejects(attempt(tampered), BundleError)

    writeFileSync(tampered, 'hello')
    await assert.rejects(attempt(tampered), /not an Antseed gateway bundle/)

    assert.ok(!existsSync(join(f.server, 'gateway')), 'nothing was restored')
    assert.ok(!existsSync(join(f.server, 'identity.key')))
  } finally {
    f.cleanup()
  }
})

test('import refuses a data dir that already holds a gateway or wallet, and --force moves it aside', async () => {
  const f = fixture()
  try {
    await exportFixture(f)
    mkdirSync(f.server, { recursive: true })
    writeFileSync(join(f.server, 'identity.key'), '33'.repeat(32))
    const options = { bundleFile: f.bundle, dataDir: f.server, configPath: f.serverConfig, password: PASSWORD }
    await assert.rejects(importGatewayBundle(options), /already holds a gateway or wallet \(identity.key\).*--force/)
    assert.equal(readFileSync(join(f.server, 'identity.key'), 'utf8'), '33'.repeat(32))

    const result = await importGatewayBundle({ ...options, force: true, port: 9000 })
    assert.equal(result.backups.length, 1)
    assert.equal(readFileSync(join(result.backups[0]!, 'identity.key'), 'utf8'), '33'.repeat(32), 'the old data is kept')
    assert.equal(readFileSync(join(f.server, 'identity.key'), 'utf8'), DEFAULT_KEY)
    assert.equal(result.newOrigin, 'http://localhost:9000')
    assert.equal(result.passkeysStranded, false, 'a passkey is bound to the host name, not the port')
  } finally {
    f.cleanup()
  }
})

test('export refuses weak passwords, missing gateway data and app-encrypted wallets', async () => {
  const f = fixture()
  try {
    await assert.rejects(exportGatewayBundle({ dataDir: f.source.dataDir, configPath: f.source.configPath, outFile: f.bundle, password: 'short', cliVersion: 't' }), /at least 10/)
    const empty = join(f.root, 'empty')
    mkdirSync(empty)
    await assert.rejects(exportGatewayBundle({ dataDir: empty, configPath: join(empty, 'c.json'), outFile: f.bundle, password: PASSWORD, cliVersion: 't' }), /No gateway data/)
    rmSync(join(f.source.dataDir, 'identity.key'))
    writeFileSync(join(f.source.dataDir, 'identity.enc'), 'opaque')
    await assert.rejects(exportFixture(f), /encrypted by the Antseed desktop app/)
  } finally {
    f.cleanup()
  }
})

test('only known paths may come out of a bundle', () => {
  for (const path of ['data/gateway/gateway.db', 'data/identity.key', 'config/config.json', 'data/buyer-identities/team-a/identity.key', 'data/buyer-identities/.archived/old-1/identity.key']) {
    assert.equal(allowedBundlePath(path), true, path)
  }
  for (const path of ['../etc/passwd', 'data/../../x', 'data/buyer-identities/../identity.key', 'data/buyer-identities/a', '/abs', 'data/gateway/other.db', 'data/buyer-identities/a/b c']) {
    assert.equal(allowedBundlePath(path), false, path)
  }
})

test('the database snapshot is consistent while a gateway keeps writing', async () => {
  const f = fixture()
  const db = join(f.source.dataDir, 'gateway', 'gateway.db')
  const setup = new Database(db)
  setup.exec('CREATE TABLE writes (id INTEGER PRIMARY KEY, payload TEXT); CREATE TABLE tally (n INTEGER); INSERT INTO tally VALUES (0)')
  setup.close()
  const sqlite = createRequire(import.meta.url).resolve('better-sqlite3')
  const worker = new Worker(`
    const { workerData, parentPort } = require('node:worker_threads')
    const Database = require(workerData.sqlite)
    const db = new Database(workerData.db, { timeout: 5000 })
    db.pragma('busy_timeout = 5000')
    const write = db.transaction(() => {
      db.prepare('INSERT INTO writes (payload) VALUES (?)').run('x'.repeat(200))
      db.prepare('UPDATE tally SET n = n + 1').run()
    })
    let stop = false
    parentPort.on('message', () => { stop = true })
    let count = 0
    const loop = () => {
      for (let i = 0; i < 50 && !stop; i += 1) { write(); count += 1 }
      if (count === 50) parentPort.postMessage('started')
      if (stop) { db.close(); parentPort.postMessage('done:' + count); return }
      setImmediate(loop)
    }
    loop()
  `, { eval: true, workerData: { sqlite, db } })
  try {
    await new Promise<void>((resolve) => worker.once('message', () => resolve()))
    await exportFixture(f)
    const finished = new Promise<string>((resolve) => worker.on('message', (message: string) => { if (message.startsWith('done:')) resolve(message) }))
    worker.postMessage('stop')
    const total = Number((await finished).slice(5))

    await importGatewayBundle({ bundleFile: f.bundle, dataDir: f.server, configPath: f.serverConfig, password: PASSWORD })
    const restored = new Database(join(f.server, 'gateway', 'gateway.db'), { readonly: true })
    try {
      assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok')
      const rows = (restored.prepare('SELECT COUNT(*) AS n FROM writes').get() as { n: number }).n
      const tally = (restored.prepare('SELECT n FROM tally').get() as { n: number }).n
      assert.equal(rows, tally, 'both tables come from the same moment')
      assert.ok(rows >= 50 && rows <= total, `snapshot holds ${rows} of ${total} writes`)
    } finally {
      restored.close()
    }
  } finally {
    await worker.terminate()
    f.cleanup()
  }
})
