import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { identityFromPrivateKeyHex, type Identity } from '@antseed/node'
import { BuyerIdentityLoader } from './loader.js'
import { randomBytes } from 'node:crypto'
import { archiveBuyerIdentity, buyerIdentityExists, createBuyerIdentity, listBuyerIdentities, loadBuyerIdentity, parseKeySource } from './store.js'

function randomWallet(): { privateKey: string; address: string } {
  const hex = randomBytes(32).toString('hex')
  return { privateKey: `0x${hex}`, address: identityFromPrivateKeyHex(hex).wallet.address }
}

function tempDataDir(): { dataDir: string; cleanup: () => void } {
  const dataDir = mkdtempSync(join(tmpdir(), 'antseed-identities-'))
  return { dataDir, cleanup: () => rmSync(dataDir, { recursive: true, force: true }) }
}

test('buyer identities are created, listed, loaded and archived by name', async () => {
  const { dataDir, cleanup } = tempDataDir()
  try {
    const team = await createBuyerIdentity(dataDir, 'team-a')
    const ops = await createBuyerIdentity(dataDir, 'ops')
    assert.notEqual(team.address, ops.address)
    await assert.rejects(createBuyerIdentity(dataDir, 'team-a'), /already exists/)
    await assert.rejects(createBuyerIdentity(dataDir, 'default'), /always exists/)
    await assert.rejects(createBuyerIdentity(dataDir, 'Bad Name'), /lowercase/)

    assert.deepEqual((await listBuyerIdentities(dataDir)).map((entry) => entry.name), ['ops', 'team-a'])
    assert.equal((await loadBuyerIdentity(dataDir, 'team-a'))?.wallet.address, team.address)
    assert.equal(await loadBuyerIdentity(dataDir, 'missing'), null)

    const archived = await archiveBuyerIdentity(dataDir, 'team-a')
    assert.ok(existsSync(join(archived, 'identity.key')), 'archiving keeps the key')
    assert.deepEqual((await listBuyerIdentities(dataDir)).map((entry) => entry.name), ['ops'])
  } finally {
    cleanup()
  }
})

test('the loader adds stored identities to the node once, on demand', async () => {
  const { dataDir, cleanup } = tempDataDir()
  try {
    await createBuyerIdentity(dataDir, 'team-a')
    const added: string[] = []
    const node = {
      hasBuyerIdentity: (name: string) => added.includes(name),
      addBuyerIdentity: async (name: string, identity: Identity) => {
        added.push(name)
        return { name, address: identity.wallet.address }
      },
    }
    const loaded: string[] = []
    const loader = new BuyerIdentityLoader(node, dataDir, (name) => loaded.push(name))

    assert.equal(await loader.ensure('default'), true)
    const [first, second] = await Promise.all([loader.ensure('team-a'), loader.ensure('team-a')])
    assert.equal(first && second, true)
    assert.equal(await loader.ensure('missing'), false)
    assert.deepEqual(added, ['team-a'])
    assert.deepEqual(loaded, ['team-a'])

    await createBuyerIdentity(dataDir, 'late')
    assert.deepEqual((await loader.loadAll()).loaded.map((entry) => entry.name), ['late', 'team-a'])
    assert.deepEqual(added, ['team-a', 'late'])
  } finally {
    cleanup()
  }
})

test('identities can read their key from an env var or a secret file instead of the data dir', async () => {
  const { dataDir, cleanup } = tempDataDir()
  const envWallet = randomWallet()
  const fileWallet = randomWallet()
  const secretFile = join(dataDir, 'mounted-secret')
  writeFileSync(secretFile, `${fileWallet.privateKey}\n`)
  process.env['TEST_TEAM_A_KEY'] = envWallet.privateKey.slice(2)
  try {
    assert.throws(() => parseKeySource('vault:team-a'), /env:<VAR> or file:<absolute path>/)
    assert.throws(() => parseKeySource('file:relative/path'), /absolute/)
    await assert.rejects(createBuyerIdentity(dataDir, 'unset', 'env:TEST_UNSET_KEY'), /not set/)
    assert.equal(await buyerIdentityExists(dataDir, 'unset'), false)

    const fromEnv = await createBuyerIdentity(dataDir, 'team-a', 'env:TEST_TEAM_A_KEY')
    const fromFile = await createBuyerIdentity(dataDir, 'team-b', `file:${secretFile}`)
    assert.equal(fromEnv.address, envWallet.address)
    assert.equal(fromFile.address, fileWallet.address)
    assert.ok(!existsSync(join(fromEnv.dir, 'identity.key')), 'no key is written to the data dir')
    assert.ok(!readFileSync(join(fromEnv.dir, 'identity.json'), 'utf8').includes(envWallet.privateKey.slice(2)))
    assert.equal((await loadBuyerIdentity(dataDir, 'team-b'))?.wallet.address, fileWallet.address)

    delete process.env['TEST_TEAM_A_KEY']
    await assert.rejects(loadBuyerIdentity(dataDir, 'team-a'), /TEST_TEAM_A_KEY is not set/)
    const listed = await listBuyerIdentities(dataDir)
    assert.deepEqual(listed.map((entry) => [entry.name, entry.address, entry.keyFrom]), [
      ['team-a', null, 'env:TEST_TEAM_A_KEY'],
      ['team-b', fileWallet.address, `file:${secretFile}`],
    ])
    assert.match(listed[0]!.error ?? '', /not set/)

    writeFileSync(join(fromFile.dir, 'identity.key'), randomWallet().privateKey.slice(2))
    await assert.rejects(loadBuyerIdentity(dataDir, 'team-b'), /both identity.key and identity.json/)
  } finally {
    delete process.env['TEST_TEAM_A_KEY']
    cleanup()
  }
})

test('the loader reports identities whose key cannot be read', async () => {
  const { dataDir, cleanup } = tempDataDir()
  process.env['TEST_LOADER_KEY'] = randomWallet().privateKey
  try {
    await createBuyerIdentity(dataDir, 'ok')
    await createBuyerIdentity(dataDir, 'external', 'env:TEST_LOADER_KEY')
    delete process.env['TEST_LOADER_KEY']
    const node = {
      hasBuyerIdentity: () => false,
      addBuyerIdentity: async (name: string, identity: Identity) => ({ name, address: identity.wallet.address }),
    }
    const { loaded, failed } = await new BuyerIdentityLoader(node, dataDir).loadAll()
    assert.deepEqual(loaded.map((entry) => entry.name), ['ok'])
    assert.deepEqual(failed.map((entry) => entry.name), ['external'])
    assert.match(failed[0]!.error ?? '', /TEST_LOADER_KEY is not set/)
  } finally {
    delete process.env['TEST_LOADER_KEY']
    cleanup()
  }
})
