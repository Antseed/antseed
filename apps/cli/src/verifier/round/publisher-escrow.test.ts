import assert from 'node:assert/strict'
import { mkdtemp, rm, stat } from 'node:fs/promises'
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
import { generateEncryptionKeyPair, isUsableEncryptionKey, openEnvelope } from './sealing.js'
import { DirectoryRoundStorage } from './storage.js'
import type { EnvelopeContentV1, EpochBankV1, PlanFileV1, RoundTargetV1 } from './types.js'

const MODEL = 'model-a'
const MODEL_HASH = keccak256(toUtf8Bytes(MODEL))
const EPOCH = 7n
const START = Number(EPOCH) * EPOCH_SECONDS
const HOUR = 3600
const DAY = 24 * HOUR
/** u = 1, a low-order X25519 point: nonzero, yet no key agreement with it succeeds. */
const LOW_ORDER_KEY = `0x01${'00'.repeat(31)}`

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

test('only keys that can receive envelopes count as usable', () => {
  assert.equal(isUsableEncryptionKey(generateEncryptionKeyPair().publicKey), true)
  for (const bad of [LOW_ORDER_KEY, `0x${'00'.repeat(32)}`, `0xecffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff7f`, '0x1234', 'nothex']) {
    assert.equal(isUsableEncryptionKey(bad), false, bad)
  }
  // Escrow skips an unusable key instead of failing on it.
  const good = [0, 1].map(() => ({ address: Wallet.createRandom().address, encryptionKey: generateEncryptionKeyPair().publicKey }))
  const file = buildKeySharesFile({
    epoch: EPOCH, bankKey: `0x${'5a'.repeat(32)}`, threshold: 2,
    recipients: [...good, { address: Wallet.createRandom().address, encryptionKey: LOW_ORDER_KEY }],
  })
  assert.equal(Object.keys(file.shares).length, 2)
  assert.throws(() => buildKeySharesFile({
    epoch: EPOCH, bankKey: `0x${'5a'.repeat(32)}`, threshold: 3,
    recipients: [...good, { address: Wallet.createRandom().address, encryptionKey: LOW_ORDER_KEY }],
  }), /only 2 verifiers have usable encryption keys; 3 needed/)
})

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
  const before = s.fake.calls.length
  await publisherTick(context)
  assert.equal(s.fake.calls.length, before, 'nothing to publish during the backup round: backups work from the plan')
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

test('a verifier with an unusable encryption key does not stall escrow or the plan', async (t) => {
  const s = await setup()
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  // A nonzero low-order X25519 point: the contract accepts it, but nothing can be sealed to it.
  const broken = s.verifiers[2]!.wallet.address
  s.fake.encryptionKeys.set(broken.toLowerCase(), LOW_ORDER_KEY)
  const context = s.context(s.publisher, 'publisher')
  s.fake.time = START + HOUR
  await publisherTick(context)
  s.fake.openAndSeed(EPOCH)
  await publisherTick(context)
  assert.ok(s.fake.calls.includes(`commitKeyShares:${EPOCH}`), 'escrowed with the two usable keys')
  assert.ok(s.fake.calls.includes(`commitPlan:${EPOCH}`), 'the plan is not held back')
  assert.ok(s.logs.some((line) => line.includes(`${broken} has an unusable encryption key`)))

  const event = s.fake.plans.at(-1)!
  const plan = JSON.parse((await s.storage.get(event.uri, event.hash)).toString('utf8')) as PlanFileV1
  assert.equal(plan.envelopes[broken.toLowerCase()], undefined, 'its slices are left to backups')
  assert.equal(plan.backupEnvelopes[broken.toLowerCase()], undefined)

  // The two usable verifiers still meet the threshold of 2 and rebuild the key.
  const escrow = (index: number) => keyEscrowTick({
    client: s.fake.asClient(), signer: s.verifiers[index]!.wallet as never, address: s.verifiers[index]!.wallet.address,
    encryptionPrivateKey: s.verifiers[index]!.keys.privateKey, storage: s.storage, log: (line) => s.logs.push(line),
  })
  s.fake.time = START + 4 * DAY + HOUR
  await escrow(0)
  await escrow(1)
  assert.notEqual(s.fake.info(EPOCH).bankKey, ZERO_HASH)
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

test('with no eligible targets the publisher keeps looking, then commits an empty plan', async (t) => {
  const s = await setup()
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  const context = { ...s.context(s.publisher, 'publisher'), discoverTargets: async () => [] }
  s.fake.time = START + HOUR
  await publisherTick(context)
  s.fake.openAndSeed(EPOCH)
  await publisherTick(context)
  assert.equal(s.fake.info(EPOCH).planHash, ZERO_HASH, 'still waiting for the buyer to find sellers')
  assert.ok(s.logs.some((line) => line.includes('no eligible targets yet')))

  // Half the grace period in: before anyone may take over, the empty plan goes out.
  s.fake.time = START + s.fake.graceSeconds / 2 + 60
  await publisherTick(context)
  assert.notEqual(s.fake.info(EPOCH).planHash, ZERO_HASH)
  assert.ok(s.logs.some((line) => line.includes('committing an empty plan')))
})

test('the plan seals every verifier its own and its backed-up slices', async (t) => {
  const s = await setup()
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  const context = s.context(s.publisher, 'publisher')
  s.fake.time = START + HOUR
  await publisherTick(context)
  s.fake.openAndSeed(EPOCH)
  await publisherTick(context)
  const event = s.fake.plans.at(-1)!
  const plan = JSON.parse((await s.storage.get(event.uri, event.hash)).toString('utf8')) as PlanFileV1
  assert.ok(Object.keys(plan.envelopes).length > 0)
  assert.ok(Object.keys(plan.backupEnvelopes).length > 0, 'backups are sealed with the plan')
  for (const verifier of s.verifiers) {
    const sealed = plan.backupEnvelopes[verifier.wallet.address.toLowerCase()]
    if (!sealed) continue
    const content = JSON.parse(openEnvelope(verifier.keys.privateKey, sealed).toString('utf8')) as EnvelopeContentV1
    assert.equal(content.backup, true)
    assert.equal(content.collector, verifier.wallet.address.toLowerCase())
  }
})

test('the bank and its key are written owner-only, even under a permissive umask', async (t) => {
  const s = await setup()
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  const previous = process.umask(0)
  t.after(() => { process.umask(previous) })
  s.fake.time = START + HOUR
  await publisherTick(s.context(s.publisher, 'publisher'))
  const epochDir = join(s.dir, 'publisher', EPOCH.toString())
  assert.equal((await stat(epochDir)).mode & 0o777, 0o700)
  for (const name of ['bank.json', 'publisher.json']) {
    assert.equal((await stat(join(epochDir, name))).mode & 0o777, 0o600, name)
  }
})
