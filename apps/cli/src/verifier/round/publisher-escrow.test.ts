import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Wallet, keccak256, toUtf8Bytes } from 'ethers'
import { ZERO_HASH } from '@antseed/node/payments'
import { referenceFixture } from '../model-audit-fixtures.test-support.js'
import { EPOCH_SECONDS, FakeRoundClient } from './fake-round-client.test-support.js'
import { fallbackPublisherTick, takeoverTime } from './fallback-publisher.js'
import { keyEscrowTick, keyRevealDelay } from './key-escrow.js'
import { buildKeySharesFile, combineShares, openKeyShare, recoverBankKey, splitSecret } from './key-shares.js'
import { publisherTick, type PublisherDaemonContext } from './publisher-daemon.js'
import { generateEncryptionKeyPair } from './sealing.js'
import { DirectoryRoundStorage } from './storage.js'
import type { EpochBankV1, RoundTargetV1 } from './types.js'

const MODEL = 'model-a'
const MODEL_HASH = keccak256(toUtf8Bytes(MODEL))
const EPOCH = 7n
const START = Number(EPOCH) * EPOCH_SECONDS
const HOUR = 3600
const DAY = 24 * HOUR

const seller = new Wallet(Wallet.createRandom().privateKey)
const target: RoundTargetV1 = {
  agentId: '1', peerId: seller.address.slice(2).toLowerCase(), service: MODEL,
  serviceHash: MODEL_HASH, model: MODEL, modelHash: MODEL_HASH,
}

function bank(epoch: bigint): EpochBankV1 {
  return { kind: 'antseed-kbf-epoch-bank', version: 1, epoch: epoch.toString(), models: { [MODEL]: referenceFixture(MODEL, 40) } }
}

interface Setup {
  fake: FakeRoundClient
  storage: DirectoryRoundStorage
  publisher: Wallet
  verifiers: Array<{ wallet: Wallet; keys: { publicKey: string; privateKey: string } }>
  dir: string
  logs: string[]
  context: (signer: Wallet, stateName: string, buildBank?: PublisherDaemonContext['buildBank']) => PublisherDaemonContext
}

async function setup(): Promise<Setup> {
  const dir = await mkdtemp(join(tmpdir(), 'antseed-round-escrow-'))
  const fake = new FakeRoundClient()
  const publisher = new Wallet(Wallet.createRandom().privateKey)
  const verifiers = [0, 1, 2].map(() => ({ wallet: new Wallet(Wallet.createRandom().privateKey), keys: generateEncryptionKeyPair() }))
  fake.publisherAddress = publisher.address
  fake.approved = verifiers.map((entry) => entry.wallet.address)
  for (const entry of verifiers) fake.encryptionKeys.set(entry.wallet.address.toLowerCase(), entry.keys.publicKey)
  fake.modelList = [{ modelHash: MODEL_HASH, service: MODEL }]
  const storage = new DirectoryRoundStorage(join(dir, 'files'))
  const logs: string[] = []
  return {
    fake, storage, publisher, verifiers, dir, logs,
    context: (signer, stateName, buildBank = async ({ epoch }) => bank(epoch)) => ({
      client: fake.asClient(),
      signer: signer as never,
      storage,
      stateDir: join(dir, stateName),
      buildBank,
      discoverTargets: async () => [target],
      log: (message) => logs.push(message),
    }),
  }
}

test('Shamir shares rebuild the secret from any threshold subset only', () => {
  const secret = Buffer.from('11'.repeat(16) + 'ee'.repeat(16), 'hex')
  const shares = splitSecret(secret, 3, 5)
  assert.deepEqual(combineShares([shares[0]!, shares[2]!, shares[4]!]), secret)
  assert.deepEqual(combineShares([shares[3]!, shares[1]!, shares[0]!]), secret)
  assert.notDeepEqual(combineShares([shares[0]!, shares[1]!]), secret)
  assert.throws(() => splitSecret(secret, 6, 5))
  assert.throws(() => combineShares([shares[0]!, shares[0]!]))
})

test('escrowed key shares open per verifier and ignore forged shares', () => {
  const recipients = [0, 1, 2].map(() => ({ wallet: new Wallet(Wallet.createRandom().privateKey), keys: generateEncryptionKeyPair() }))
  const bankKey = `0x${'5a'.repeat(32)}`
  const file = buildKeySharesFile({
    epoch: EPOCH, bankKey, threshold: 2,
    recipients: recipients.map((entry) => ({ address: entry.wallet.address, encryptionKey: entry.keys.publicKey })),
  })
  const opened = recipients.map((entry) => openKeyShare(file, entry.wallet.address, entry.keys.privateKey)!)
  assert.equal(openKeyShare(file, new Wallet(Wallet.createRandom().privateKey).address, recipients[0]!.keys.privateKey), null)
  assert.throws(() => openKeyShare(file, recipients[0]!.wallet.address, recipients[1]!.keys.privateKey))

  const forged = `0x01${'00'.repeat(32)}`
  assert.equal(recoverBankKey(file, [{ verifier: recipients[0]!.wallet.address, share: opened[0]! }]), null, 'one share is not enough')
  assert.equal(recoverBankKey(file, [
    { verifier: recipients[0]!.wallet.address, share: forged },
    { verifier: recipients[1]!.wallet.address, share: opened[1]! },
  ]), null, 'a forged share does not count')
  assert.equal(recoverBankKey(file, [
    { verifier: recipients[0]!.wallet.address, share: forged },
    { verifier: recipients[1]!.wallet.address, share: opened[1]! },
    { verifier: recipients[2]!.wallet.address, share: opened[2]! },
  ]), bankKey)
  assert.throws(() => buildKeySharesFile({ epoch: EPOCH, bankKey, threshold: 4, recipients: [] }), /encryption keys/)
})

