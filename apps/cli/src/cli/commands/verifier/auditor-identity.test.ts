import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { encryptKeystoreJsonSync, Wallet } from 'ethers'
import { resolveAuditorAddress, resolveAuditorSigner } from './auditor-identity.js'

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

test('auditor address comes from --auditor, then verifier.auditor, then verifier.keystore', async () => withKeystore(async (keystore, wallet, dataDir) => {
  assert.deepEqual(
    await resolveAuditorAddress({ config: { auditor: AUDITOR }, dataDir, flag: wallet.address.toLowerCase() }),
    { address: wallet.address, source: 'flag' },
  )
  assert.deepEqual(await resolveAuditorAddress({ config: { auditor: AUDITOR.toLowerCase() }, dataDir }), { address: AUDITOR, source: 'config' })
  assert.deepEqual(await resolveAuditorAddress({ config: { keystore }, dataDir }), { address: wallet.address, source: 'keystore' })
  await assert.rejects(resolveAuditorAddress({ config: { auditor: AUDITOR, keystore }, dataDir }), /does not match/)
}))

test('the signer must match verifier.auditor', async () => withKeystore(async (keystore, wallet, dataDir) => {
  const signer = await resolveAuditorSigner({ config: { auditor: wallet.address, keystore }, dataDir })
  assert.equal(signer.address, wallet.address)
  assert.equal(signer.source, 'keystore')
  await assert.rejects(resolveAuditorSigner({ config: { auditor: AUDITOR }, dataDir, keystoreFlag: keystore }), /does not match the keystore signer/)
}))
