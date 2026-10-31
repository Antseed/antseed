import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AbstractSigner } from 'ethers'
import {
  isZeroHash,
  kbfEpochDeadlines,
  type KbfEpochDeadlines,
  type KbfEpochInfo,
  type KbfModel,
  type KbfRoundClient,
} from '@antseed/node/payments'
import { ensurePrivateDirectory, writeSecretJsonAtomic } from '../atomic-files.js'
import { buildKeySharesFile } from './key-shares.js'
import { derivePlan, envelopeFor } from './plan.js'
import { bankKeyHash, contentHash, sealBank, sealEnvelope } from './sealing.js'
import type { RoundStorage } from './storage.js'
import type { EpochBankV1, PlanFileV1, RoundTargetV1, SealedEnvelopeV1 } from './types.js'
import { encodeRoundFile } from './verifier-daemon.js'

/**
 * Antseed's reference publisher. It never decides a verdict: it builds and seals each epoch's
 * question bank, publishes the target list and the per-verifier question envelopes (own and
 * backup slices) once the seed is fixed, and reveals the bank key once collection is over.
 */
export interface PublisherDaemonContext {
  client: KbfRoundClient
  signer: AbstractSigner
  storage: RoundStorage
  /** Keeps each epoch's bank key and plaintext bank: `<stateDir>/<epoch>/`. Back it up. */
  stateDir: string
  /** Builds a fresh reference per audited model, avoiding `excludedProbeIds`. */
  buildBank: (input: { epoch: bigint; models: KbfModel[]; excludedProbeIds: ReadonlySet<string> }) => Promise<EpochBankV1>
  /** Sellers to audit this epoch: staked, reachable, advertising an audited model within the price cap. */
  discoverTargets: (models: KbfModel[]) => Promise<RoundTargetV1[]>
  log: (message: string) => void
}

interface PublisherEpochStateV1 {
  bankKey: string
  bankUri: string
  bankHash: string
  committed: boolean
}

