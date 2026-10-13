import assert from 'node:assert/strict'
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { afterEach, beforeEach, describe } from 'node:test'
import { Command } from 'commander'
import { identityFromPrivateKeyHex } from '@antseed/node'
import {
  archiveBuyerIdentity,
  createBuyerIdentity,
  listBuyerIdentities,
  loadBuyerIdentity,
  storedDefaultIdentityAddress,
} from '../../../buyer-identities/store.js'
import { registerBuyerIdentityCommands } from './identity.js'

// The passphrase comes from a file here: unlike ANTSEED_PASSPHRASE, which the
// node takes out of the environment once, it can be switched off between tests.
let dataDir: string
let passphraseFile: string

function usePassphrase(passphrase: string | null): void {
  if (passphrase === null) {
    delete process.env['ANTSEED_PASSPHRASE_FILE']
    return
  }
  writeFileSync(passphraseFile, `${passphrase}\n`)
  process.env['ANTSEED_PASSPHRASE_FILE'] = passphraseFile
}

async function run(...args: string[]): Promise<string> {
  const program = new Command()
  program.exitOverride().option('--data-dir <path>')
  const buyer = program.command('buyer')
  registerBuyerIdentityCommands(buyer)
  const lines: string[] = []
  const original = console.log
  console.log = (...parts: unknown[]) => { lines.push(parts.map(String).join(' ')) }
  try {
    await program.parseAsync(['node', 'antseed', '--data-dir', dataDir, 'buyer', 'identity', ...args])
  } finally {
    console.log = original
  }
  return lines.join('\n')
}

const keyFile = (...parts: string[]): string => join(dataDir, ...parts, 'identity.key')
const isEncrypted = (path: string): boolean => readFileSync(path, 'utf8').startsWith('{')

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'antseed-identity-protect-'))
  passphraseFile = join(dataDir, 'passphrase')
  usePassphrase(null)
})

afterEach(() => {
  usePassphrase(null)
  rmSync(dataDir, { recursive: true, force: true })
})

describe('buyer identities with a passphrase', () => {
  test('are created encrypted, listed without it, and loaded only with it', async () => {
    usePassphrase('correct horse')
    const created = await createBuyerIdentity(dataDir, 'team-a')
    assert.ok(isEncrypted(keyFile('buyer-identities', 'team-a')))
    assert.equal(statSync(keyFile('buyer-identities', 'team-a')).mode & 0o777, 0o600)
    assert.equal((await loadBuyerIdentity(dataDir, 'team-a'))?.wallet.address, created.address)

    usePassphrase(null)
    assert.deepEqual((await listBuyerIdentities(dataDir)).map((entry) => [entry.name, entry.address]), [['team-a', created.address]])
    await assert.rejects(loadBuyerIdentity(dataDir, 'team-a'), /encrypted; set ANTSEED_PASSPHRASE/)

    usePassphrase('wrong horse')
    await assert.rejects(loadBuyerIdentity(dataDir, 'team-a'), /Wrong passphrase/)
  })

  test('the default wallet address is read from an encrypted key without decrypting it', async () => {
    const hex = '44'.repeat(32)
    writeFileSync(keyFile(), hex, { mode: 0o600 })
    usePassphrase('correct horse')
    await run('protect')
    usePassphrase(null)
    assert.equal(await storedDefaultIdentityAddress(dataDir), identityFromPrivateKeyHex(hex).wallet.address)
  })
})

describe('buyer identity protect / unprotect', () => {
  test('protect refuses without a passphrase', async () => {
    writeFileSync(keyFile(), '55'.repeat(32), { mode: 0o600 })
    await assert.rejects(run('protect'), /Set ANTSEED_PASSPHRASE/)
    assert.ok(!isEncrypted(keyFile()))
  })

  test('protect --all encrypts every stored key in place; unprotect --all --yes reverses it', async () => {
    const defaultHex = '66'.repeat(32)
    writeFileSync(keyFile(), defaultHex, { mode: 0o600 })
    const team = await createBuyerIdentity(dataDir, 'team-a')
    const old = await createBuyerIdentity(dataDir, 'old')
    const archived = await archiveBuyerIdentity(dataDir, 'old')
    const files = [keyFile(), keyFile('buyer-identities', 'team-a'), join(archived, 'identity.key')]

    usePassphrase('correct horse')
    const output = await run('protect', '--all')
    assert.match(output, /Encrypted default/)
    assert.match(output, /Encrypted team-a/)
    assert.match(output, /Encrypted \.archived\/old-/)
    for (const file of files) {
      assert.ok(isEncrypted(file), file)
      assert.equal(statSync(file).mode & 0o777, 0o600, file)
    }
    assert.match(await run('protect', 'team-a'), /team-a is already encrypted/)
    assert.equal((await loadBuyerIdentity(dataDir, 'team-a'))?.wallet.address, team.address)
    assert.match(await run('list'), /data dir, encrypted/)

    await assert.rejects(run('unprotect', '--all'), /--yes/)
    assert.ok(isEncrypted(keyFile()))
    await run('unprotect', '--all', '--yes')
    assert.equal(readFileSync(keyFile(), 'utf8'), defaultHex)
    assert.equal(identityFromPrivateKeyHex(readFileSync(join(archived, 'identity.key'), 'utf8')).wallet.address, old.address)
    for (const file of files) assert.ok(!isEncrypted(file), file)
    assert.deepEqual(readdirSync(dataDir).filter((name) => name.endsWith('.tmp')), [])
  })

  test('protect takes a single identity by name and leaves the others alone', async () => {
    writeFileSync(keyFile(), '77'.repeat(32), { mode: 0o600 })
    await createBuyerIdentity(dataDir, 'team-a')
    usePassphrase('correct horse')
    await run('protect', 'team-a')
    assert.ok(isEncrypted(keyFile('buyer-identities', 'team-a')))
    assert.ok(!isEncrypted(keyFile()))
    await assert.rejects(run('protect', 'team-a', '--all'), /not both/)
  })
})