test('publisher reveals the current key even when next epoch\'s bank keeps failing', async (t) => {
  const s = await setup()
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  let failNext = false
  const context = s.context(s.publisher, 'publisher', async ({ epoch }) => {
    if (failNext && epoch === EPOCH + 1n) throw new Error('no references today')
    return bank(epoch)
  })

  s.fake.time = START + HOUR
  await publisherTick(context)
  assert.deepEqual(s.fake.calls, [`commitBank:${EPOCH}`])
  s.fake.openAndSeed(EPOCH)
  await publisherTick(context)
  assert.deepEqual(s.fake.calls.slice(1), [`commitKeyShares:${EPOCH}`, `commitPlan:${EPOCH}`])

  failNext = true
  s.fake.time = START + 3 * DAY + HOUR
  await publisherTick(context)
  assert.ok(s.fake.calls.includes(`commitBackupPlan:${EPOCH}`), 'backup plan published despite the failing next bank')
  s.fake.time = START + 4 * DAY + HOUR
  await publisherTick(context)
  assert.ok(s.fake.calls.includes(`revealBankKey:${EPOCH}`), 'key revealed despite the failing next bank')
  assert.equal(s.fake.calls.filter((call) => call === `commitBank:${EPOCH + 1n}`).length, 0)
  assert.ok(s.logs.some((line) => line.includes('no references today')))
})

test('verifiers rebuild and reveal the bank key when the publisher disappears', async (t) => {
  const s = await setup()
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  s.fake.time = START + HOUR
  await publisherTick(s.context(s.publisher, 'publisher'))
  s.fake.openAndSeed(EPOCH)
  await publisherTick(s.context(s.publisher, 'publisher'))
  assert.notEqual(s.fake.info(EPOCH).keySharesHash, ZERO_HASH)

  // The publisher is gone from here on.
  const escrow = (index: number) => keyEscrowTick({
    client: s.fake.asClient(), signer: s.verifiers[index]!.wallet as never, address: s.verifiers[index]!.wallet.address,
    encryptionPrivateKey: s.verifiers[index]!.keys.privateKey, storage: s.storage, log: (line) => s.logs.push(line),
  })
  s.fake.time = START + 4 * DAY + 60
  await escrow(0)
  assert.equal(s.fake.shares.length, 0, 'the publisher gets the first minutes to reveal')

  s.fake.time = START + 4 * DAY + HOUR
  await escrow(0)
  assert.equal(s.fake.shares.length, 1)
  assert.equal(s.fake.info(EPOCH).bankKey, ZERO_HASH, 'one share of three is not a majority')
  await escrow(1)
  assert.equal(s.fake.shares.length, 2)
  assert.notEqual(s.fake.info(EPOCH).bankKey, ZERO_HASH, 'two shares rebuild the key')
  await escrow(2)
  assert.equal(s.fake.shares.length, 2, 'nothing to do once the key is out')
})

test('a verifier takes over an epoch the publisher never planned and runs it', async (t) => {
  const s = await setup()
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  s.fake.time = START + HOUR
  await publisherTick(s.context(s.publisher, 'publisher'))
  s.fake.openAndSeed(EPOCH)
  // The publisher committed its bank and then disappeared before the plan.

  const order = s.verifiers
    .map((entry, index) => ({
      index,
      at: takeoverTime({
        epoch: EPOCH, since: START, graceSeconds: s.fake.graceSeconds, turnSeconds: 600,
        verifiers: s.fake.approved, address: entry.wallet.address,
      })!,
    }))
    .sort((a, b) => a.at - b.at)
  assert.deepEqual(order.map((entry) => entry.at), [START + 6 * HOUR, START + 6 * HOUR + 600, START + 6 * HOUR + 1200])

  const fallback = (index: number) => fallbackPublisherTick({
    ...s.context(s.verifiers[index]!.wallet, `verifier-${index}`), address: s.verifiers[index]!.wallet.address,
  })
  s.fake.time = START + 5 * HOUR
  for (const entry of order) await fallback(entry.index)
  assert.ok(!s.fake.calls.some((call) => call.startsWith('takeOverBank')), 'nobody moves within the grace period')

  s.fake.time = START + 6 * HOUR + 1
  for (const entry of order) await fallback(entry.index)
  const first = s.verifiers[order[0]!.index]!.wallet.address
  assert.deepEqual(s.fake.calls.filter((call) => call.startsWith('takeOverBank')), [`takeOverBank:${EPOCH}:${first}`])
  assert.equal(s.fake.info(EPOCH).publisher, first)

  s.fake.openAndSeed(EPOCH, `0x${'cd'.repeat(32)}`)
  await fallback(order[0]!.index)
  assert.ok(s.fake.calls.includes(`commitKeyShares:${EPOCH}`))
  assert.ok(s.fake.calls.includes(`commitPlan:${EPOCH}`), 'the new epoch publisher commits the plan')
  await publisherTick(s.context(s.publisher, 'publisher'))
  assert.equal(s.fake.calls.filter((call) => call === `commitPlan:${EPOCH}`).length, 1, 'the original publisher stays out')
})

