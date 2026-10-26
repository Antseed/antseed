import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { configWritable, patchValidatedConfig } from './patch.js'

const tempDir = () => mkdtempSync(join(tmpdir(), 'config-patch-'))
const read = (path: string) => JSON.parse(readFileSync(path, 'utf8')) as { identity?: { displayName?: string } }
const setName = (name: string) => (raw: Record<string, unknown>) => { raw.identity = { ...(raw.identity as object | undefined), displayName: name } }

test('a config under a missing directory is writable and gets created', async () => {
  const path = join(tempDir(), 'new-directory', 'nested', 'config.json')
  assert.deepEqual(await configWritable(path), { writable: true, reason: null })
  await patchValidatedConfig(path, setName('seller'))
  assert.equal(read(path).identity?.displayName, 'seller')
})

test('the backup is the file each accepted edit replaced; a rejected edit leaves it alone', async () => {
  const path = join(tempDir(), 'config.json')
  writeFileSync(path, JSON.stringify({ identity: { displayName: 'A' } }))
  await patchValidatedConfig(path, setName('B'))
  assert.equal(read(`${path}.bak`).identity?.displayName, 'A')
  await assert.rejects(patchValidatedConfig(path, () => { throw new Error('refused') }))
  assert.equal(read(path).identity?.displayName, 'B')
  assert.equal(read(`${path}.bak`).identity?.displayName, 'A', 'a rejected edit keeps the backup')
  // Either may win the lock first; the backup is always the version the last write replaced.
  await Promise.all([patchValidatedConfig(path, setName('C')), patchValidatedConfig(path, setName('D'))])
  const last = read(path).identity?.displayName
  assert.ok(last === 'C' || last === 'D')
  assert.equal(read(`${path}.bak`).identity?.displayName, last === 'D' ? 'C' : 'D', 'concurrent edits back up the version just before')
})

test('a replaced backup takes the config file\'s current mode', async () => {
  const path = join(tempDir(), 'config.json')
  writeFileSync(path, JSON.stringify({ identity: { displayName: 'A' } }), { mode: 0o644 })
  chmodSync(path, 0o644)
  await patchValidatedConfig(path, setName('B'))
  assert.equal(statSync(`${path}.bak`).mode & 0o777, 0o644)
  chmodSync(path, 0o600)
  await patchValidatedConfig(path, setName('C'))
  assert.equal(statSync(`${path}.bak`).mode & 0o777, 0o600)
  assert.equal(statSync(path).mode & 0o777, 0o600)
})