export async function publisherTick(context: PublisherDaemonContext): Promise<void> {
  const current = await context.client.currentEpoch()
  const info = await context.client.epochInfo(current)
  const deadlines = kbfEpochDeadlines(info, await context.client.epochDuration())
  const now = await context.client.now()
  const me = await context.signer.getAddress()

  // The current round first: its deadlines are close, and next epoch's bank must never hold it up.
  if (isZeroHash(info.bankHash) && info.takenOverAt === 0 && now < deadlines.commitDeadline) {
    await prepareBank(context, current, 'publisher')
  } else if (sameAddress(info.publisher, me)) {
    await advanceEpochAsPublisher(context, info, deadlines, now)
  }
  if (now >= deadlines.commitDeadline) {
    try {
      const next = await context.client.epochInfo(current + 1n)
      if (isZeroHash(next.bankHash)) await prepareBank(context, current + 1n, 'publisher')
    } catch (error) {
      context.log(`epoch ${current + 1n}: bank not ready yet: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

/**
 * Moves an epoch whose bank the signer committed through the rest of the round: key escrow,
 * plan and key reveal. Shared by the publisher and a verifier that took over. Nothing is needed
 * from it between the plan and the reveal: backup collectors work from the plan alone.
 */
export async function advanceEpochAsPublisher(
  context: PublisherDaemonContext,
  info: KbfEpochInfo,
  deadlines: KbfEpochDeadlines,
  now: number,
): Promise<void> {
  if (info.voided) return
  const epoch = info.epoch
  if (
    info.seedBlock !== 0n && isZeroHash(info.keySharesHash) && isZeroHash(info.planHash)
    && isZeroHash(info.bankKey) && now < deadlines.commitDeadline
  ) {
    // The contract takes the plan only after the escrow, so verifiers can always rebuild the key.
    try {
      await escrowBankKey(context, info)
    } catch (error) {
      context.log(`epoch ${epoch}: bank key not escrowed, plan held back: ${error instanceof Error ? error.message : String(error)}`)
      return
    }
  }
  if (!isZeroHash(info.seed) && isZeroHash(info.planHash) && now < deadlines.commitDeadline) {
    await publishPlan(context, info, now)
  }
  if (!isZeroHash(info.planHash) && isZeroHash(info.bankKey) && now >= deadlines.backupDeadline) {
    const state = await readState(context, epoch)
    if (!state || state.bankHash !== info.bankHash) throw new Error(`no bank key on disk for epoch ${epoch}; it cannot be revealed`)
    const hash = await context.client.revealBankKey(context.signer, epoch, state.bankKey)
    context.log(`epoch ${epoch}: revealed bank key (${hash})`)
  }
}

/** Seals one Shamir share of the bank key to each epoch verifier, so a majority can reveal it. */
async function escrowBankKey(context: PublisherDaemonContext, info: KbfEpochInfo): Promise<void> {
  const state = await readState(context, info.epoch)
  if (!state || state.bankHash !== info.bankHash) throw new Error('no bank key on disk')
  const members = await context.client.epochVerifiers(info.epoch)
  const recipients: Array<{ address: string; encryptionKey: string }> = []
  for (const member of members) {
    const encryptionKey = await context.client.encryptionKey(member)
    if (!isZeroHash(encryptionKey)) recipients.push({ address: member, encryptionKey })
  }
  const file = buildKeySharesFile({
    epoch: info.epoch, bankKey: state.bankKey, threshold: await context.client.threshold(info.epoch), recipients,
  })
  const bytes = encodeRoundFile(file)
  const uri = await context.storage.put(bytes, `antseed-kbf-${info.epoch}-key-shares.json`)
  const hash = await context.client.commitKeyShares(context.signer, info.epoch, contentHash(bytes), uri)
  context.log(`epoch ${info.epoch}: escrowed the bank key with ${recipients.length} verifiers, ${file.threshold} needed (${hash})`)
}

/**
 * Builds, seals and commits an epoch's bank once; the key and plaintext stay on disk. `takeover`
 * commits it through `takeOverBank`, for a verifier standing in for a missing publisher.
 */
export async function prepareBank(context: PublisherDaemonContext, epoch: bigint, mode: 'publisher' | 'takeover'): Promise<void> {
  let state = await readState(context, epoch)
  if (!state) {
    const version = await context.client.modelsVersion()
    if (version === 0) return
    const models = await context.client.models(version)
    context.log(`epoch ${epoch}: building a fresh bank for ${models.length} models`)
    const bank = await context.buildBank({ epoch, models, excludedProbeIds: await previousProbeIds(context, epoch) })
    const sealed = sealBank(encodeRoundFile(bank))
    const bankUri = await context.storage.put(sealed.blob, `antseed-kbf-${epoch}-bank.bin`)
    state = { bankKey: sealed.key, bankUri, bankHash: contentHash(sealed.blob), committed: false }
    // The key and the plaintext are written before the commit, so a crash never loses a committed key.
    await writeSecret(join(epochDir(context, epoch), 'bank.json'), bank)
    await writeSecret(join(epochDir(context, epoch), 'publisher.json'), state)
  }
  if (!state.committed) {
    const commit = mode === 'takeover' ? context.client.takeOverBank.bind(context.client) : context.client.commitBank.bind(context.client)
    const hash = await commit(context.signer, epoch, state.bankHash, bankKeyHash(state.bankKey), state.bankUri)
    state.committed = true
    await writeSecret(join(epochDir(context, epoch), 'publisher.json'), state)
    context.log(`epoch ${epoch}: ${mode === 'takeover' ? 'took the epoch over with' : 'committed'} bank ${state.bankUri} (${hash})`)
  }
}

async function publishPlan(context: PublisherDaemonContext, info: KbfEpochInfo, now: number): Promise<void> {
  const bank = await readBank(context, info.epoch)
  const models = await context.client.models(info.modelsVersion)
  const targets = (await context.discoverTargets(models)).filter((target) => bank.models[target.model])
  if (targets.length === 0) {
    // Often only a buyer that has not discovered its peers yet. Keep looking for a while (well
    // before anyone may take the epoch over), then commit an empty plan: its round has an agreed
    // empty results root, so the epoch still finalizes instead of stalling.
    const since = info.takenOverAt || info.startedAt
    const holdUntil = since + Math.floor(Math.min(await context.client.publisherGraceSeconds(), info.schedule.collectSeconds) / 2)
    if (now < holdUntil) {
      context.log(`epoch ${info.epoch}: no eligible targets yet; retrying discovery until ${new Date(holdUntil * 1_000).toISOString()}`)
      return
    }
    context.log(`epoch ${info.epoch}: no eligible targets; committing an empty plan`)
  }
  const members = await context.client.epochVerifiers(info.epoch)
  const plan = derivePlan({
    epoch: info.epoch.toString(), seed: info.seed,
    probesPerService: info.schedule.probesPerService, slicesPerService: info.schedule.slicesPerService,
    verifiers: members, targets, bank,
  })
  const encryptionKeys = await memberEncryptionKeys(context, members)
  const envelopes = sealEnvelopes(encryptionKeys, (member) => envelopeFor(plan, bank, member, { backup: false }))
  const backupEnvelopes = sealEnvelopes(encryptionKeys, (member) => envelopeFor(plan, bank, member, { backup: true }))
  const file: PlanFileV1 = {
    kind: 'antseed-kbf-plan', version: 1, epoch: plan.epoch, seed: plan.seed, targets: plan.targets, envelopes, backupEnvelopes,
  }
  const bytes = encodeRoundFile(file)
  const uri = await context.storage.put(bytes, `antseed-kbf-${info.epoch}-plan.json`)
  const hash = await context.client.commitPlan(context.signer, info.epoch, contentHash(bytes), uri)
  context.log(`epoch ${info.epoch}: committed plan for ${plan.targets.length} targets, ${plan.slices.length} slices (${hash})`)
}

/** Each member's envelope key; members without one get no envelopes, so their slices fall to backups. */
async function memberEncryptionKeys(context: PublisherDaemonContext, members: readonly string[]): Promise<Map<string, string>> {
  const keys = new Map<string, string>()
  for (const member of members) {
    const key = await context.client.encryptionKey(member)
    if (isZeroHash(key)) context.log(`verifier ${member} has no encryption key; its slices go to backups`)
    else keys.set(member.toLowerCase(), key)
  }
  return keys
}

function sealEnvelopes(
  encryptionKeys: ReadonlyMap<string, string>,
  contentFor: (member: string) => ReturnType<typeof envelopeFor>,
): Record<string, SealedEnvelopeV1> {
  const envelopes: Record<string, SealedEnvelopeV1> = {}
  for (const [member, key] of encryptionKeys) {
    const content = contentFor(member)
    if (content.slices.length > 0) envelopes[member] = sealEnvelope(key, encodeRoundFile(content))
  }
  return envelopes
}

async function previousProbeIds(context: PublisherDaemonContext, epoch: bigint): Promise<Set<string>> {
  const ids = new Set<string>()
  for (let back = 1n; back <= 8n && back <= epoch; back++) {
    try {
      const bank = await readBank(context, epoch - back)
      for (const reference of Object.values(bank.models)) for (const probe of reference.probes) ids.add(probe.id)
    } catch {
      // no bank that epoch
    }
  }
  return ids
}

async function readBank(context: PublisherDaemonContext, epoch: bigint): Promise<EpochBankV1> {
  return JSON.parse(await readFile(join(epochDir(context, epoch), 'bank.json'), 'utf8')) as EpochBankV1
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

async function readState(context: PublisherDaemonContext, epoch: bigint): Promise<PublisherEpochStateV1 | null> {
  try {
    return JSON.parse(await readFile(join(epochDir(context, epoch), 'publisher.json'), 'utf8')) as PublisherEpochStateV1
  } catch {
    return null
  }
}

/** Bank plaintext and keys: written owner-only from the first byte, in an owner-only directory. */
async function writeSecret(path: string, value: unknown): Promise<void> {
  await ensurePrivateDirectory(join(path, '..'))
  await writeSecretJsonAtomic(path, value)
}

function epochDir(context: Pick<PublisherDaemonContext, 'stateDir'>, epoch: bigint): string {
  return join(context.stateDir, epoch.toString())
}
