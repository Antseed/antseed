import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { Wallet, keccak256, toUtf8Bytes } from 'ethers'
import { ZERO_HASH } from '@antseed/node/payments'
import { referenceFixture } from '../model-audit-fixtures.test-support.js'
import { EPOCH_SECONDS, FakeRoundClient } from './fake-round-client.test-support.js'
import { fallbackPublisherTick, takeoverTime } from './fallback-publisher.js'
import { keyEscrowTick, keyRevealDelay } from './key-escrow.js'
import { acceptPlan } from './plan-acceptance.js'
import {
  buildKeySharesFile, checkKeySharesFile, combineShares, openKeyShare, recoverBankKey, shareMatchesCommitments, splitSecret,
  type KeySharesFileV2,
} from './key-shares.js'
import { publisherTick, type PublisherDaemonContext } from './publisher-daemon.js'
import { bankKeyHash, generateEncryptionKeyPair, isUsableEncryptionKey, openEnvelope, sealEnvelope } from './sealing.js'
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
  /** Every epoch verifier but the publisher checks and accepts the proposed round, as `verifier start` would. */
  accept: (epoch?: bigint) => Promise<void>
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
  const accept = async (epoch = EPOCH) => {
    for (const entry of verifiers) {
      const info = await fake.epochInfo(epoch)
      if (entry.wallet.address === info.publisher || info.planActive) continue
      await acceptPlan({
        client: fake.asClient(), signer: entry.wallet as never, address: entry.wallet.address,
        encryptionPrivateKey: entry.keys.privateKey, storage, log: (message: string) => logs.push(message),
      }, info)
    }
  }
  return {
    fake, storage, publisher, verifiers, dir, logs, accept,
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

test('Shamir shares rebuild the secret from any threshold subset only, and match their commitments', () => {
  const secret = BigInt(`0x${'11'.repeat(16)}${'ee'.repeat(16)}`)
  const { shares, commitments } = splitSecret(secret, 3, 5)
  assert.equal(combineShares([shares[0]!, shares[2]!, shares[4]!]), secret)
  assert.equal(combineShares([shares[3]!, shares[1]!, shares[0]!]), secret)
  assert.notEqual(combineShares([shares[0]!, shares[1]!]), secret)
  assert.equal(commitments.length, 3)
  assert.ok(shares.every((share) => shareMatchesCommitments(commitments, share)))
  assert.equal(shareMatchesCommitments(commitments, { x: 1, y: shares[0]!.y + 1n }), false, 'a share off the polynomial')
  assert.equal(shareMatchesCommitments(commitments, { x: 2, y: shares[0]!.y }), false, 'a share at the wrong x')
  assert.throws(() => splitSecret(secret, 6, 5))
  assert.throws(() => splitSecret(0n, 1, 1))
  assert.throws(() => combineShares([shares[0]!, shares[0]!]))
})

test('a key-share file must match the epoch: its bank key, threshold and verifiers', () => {
  const recipients = [0, 1, 2].map(() => ({ address: Wallet.createRandom().address, encryptionKey: generateEncryptionKeyPair().publicKey }))
  const bankKey = `0x${'5a'.repeat(32)}`
  const members = recipients.map((entry) => entry.address)
  const expected = { epoch: EPOCH, bankKeyHash: bankKeyHash(bankKey), threshold: 2, members }
  const file = buildKeySharesFile({ epoch: EPOCH, bankKey, threshold: 2, recipients })
  assert.equal(checkKeySharesFile(JSON.parse(JSON.stringify(file)), expected).version, 2)
  assert.throws(() => checkKeySharesFile(file, { ...expected, bankKeyHash: bankKeyHash(`0x${'5b'.repeat(32)}`) }), /does not commit to the epoch's bank key/)
  assert.throws(() => checkKeySharesFile({ ...file, bankKeyHash: bankKeyHash(`0x${'5b'.repeat(32)}`) }, expected), /does not commit to the epoch's bank key/)
  assert.throws(() => checkKeySharesFile(file, { ...expected, epoch: EPOCH + 1n }), /malformed/)
  assert.throws(() => checkKeySharesFile({ ...file, commitments: ['0x02', file.commitments[1]] }, expected), /malformed/)
  assert.throws(() => checkKeySharesFile({ ...file, version: 1 }, expected), /malformed/)
  // Every share valid, but a majority of them cannot rebuild the key: all three are needed.
  const allNeeded = buildKeySharesFile({ epoch: EPOCH, bankKey, threshold: 3, recipients })
  assert.throws(() => checkKeySharesFile(allNeeded, expected), /needs 3 shares; the epoch's threshold is 2/)
  const [first, second] = Object.keys(file.indexes)
  assert.throws(() => checkKeySharesFile({ ...file, indexes: { ...file.indexes, [second!]: file.indexes[first!]! } }, expected), /distinct/)
  assert.throws(() => checkKeySharesFile(file, { ...expected, members: members.slice(1) }), /not an epoch verifier/)
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
  // Someone else's valid share does not count under another verifier's name.
  assert.equal(recoverBankKey(file, [
    { verifier: recipients[0]!.wallet.address, share: opened[1]! },
    { verifier: recipients[1]!.wallet.address, share: opened[1]! },
  ]), null)

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
  assert.equal(s.fake.info(EPOCH).planActive, false, 'proposed until the verifiers accept it')
  await s.accept()
  assert.equal(s.fake.info(EPOCH).planActive, true)
  assert.equal(s.fake.calls.filter((call) => call.startsWith('acceptPlan')).length, 2, 'the threshold of two acceptances')

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
  await s.accept()
  assert.equal(s.fake.info(EPOCH).planActive, true)

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
  await s.accept()
  assert.ok(s.fake.calls.includes(`commitKeyShares:${EPOCH}`), 'escrowed with the two usable keys')
  assert.equal(await s.fake.hasAcceptedPlan(EPOCH, broken), false, 'the broken verifier has no share to accept with')
  assert.equal(s.fake.info(EPOCH).planActive, true, 'the plan is not held back')
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
  assert.ok(s.fake.calls.includes(`commitPlan:${EPOCH}`), 'the new epoch publisher proposes the plan')
  await s.accept()
  assert.ok(!s.fake.calls.includes(`acceptPlan:${EPOCH}:${first}`), 'the epoch publisher never accepts its own plan')
  assert.equal(s.fake.info(EPOCH).planActive, true)
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
  await s.accept()
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
  await s.accept()
  assert.equal(s.fake.info(EPOCH).planActive, true, 'an empty plan is acceptable')
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

test('verifiers do not accept a round whose escrow cannot rebuild the committed key', async (t) => {
  const s = await setup()
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  const context = s.context(s.publisher, 'publisher')
  s.fake.time = START + HOUR
  await publisherTick(context)
  s.fake.openAndSeed(EPOCH)
  const members = s.verifiers.map((entry) => ({ address: entry.wallet.address, encryptionKey: entry.keys.publicKey }))
  const stateFile = JSON.parse(await readFile(join(s.dir, 'publisher', EPOCH.toString(), 'publisher.json'), 'utf8')) as { bankKey: string }
  const escrowWith = async (file: KeySharesFileV2) => {
    const bytes = Buffer.from(JSON.stringify(file))
    await s.fake.commitKeyShares(s.publisher as never, EPOCH, keccak256(bytes), await s.storage.put(bytes))
  }
  // Shares of some other key: valid on their own polynomial, whose constant term is not the bank key.
  await escrowWith(buildKeySharesFile({ epoch: EPOCH, bankKey: `0x${'42'.repeat(32)}`, threshold: 2, recipients: members }))
  await publisherTick(context)
  assert.notEqual(s.fake.info(EPOCH).planHash, ZERO_HASH, 'the plan is proposed')
  await s.accept()
  assert.equal(await s.fake.planAcceptances(EPOCH), 0)
  assert.equal(s.fake.info(EPOCH).planActive, false)
  assert.ok(s.logs.some((line) => line.includes("does not commit to the epoch's bank key")))

  // The right key, but all three shares needed: an honest majority alone could not rebuild it.
  await escrowWith(buildKeySharesFile({ epoch: EPOCH, bankKey: stateFile.bankKey, threshold: 3, recipients: members }))
  await s.accept()
  assert.equal(s.fake.info(EPOCH).planActive, false)
  assert.ok(s.logs.some((line) => line.includes("needs 3 shares; the epoch's threshold is 2")))

  // The right key and threshold, but one verifier's share is another's: that verifier refuses.
  // The two others hold valid shares, a threshold's worth, so their acceptances put the plan in effect.
  const honest = buildKeySharesFile({ epoch: EPOCH, bankKey: stateFile.bankKey, threshold: 2, recipients: members })
  const victim = s.verifiers[0]!
  await escrowWith({
    ...honest,
    shares: { ...honest.shares, [victim.wallet.address.toLowerCase()]: honest.shares[s.verifiers[1]!.wallet.address.toLowerCase()]! },
  })
  await s.accept()
  assert.equal(await s.fake.hasAcceptedPlan(EPOCH, victim.wallet.address), false)
  assert.ok(s.logs.some((line) => line.includes("does not match the file's commitments")))
  assert.equal(s.fake.info(EPOCH).planActive, true)
})

test('verifiers do not accept a plan they cannot fetch, a plan missing their envelope, or an unfetchable bank', async (t) => {
  const s = await setup()
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  const context = s.context(s.publisher, 'publisher')
  s.fake.time = START + HOUR
  await publisherTick(context)
  s.fake.openAndSeed(EPOCH)
  await publisherTick(context)
  const proposed = s.fake.plans.at(-1)!
  const plan = JSON.parse((await s.storage.get(proposed.uri, proposed.hash)).toString('utf8')) as PlanFileV1

  // A plan hash whose file is nowhere to be found.
  await s.fake.commitPlan(s.publisher as never, EPOCH, keccak256(Buffer.from('missing')), 'ipfs://missing')
  await s.accept()
  assert.equal(await s.fake.planAcceptances(EPOCH), 0)

  // A plan that leaves out every envelope: the verifiers the seed gives a first slice to (its
  // owner and its backup) refuse it, and one acceptance is not enough.
  const starved = Buffer.from(JSON.stringify({ ...plan, envelopes: {}, backupEnvelopes: {} }))
  await s.fake.commitPlan(s.publisher as never, EPOCH, keccak256(starved), await s.storage.put(starved))
  await s.accept()
  assert.equal(await s.fake.planAcceptances(EPOCH), 1)
  assert.equal(s.fake.info(EPOCH).planActive, false)
  assert.ok(s.logs.some((line) => line.includes('which the seed gives this verifier')))

  // Envelopes that are there, correctly sealed and well formed, but hold no slices at all.
  const emptyEnvelopes = (backup: boolean) => Object.fromEntries(s.verifiers.map((entry) => [
    entry.wallet.address.toLowerCase(),
    sealEnvelope(entry.keys.publicKey, Buffer.from(JSON.stringify({
      kind: 'antseed-kbf-envelope', version: 1, epoch: EPOCH.toString(), collector: entry.wallet.address.toLowerCase(), backup, slices: [],
    }))),
  ]))
  const hollow = Buffer.from(JSON.stringify({ ...plan, envelopes: emptyEnvelopes(false), backupEnvelopes: emptyEnvelopes(true) }))
  await s.fake.commitPlan(s.publisher as never, EPOCH, keccak256(hollow), await s.storage.put(hollow))
  await s.accept()
  assert.equal(await s.fake.planAcceptances(EPOCH), 1, 'the owner and the backup of the first slice refuse it')
  assert.equal(s.fake.info(EPOCH).planActive, false)

  // The proposed plan again, but its bank file is gone.
  const bankUri = s.fake.banks.at(-1)!.bankUri
  const bankPath = join(s.dir, 'files', bankUri.replace(/^.*\//, ''))
  const sealed = await readFile(bankPath)
  await rm(bankPath)
  await s.fake.commitPlan(s.publisher as never, EPOCH, proposed.hash, proposed.uri)
  await s.accept()
  assert.equal(await s.fake.planAcceptances(EPOCH), 0, 'nobody accepts a round whose bank they could not keep')
  await writeFile(bankPath, sealed)
  await s.accept()
  assert.equal(s.fake.info(EPOCH).planActive, true)
  // Accepted: final, and no longer open to a takeover.
  s.fake.time = START + 7 * HOUR
  await fallbackPublisherTick({ ...s.context(s.verifiers[0]!.wallet, 'verifier-0'), address: s.verifiers[0]!.wallet.address })
  assert.ok(!s.fake.calls.some((call) => call.startsWith('takeOverBank')))
})

test('a verifier whose takeover was replaced takes the epoch over again after restarting', async (t) => {
  const s = await setup()
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  const [a, b] = s.verifiers
  const fallback = (entry: typeof a, name: string) => fallbackPublisherTick({
    ...s.context(entry!.wallet, name), address: entry!.wallet.address, turnSeconds: 0,
  })
  // Verifier A takes the epoch over, then goes offline before its plan.
  s.fake.time = START + 6 * HOUR + 1
  await fallback(a, 'verifier-a')
  assert.equal(s.fake.info(EPOCH).publisher, a!.wallet.address)
  const aBank = s.fake.info(EPOCH).bankHash

  // B replaces A's bank a grace period later, and disappears too.
  s.fake.time += s.fake.graceSeconds
  await fallback(b, 'verifier-b')
  assert.equal(s.fake.info(EPOCH).publisher, b!.wallet.address)

  // A comes back (same state directory) once B's grace has passed: its old bank goes in again.
  s.fake.time += s.fake.graceSeconds
  await fallback(a, 'verifier-a')
  assert.equal(s.fake.info(EPOCH).publisher, a!.wallet.address)
  assert.equal(s.fake.info(EPOCH).bankHash, aBank)
  assert.equal(s.fake.calls.filter((call) => call === `takeOverBank:${EPOCH}:${a!.wallet.address}`).length, 2)
})

test('an acceptance checked against one bank never counts for the bank a takeover put in its place', async (t) => {
  const s = await setup()
  t.after(() => rm(s.dir, { recursive: true, force: true }))
  s.fake.time = START + HOUR
  await publisherTick(s.context(s.publisher, 'publisher'))
  s.fake.openAndSeed(EPOCH)
  await publisherTick(s.context(s.publisher, 'publisher'))
  // B checks the round now, but its transaction only lands after A took the epoch over and
  // re-committed the very same shares and plan hashes for its own bank.
  const checked = await s.fake.epochInfo(EPOCH)
  const [a, b] = s.verifiers
  s.fake.time = START + 6 * HOUR + 1
  await s.fake.takeOverBank(a!.wallet as never, EPOCH, `0x${'a1'.repeat(32)}`, checked.bankKeyHash)
  s.fake.openAndSeed(EPOCH)
  await s.fake.commitKeyShares(a!.wallet as never, EPOCH, checked.keySharesHash, s.fake.shareFiles.at(-1)!.uri)
  await s.fake.commitPlan(a!.wallet as never, EPOCH, checked.planHash, s.fake.plans.at(-1)!.uri)
  await assert.rejects(acceptPlan({
    client: s.fake.asClient(), signer: b!.wallet as never, address: b!.wallet.address,
    encryptionPrivateKey: b!.keys.privateKey, storage: s.storage, log: () => {},
  }, checked), /InvalidValue/)
  assert.equal(await s.fake.planAcceptances(EPOCH), 0)
})
