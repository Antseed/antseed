import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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

// Last: the answer stays set for the rest of the process.
test('start asks once for an encrypted key and hands the answer to child processes', async () => {
  const hex = '33'.repeat(32)
  await new FileIdentityStore(dataDir, { passphrase: PASSPHRASE }).save(hex)
  const prompt = fakePrompt([PASSPHRASE])
  assert.equal(await walletPassphraseForStart(dataDir, prompt), PASSPHRASE)
  assert.equal(await walletPassphraseForStart(dataDir, prompt), PASSPHRASE)
  assert.equal(prompt.questions.length, 1)
  assert.equal(await new FileIdentityStore(dataDir).load(), hex)
  assert.deepEqual(identityPassphraseEnv(), { ANTSEED_PASSPHRASE: PASSPHRASE })
})
