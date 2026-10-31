import { chmod, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AbstractSigner } from 'ethers'
import {
  isZeroHash,
  kbfEpochDeadlines,
  type KbfEpochInfo,
  type KbfModel,
  type KbfRoundClient,
} from '@antseed/node/payments'
import { writeJsonAtomic } from '../atomic-files.js'
import { derivePlan, envelopeFor } from './plan.js'
import { deliveredSlice, type CommittedManifest } from './scoring.js'
import { bankKeyHash, contentHash, sealBank, sealEnvelope } from './sealing.js'
import type { RoundStorage } from './storage.js'
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

  // The current epoch's bank (bootstrap, or a missed build), then next epoch's ahead of time.
  if (isZeroHash(info.bankHash) && now < deadlines.commitDeadline) await prepareBank(context, current)
  else if (now >= deadlines.commitDeadline) {
    const next = await context.client.epochInfo(current + 1n)
    if (isZeroHash(next.bankHash)) await prepareBank(context, current + 1n)
  }
  if (info.voided) return

  if (!isZeroHash(info.seed) && isZeroHash(info.planHash) && now < deadlines.commitDeadline) {
    await publishPlan(context, info)
  }
  if (
    !isZeroHash(info.planHash) && isZeroHash(info.backupPlanHash)
    && now >= deadlines.commitDeadline && now < deadlines.backupDeadline
  ) {
    await publishBackupPlan(context, info)
  }
  if (!isZeroHash(info.planHash) && isZeroHash(info.bankKey) && now >= deadlines.backupDeadline) {
    const state = await readState(context, current)
    if (!state) throw new Error(`no bank key on disk for epoch ${current}; it cannot be revealed`)
    const hash = await context.client.revealBankKey(context.signer, current, state.bankKey)
    context.log(`epoch ${current}: revealed bank key (${hash})`)
  }
}

async function prepareBank(context: PublisherDaemonContext, epoch: bigint): Promise<void> {
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
    const hash = await context.client.commitBank(context.signer, epoch, state.bankHash, bankKeyHash(state.bankKey), state.bankUri)
    state.committed = true
    await writeSecret(join(epochDir(context, epoch), 'publisher.json'), state)
    context.log(`epoch ${epoch}: committed bank ${state.bankUri} (${hash})`)
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

async function publishBackupPlan(context: PublisherDaemonContext, info: KbfEpochInfo): Promise<void> {
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
  for (const commit of await context.client.sliceCommits(info.epoch)) {
    if (commit.backup) continue
    try {
      const manifest = JSON.parse((await context.storage.get(commit.uri, commit.hash)).toString('utf8')) as SliceManifestV1
      manifests.push({ collector: commit.sender.toLowerCase(), backup: false, uri: commit.uri, manifest })
    } catch {
      // an unavailable delivery counts as missing
    }
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
