import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Identity } from '@antseed/node'
import { BuyerIdentityLoader } from './loader.js'
import { archiveBuyerIdentity, createBuyerIdentity, listBuyerIdentities, loadBuyerIdentity } from './store.js'

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
    assert.deepEqual((await loader.loadAll()).map((entry) => entry.name), ['late', 'team-a'])
    assert.deepEqual(added, ['team-a', 'late'])
  } finally {
    cleanup()
  }
})
