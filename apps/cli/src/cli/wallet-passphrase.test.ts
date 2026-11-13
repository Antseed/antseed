import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test, { afterEach, beforeEach } from 'node:test'
import { FileIdentityStore, identityPassphraseEnv } from '@antseed/node'
import { walletPassphraseForStart, type PassphrasePrompt } from './wallet-passphrase.js'

const PASSPHRASE = 'correct horse battery'
let dataDir: string

function fakePrompt(answers: string[], available = true): PassphrasePrompt & { questions: string[] } {
  const questions: string[] = []
  return { available, questions, ask: async (question) => { questions.push(question); return answers.shift() ?? '' } }
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'antseed-wallet-passphrase-'))
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
})

test('start asks nothing when no stored key is encrypted', async () => {
  writeFileSync(join(dataDir, 'identity.key'), '11'.repeat(32), { mode: 0o600 })
  const prompt = fakePrompt([PASSPHRASE])
  assert.equal(await walletPassphraseForStart(dataDir, prompt), null)
  assert.deepEqual(prompt.questions, [])
})

test('start never asks without a terminal', async () => {
  await new FileIdentityStore(dataDir, { passphrase: PASSPHRASE }).save('22'.repeat(32))
  const prompt = fakePrompt([PASSPHRASE], false)
  assert.equal(await walletPassphraseForStart(dataDir, prompt), null)
  assert.deepEqual(prompt.questions, [])
})

function useFilePassphrase(passphrase: string | null): void {
  if (passphrase === null) {
    delete process.env['ANTSEED_PASSPHRASE_FILE']
    return
  }
  const file = join(dataDir, 'passphrase')
  writeFileSync(file, `${passphrase}\n`)
  process.env['ANTSEED_PASSPHRASE_FILE'] = file
}

/** A plaintext default key and an encrypted workspace key, as after protecting only the workspace. */
async function mixedDataDir(): Promise<void> {
  writeFileSync(join(dataDir, 'identity.key'), '44'.repeat(32), { mode: 0o600 })
  const workspace = join(dataDir, 'buyer-identities', 'team-a')
  mkdirSync(workspace, { recursive: true })
  await new FileIdentityStore(workspace, { passphrase: PASSPHRASE }).save('55'.repeat(32))
}

test('start refuses a configured passphrase that does not unlock the encrypted keys', async () => {
  await mixedDataDir()
  useFilePassphrase('correct horse batery')
  try {
    // Accepting it would encrypt every wallet created from now on (a console workspace) under the typo.
    await assert.rejects(walletPassphraseForStart(dataDir, fakePrompt([])), /ANTSEED_PASSPHRASE \(or ANTSEED_PASSPHRASE_FILE\) does not unlock the encrypted wallet key "team-a"/)
    useFilePassphrase(PASSPHRASE)
    assert.equal(await walletPassphraseForStart(dataDir, fakePrompt([])), PASSPHRASE)
  } finally {
    useFilePassphrase(null)
  }
})

test('start asks again after a mistyped passphrase, and gives up after three', async () => {
  await mixedDataDir()
  const prompt = fakePrompt(['wrong one here', 'wrong two here', 'wrong three here'])
  await assert.rejects(walletPassphraseForStart(dataDir, prompt), /Wrong passphrase/)
  assert.equal(prompt.questions.length, 3)
  assert.deepEqual(identityPassphraseEnv(), {})
})

// Last: the answer stays set for the rest of the process.
test('start asks once for an encrypted key and hands the answer to child processes', async () => {
  const hex = '33'.repeat(32)
  await new FileIdentityStore(dataDir, { passphrase: PASSPHRASE }).save(hex)
  const prompt = fakePrompt(['mistyped passphrase', PASSPHRASE])
  assert.equal(await walletPassphraseForStart(dataDir, prompt), PASSPHRASE)
  assert.equal(await walletPassphraseForStart(dataDir, prompt), PASSPHRASE)
  assert.equal(prompt.questions.length, 2)
  assert.equal(await new FileIdentityStore(dataDir).load(), hex)
  assert.deepEqual(identityPassphraseEnv(), { ANTSEED_PASSPHRASE: PASSPHRASE })
})
