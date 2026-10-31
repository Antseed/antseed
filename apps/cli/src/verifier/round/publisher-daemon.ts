import { chmod, mkdir, readFile } from 'node:fs/promises'
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
import { writeJsonAtomic } from '../atomic-files.js'
import { buildKeySharesFile } from './key-shares.js'
import { derivePlan, envelopeFor } from './plan.js'
import { deliveredSlice, type CommittedManifest } from './scoring.js'
import { bankKeyHash, contentHash, sealBank, sealEnvelope } from './sealing.js'
import { RoundFileMismatchError, type RoundStorage } from './storage.js'
import { targetKey, type EpochBankV1, type PlanFileV1, type PlannedSliceV1, type RoundTargetV1, type SealedEnvelopeV1, type SliceManifestV1 } from './types.js'
import { encodeRoundFile } from './verifier-daemon.js'

/**
 * Antseed's reference publisher. It never decides a verdict: it builds and seals each epoch's
 * question bank, publishes the target list and the per-verifier question envelopes once the
 * seed is fixed, hands missing slices to backup verifiers, and reveals the bank key once
 * collection is over.
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
 * plan, backup plan and key reveal. Shared by the publisher and a verifier that took over.
 */
export async function advanceEpochAsPublisher(
  context: PublisherDaemonContext,
  info: KbfEpochInfo,
  deadlines: KbfEpochDeadlines,
  now: number,
): Promise<void> {
  if (info.voided) return
  const epoch = info.epoch
  if (info.seedBlock !== 0n && isZeroHash(info.keySharesHash) && isZeroHash(info.bankKey) && now < deadlines.commitDeadline) {
    try {
      await escrowBankKey(context, info)
    } catch (error) {
      context.log(`epoch ${epoch}: bank key not escrowed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (!isZeroHash(info.seed) && isZeroHash(info.planHash) && now < deadlines.commitDeadline) {
    await publishPlan(context, info)
  }
  if (
    !isZeroHash(info.planHash) && isZeroHash(info.backupPlanHash)
    && now >= deadlines.commitDeadline && now < deadlines.backupDeadline
  ) {
    await publishBackupPlan(context, info, deadlines, now)
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

async function publishPlan(context: PublisherDaemonContext, info: KbfEpochInfo): Promise<void> {
  const bank = await readBank(context, info.epoch)
  const models = await context.client.models(info.modelsVersion)
  const targets = (await context.discoverTargets(models)).filter((target) => bank.models[target.model])
  const members = await context.client.epochVerifiers(info.epoch)
  const plan = derivePlan({
    epoch: info.epoch.toString(), seed: info.seed,
    probesPerService: info.schedule.probesPerService, slicesPerService: info.schedule.slicesPerService,
    verifiers: members, targets, bank,
  })
  const envelopes = await sealEnvelopes(context, members, (member) => envelopeFor(plan, bank, member, { backup: false }))
  const file: PlanFileV1 = { kind: 'antseed-kbf-plan', version: 1, epoch: plan.epoch, seed: plan.seed, backup: false, targets: plan.targets, envelopes }
  const bytes = encodeRoundFile(file)
  const uri = await context.storage.put(bytes, `antseed-kbf-${info.epoch}-plan.json`)
  const hash = await context.client.commitPlan(context.signer, info.epoch, contentHash(bytes), uri)
  context.log(`epoch ${info.epoch}: committed plan for ${plan.targets.length} targets, ${plan.slices.length} slices (${hash})`)
}

/** Share of the backup window the publisher keeps retrying unreachable slice files before counting them as missing. */
export const BACKUP_UNAVAILABLE_WAIT_SHARE = 0.25

async function publishBackupPlan(
  context: PublisherDaemonContext,
  info: KbfEpochInfo,
  deadlines: KbfEpochDeadlines,
  now: number,
): Promise<void> {
  const bank = await readBank(context, info.epoch)
  const planEvent = (await context.client.planCommits(info.epoch)).filter((entry) => !entry.backup && entry.hash === info.planHash).at(-1)
  if (!planEvent) throw new Error(`no plan event for epoch ${info.epoch}`)
  const planFile = JSON.parse((await context.storage.get(planEvent.uri, info.planHash)).toString('utf8')) as PlanFileV1
  const members = await context.client.epochVerifiers(info.epoch)
  const plan = derivePlan({
    epoch: info.epoch.toString(), seed: info.seed,
    probesPerService: info.schedule.probesPerService, slicesPerService: info.schedule.slicesPerService,
    verifiers: members, targets: planFile.targets, bank,
  })
  const manifests: CommittedManifest[] = []
  const unavailable: string[] = []
  for (const commit of await context.client.sliceCommits(info.epoch)) {
    if (commit.backup) continue
    let bytes: Buffer
    try {
      bytes = await context.storage.get(commit.uri, commit.hash)
    } catch (error) {
      // Bytes that are not the committed ones never become valid; a fetch failure may be transient.
      if (!(error instanceof RoundFileMismatchError)) unavailable.push(commit.uri)
      continue
    }
    try {
      manifests.push({ collector: commit.sender.toLowerCase(), backup: false, uri: commit.uri, manifest: JSON.parse(bytes.toString('utf8')) as SliceManifestV1 })
    } catch {
      // not JSON: an invalid delivery, its slices are missing
    }
  }
  if (unavailable.length > 0) {
    const waitUntil = deadlines.commitDeadline + Math.floor(info.schedule.backupSeconds * BACKUP_UNAVAILABLE_WAIT_SHARE)
    if (now < waitUntil) throw new Error(`epoch ${info.epoch}: ${unavailable.length} slice files unavailable; retrying before the backup plan`)
    context.log(`epoch ${info.epoch}: ${unavailable.length} slice files still unavailable; their slices go to the backup round`)
  }
  const targets = new Map(plan.targets.map((target) => [targetKey(target), target]))
  const missing = new Set<PlannedSliceV1>(plan.slices.filter((slice) => !deliveredSlice(slice, manifests, targets.get(slice.targetKey)!, bank)))
  if (missing.size === 0) {
    context.log(`epoch ${info.epoch}: every slice delivered; no backup round needed`)
    return
  }
  const envelopes = await sealEnvelopes(context, members, (member) => envelopeFor(plan, bank, member, { backup: true, sliceFilter: (slice) => missing.has(slice) }))
  const file: PlanFileV1 = { kind: 'antseed-kbf-plan', version: 1, epoch: plan.epoch, seed: plan.seed, backup: true, targets: plan.targets, envelopes }
  const bytes = encodeRoundFile(file)
  const uri = await context.storage.put(bytes, `antseed-kbf-${info.epoch}-backup-plan.json`)
  const hash = await context.client.commitPlan(context.signer, info.epoch, contentHash(bytes), uri, true)
  context.log(`epoch ${info.epoch}: committed backup plan for ${missing.size} missing slices (${hash})`)
}

async function sealEnvelopes(
  context: PublisherDaemonContext,
  members: readonly string[],
  contentFor: (member: string) => ReturnType<typeof envelopeFor>,
): Promise<Record<string, SealedEnvelopeV1>> {
  const envelopes: Record<string, SealedEnvelopeV1> = {}
  for (const member of members) {
    const content = contentFor(member)
    if (content.slices.length === 0) continue
    const key = await context.client.encryptionKey(member)
    if (isZeroHash(key)) {
      context.log(`verifier ${member} has no encryption key; its slices go to backups`)
      continue
    }
    envelopes[member.toLowerCase()] = sealEnvelope(key, encodeRoundFile(content))
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

async function writeSecret(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeJsonAtomic(path, value)
  await chmod(path, 0o600)
}

function epochDir(context: Pick<PublisherDaemonContext, 'stateDir'>, epoch: bigint): string {
  return join(context.stateDir, epoch.toString())
}