test('backup planning waits for unreachable slice files but not for mismatched ones', async (t) => {
  const s = await setup()
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  const context = s.context(s.publisher, 'publisher')
  s.fake.time = START + HOUR
  await publisherTick(context)
  s.fake.openAndSeed(EPOCH)
  await publisherTick(context)
  const collector = s.verifiers[0]!.wallet.address
  const commit = (uri: string, hash: string) => ({ epoch: EPOCH, hash, uri, backup: false, sender: collector, blockNumber: 1, logIndex: 0, txHash: '0x' })
  const stored = await s.storage.put(Buffer.from('{"kind":"antseed-kbf-slices"}'))
  // Bytes that never match their commitment: invalid at once, no reason to wait.
  s.fake.slices = [commit(stored, `0x${'12'.repeat(32)}`)]
  s.fake.time = START + 3 * DAY + HOUR
  await publisherTick(context)
  assert.ok(s.fake.calls.includes(`commitBackupPlan:${EPOCH}`), 'mismatched delivery goes straight to the backup round')

  const u = await setup()
  t.after(() => rm(u.dir, { recursive: true, force: true }))
  const waiting = u.context(u.publisher, 'publisher')
  u.fake.time = START + HOUR
  await publisherTick(waiting)
  u.fake.openAndSeed(EPOCH)
  await publisherTick(waiting)
  // A committed file the store cannot serve right now: retry before planning backups.
  u.fake.slices = [{ epoch: EPOCH, hash: `0x${'34'.repeat(32)}`, uri: `ipfs://local-${'0'.repeat(64)}`, backup: false, sender: u.verifiers[0]!.wallet.address, blockNumber: 1, logIndex: 0, txHash: '0x' }]
  u.fake.time = START + 3 * DAY + HOUR
  await assert.rejects(publisherTick(waiting), /unavailable; retrying/)
  assert.ok(!u.fake.calls.includes(`commitBackupPlan:${EPOCH}`))
  u.fake.time = START + 3 * DAY + 7 * HOUR
  await publisherTick(waiting)
  assert.ok(u.fake.calls.includes(`commitBackupPlan:${EPOCH}`), 'after the wait the unreachable slices go to the backup round')
  assert.ok(u.logs.some((line) => line.includes('still unavailable')))
})

test('a failed key escrow holds the plan back until the escrow is in', async (t) => {
  const s = await setup()
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  const context = s.context(s.publisher, 'publisher')
  s.fake.time = START + HOUR
  await publisherTick(context)
  s.fake.openAndSeed(EPOCH)
  s.fake.failKeyShares = 1
  await publisherTick(context)
  assert.ok(!s.fake.calls.includes(`commitPlan:${EPOCH}`), 'no plan without escrowed shares')
  assert.ok(s.logs.some((line) => line.includes('plan held back')))
  await publisherTick(context)
  assert.deepEqual(s.fake.calls.slice(1), [`commitKeyShares:${EPOCH}`, `commitPlan:${EPOCH}`])
})

test('key shares are posted in time even when the attestation window is shorter than the default delay', async (t) => {
  const s = await setup()
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  s.fake.info(EPOCH).schedule.attestSeconds = 400
  s.fake.time = START + HOUR
  await publisherTick(s.context(s.publisher, 'publisher'))
  s.fake.openAndSeed(EPOCH)
  await publisherTick(s.context(s.publisher, 'publisher'))
  const backupDeadline = START + 4 * DAY
  const escrow = (index: number) => keyEscrowTick({
    client: s.fake.asClient(), signer: s.verifiers[index]!.wallet as never, address: s.verifiers[index]!.wallet.address,
    encryptionPrivateKey: s.verifiers[index]!.keys.privateKey, storage: s.storage, log: (line) => s.logs.push(line),
  })
  assert.equal(keyRevealDelay(400), 100)
  assert.equal(keyRevealDelay(400, 3600), 100, 'an explicit delay is clamped too')
  assert.equal(keyRevealDelay(86_400), 600)
  s.fake.time = backupDeadline + 50
  await escrow(0)
  assert.equal(s.fake.shares.length, 0)
  s.fake.time = backupDeadline + 150
  await escrow(0)
  await escrow(1)
  assert.notEqual(s.fake.info(EPOCH).bankKey, ZERO_HASH, 'the key is rebuilt inside the 400 s window')
})
