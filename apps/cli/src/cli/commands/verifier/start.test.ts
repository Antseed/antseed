import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { ResponseAuthReader } from '../../../verifier/response-auth-reader.js'
import { collectorForPass, loadOrCreateEncryptionKey, verifierStanding } from './start.js'

const reader = {} as ResponseAuthReader
const affordable = async <T>(targets: T[]) => targets

test('a pass collects through the buyer when it is up', async () => {
  const collector = await collectorForPass({ responseAuth: reader, loadBuyerUrl: async () => 'http://127.0.0.1:8377', affordable, log: () => {} })
  assert.equal(collector?.buyerUrl, 'http://127.0.0.1:8377')
  assert.equal(collector?.responseAuth, reader)
})

test('a buyer outage only skips collection, so the pass can still attest and claim', async () => {
  const logs: string[] = []
  const collector = await collectorForPass({
    responseAuth: reader,
    loadBuyerUrl: async () => { throw new Error('buyer is not running') },
    affordable,
    log: (message) => logs.push(message),
  })
  assert.equal(collector, null)
  assert.ok(logs.some((line) => line.includes('buyer is not running')))
})

test('an attest-only verifier never touches the buyer', async () => {
  let loaded = false
  const collector = await collectorForPass({ responseAuth: null, loadBuyerUrl: async () => { loaded = true; return '' }, affordable, log: () => {} })
  assert.equal(collector, null)
  assert.equal(loaded, false)
})

test('the encryption key file is created owner-only and a readable one is repaired on load', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'antseed-verifier-key-'))
  try {
    const created = await loadOrCreateEncryptionKey(dataDir)
    const path = join(dataDir, 'verifier', 'round', 'encryption-key.json')
    assert.equal((await stat(path)).mode & 0o777, 0o600)
    assert.deepEqual(await readdir(join(dataDir, 'verifier', 'round')), ['encryption-key.json'])

    await chmod(path, 0o644)
    const loaded = await loadOrCreateEncryptionKey(dataDir)
    assert.equal(loaded.publicKey, created.publicKey)
    assert.equal((await stat(path)).mode & 0o777, 0o600)
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('an unreadable encryption key file is an error, never silently replaced', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'antseed-verifier-key-'))
  try {
    await loadOrCreateEncryptionKey(dataDir)
    await writeFile(join(dataDir, 'verifier', 'round', 'encryption-key.json'), '{not json', { mode: 0o600 })
    await assert.rejects(loadOrCreateEncryptionKey(dataDir))
  } finally {
    await rm(dataDir, { recursive: true, force: true })
  }
})

test('a removed verifier still finishes its snapshotted epoch and settles earlier ones; a stranger is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-standing-'))
  try {
    const me = '0x00000000000000000000000000000000000000aa'
    const client = (approved: boolean, members: string[]) => ({
      isVerifier: async () => approved,
      currentEpoch: async () => 9n,
      epochVerifiers: async () => members,
      contractAddress: '0xcontract',
    })
    assert.equal(await verifierStanding({ client: client(true, []), address: me, stateDir: dir }), 'approved')
    // Removed, but in the current epoch's snapshot: it completes that round.
    assert.equal(await verifierStanding({ client: client(false, [me.toUpperCase().replace('0X', '0x')]), address: me, stateDir: dir }), 'finishing')
    // Removed and out of the snapshot, nothing on disk: most likely the wrong key.
    await assert.rejects(verifierStanding({ client: client(false, []), address: me, stateDir: dir }), /not an approved verifier.*no epoch to finish or claim/)
    // Removed with earlier epochs on disk: it still applies and claims them.
    await mkdir(join(dir, '7'))
    assert.equal(await verifierStanding({ client: client(false, []), address: me, stateDir: dir }), 'finishing')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
