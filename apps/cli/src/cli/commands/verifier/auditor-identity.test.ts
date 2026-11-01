import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { encryptKeystoreJsonSync, Wallet } from 'ethers'
import { resolveAuditorSigner } from './auditor-identity.js'

const AUDITOR = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'

async function withKeystore(body: (path: string, wallet: Wallet, dataDir: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'antseed-auditor-'))
  const previous = process.env['ANTSEED_KEYSTORE_PASSWORD']
  process.env['ANTSEED_KEYSTORE_PASSWORD'] = 'test-password'
  try {
    const wallet = Wallet.createRandom()
    const path = join(directory, 'keystore.json')
    await writeFile(path, encryptKeystoreJsonSync(
      { address: wallet.address, privateKey: wallet.privateKey },
      'test-password',
      { scrypt: { N: 1024 } },
    ))
    await body(path, new Wallet(wallet.privateKey), directory)
  } finally {
    if (previous === undefined) delete process.env['ANTSEED_KEYSTORE_PASSWORD']
    else process.env['ANTSEED_KEYSTORE_PASSWORD'] = previous
    await rm(directory, { recursive: true, force: true })
  }
}

test('the signer must match verifier.auditor', async () => withKeystore(async (keystore, wallet, dataDir) => {
  const signer = await resolveAuditorSigner({ config: { auditor: wallet.address, keystore }, dataDir })
  assert.equal(signer.address, wallet.address)
  assert.equal(signer.source, 'keystore')
  await assert.rejects(resolveAuditorSigner({ config: { auditor: AUDITOR }, dataDir, keystoreFlag: keystore }), /does not match the keystore signer/)
}))

test('without a keystore there is no fallback to the buyer identity', async () => withKeystore(async (_keystore, _wallet, dataDir) => {
  await assert.rejects(resolveAuditorSigner({ config: {}, dataDir }), /dedicated signer, never the buyer identity.*cast wallet/)
}))

test('a keystore holding the buyer hot wallet is refused', async () => withKeystore(async (keystore, wallet, dataDir) => {
  await writeFile(join(dataDir, 'identity.key'), wallet.privateKey.slice(2), { mode: 0o600 })
  await assert.rejects(resolveAuditorSigner({ config: { keystore }, dataDir }), /is a buyer wallet of this data dir/)
  await assert.rejects(resolveAuditorSigner({ config: {}, dataDir, keystoreFlag: keystore }), /is a buyer wallet of this data dir/)
}))

test('a keystore holding a named buyer identity is refused', async () => withKeystore(async (keystore, wallet, dataDir) => {
  const named = join(dataDir, 'buyer-identities', 'work')
  await mkdir(named, { recursive: true })
  await writeFile(join(named, 'identity.key'), wallet.privateKey.slice(2), { mode: 0o600 })
  await assert.rejects(resolveAuditorSigner({ config: { keystore }, dataDir }), /is a buyer wallet of this data dir/)
}))

// Last in this file: the node keeps the first identity it reads from the environment for the process.
test('checking the signer leaves the env-provided buyer identity for the buyer it starts', async () => withKeystore(async (keystore, _wallet, dataDir) => {
  const buyer = Wallet.createRandom()
  const previous = process.env['ANTSEED_IDENTITY_HEX']
  process.env['ANTSEED_IDENTITY_HEX'] = buyer.privateKey.slice(2)
  try {
    await resolveAuditorSigner({ config: { keystore }, dataDir })
    assert.equal(process.env['ANTSEED_IDENTITY_HEX'], buyer.privateKey.slice(2), 'the spawned buyer still inherits it')
    // And it is still recognised as the buyer wallet.
    const { buyerHotAddresses } = await import('./auditor-identity.js')
    assert.ok((await buyerHotAddresses(dataDir)).has(buyer.address))
  } finally {
    if (previous === undefined) delete process.env['ANTSEED_IDENTITY_HEX']
    else process.env['ANTSEED_IDENTITY_HEX'] = previous
  }
}))
