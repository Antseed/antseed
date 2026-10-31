import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getAddress, keccak256, toUtf8Bytes, type AbstractSigner } from 'ethers'
import { canonicalJsonStringify } from '@antseed/fingerprints'
import {
  isZeroHash,
  kbfEpochDeadlines,
  type KbfEpochInfo,
  type KbfRoundClient,
  type KbfServiceResult,
} from '@antseed/node/payments'
import { writeJsonAtomic } from '../atomic-files.js'
import { collectSlice, type CollectorContext } from './collector.js'
import { ResultsTree, collectorLeaf, serviceLeaf, verdictCode } from './merkle.js'
import { derivePlan } from './plan.js'
import { scoreRound, type CommittedManifest } from './scoring.js'
import { contentHash, openBank, openEnvelope } from './sealing.js'
import { seededRanking } from './seeded.js'
import type { RoundStorage } from './storage.js'
import type {
  EnvelopeContentV1,
  EpochBankV1,
  PlanFileV1,
  RoundResultsV1,
  RoundTargetV1,
  SliceManifestV1,
} from './types.js'

const APPLY_BATCH = 40
/** Verifiers other than the first in the epoch's apply ranking wait this long before applying. */
const APPLY_FALLBACK_DELAY_SECONDS = 2 * 60 * 60
const CLAIM_LOOKBACK_EPOCHS = 4n

export interface VerifierDaemonContext {
  client: KbfRoundClient
  signer: AbstractSigner
  address: string
  /** 0x-prefixed X25519 private key the publisher seals this verifier's envelopes to. */
  encryptionPrivateKey: string
  storage: RoundStorage
  /** Per-epoch state and published files: `<stateDir>/<epoch>/`. */
  stateDir: string
  /** Buys slices; null when the verifier only attests. */
  collector: CollectorContext | null
  log: (message: string) => void
}

interface EpochStateV1 {
  primary?: { uri: string; root: string; slices: number }
  backup?: { uri: string; root: string; slices: number }
  results?: { uri: string; root: string }
  attestedRoot?: string
}

export function encodeRoundFile(value: unknown): Buffer {
  return Buffer.from(canonicalJsonStringify(value), 'utf8')
}

export function modelHashOf(model: string): string {
  return keccak256(toUtf8Bytes(model.trim().toLowerCase()))
}

/** One pass over the current epoch and the recent past; safe to run repeatedly and after restarts. */
export async function verifierTick(context: VerifierDaemonContext): Promise<void> {
  const epoch = await context.client.currentEpoch()
  await stepEpoch(context, epoch)
  for (let back = 1n; back <= CLAIM_LOOKBACK_EPOCHS && back <= epoch; back++) {
    await applyAndClaim(context, epoch - back, epoch)
  }
}

async function stepEpoch(context: VerifierDaemonContext, epoch: bigint): Promise<void> {
  const { client } = context
  const info = await client.epochInfo(epoch)
  if (info.voided) return
  const deadlines = kbfEpochDeadlines(info, await client.epochDuration())
  const now = await client.now()

  if (!isZeroHash(info.bankHash) && info.seedBlock === 0n && now < deadlines.commitDeadline) {
    await tryWrite(context, `open epoch ${epoch}`, () => client.openEpoch(context.signer, epoch))
    return
  }
  if (info.seedBlock !== 0n && isZeroHash(info.seed)) {
    if (BigInt(await client.latestBlockNumber()) > info.seedBlock) {
      await tryWrite(context, `fix seed of epoch ${epoch}`, () => client.fixSeed(context.signer, epoch))
    }
    return
  }
  const members = await client.epochVerifiers(epoch)
  const member = members.includes(getAddress(context.address))
  if (!member) return
  const state = await readState(context, epoch)

  if (context.collector && !isZeroHash(info.planHash) && now < deadlines.commitDeadline && !state.primary) {
    await collect(context, info, state, false)
  }
  if (
    context.collector && !isZeroHash(info.backupPlanHash) && now >= deadlines.commitDeadline
    && now < deadlines.backupDeadline && !state.backup
  ) {
    await collect(context, info, state, true)
  }
  if (!isZeroHash(info.bankKey) && now < deadlines.attestDeadline) {
    const attested = await client.attestation(epoch, context.address)
    if (isZeroHash(attested)) await scoreAndAttest(context, info, members, state)
  }
  if (!isZeroHash(info.finalizedRoot)) await applyAndClaim(context, epoch, epoch)
}

async function collect(context: VerifierDaemonContext, info: KbfEpochInfo, state: EpochStateV1, backup: boolean): Promise<void> {
  const plan = await loadPlanFile(context, info, backup)
  const sealed = plan.envelopes[context.address.toLowerCase()]
  if (!sealed) {
    state[backup ? 'backup' : 'primary'] = { uri: '', root: '', slices: 0 }
    await writeState(context, info.epoch, state)
    return
  }
  const envelope = JSON.parse(openEnvelope(context.encryptionPrivateKey, sealed).toString('utf8')) as EnvelopeContentV1
  if (envelope.epoch !== info.epoch.toString() || envelope.collector !== context.address.toLowerCase() || envelope.backup !== backup) {
    throw new Error(`envelope for epoch ${info.epoch} does not belong to this verifier`)
  }
  context.log(`epoch ${info.epoch}: collecting ${envelope.slices.length} ${backup ? 'backup ' : ''}slices`)
  const slices = []
  for (const slice of envelope.slices) slices.push(await collectSlice(slice, context.collector!))
  const manifest: SliceManifestV1 = {
    kind: 'antseed-kbf-slices', version: 1, epoch: info.epoch.toString(),
    collector: context.address.toLowerCase(), backup, slices,
  }
  const bytes = encodeRoundFile(manifest)
  const uri = await context.storage.put(bytes, `antseed-kbf-${info.epoch}-slices-${context.address.toLowerCase()}${backup ? '-backup' : ''}.json`)
  const root = contentHash(bytes)
  await writeJsonAtomic(join(epochDir(context, info.epoch), backup ? 'slices-backup.json' : 'slices.json'), manifest)
  await context.client.commitSlices(context.signer, info.epoch, root, uri)
  state[backup ? 'backup' : 'primary'] = { uri, root, slices: slices.length }
  await writeState(context, info.epoch, state)
  context.log(`epoch ${info.epoch}: committed ${slices.length} ${backup ? 'backup ' : ''}slices (${uri})`)
}

async function scoreAndAttest(
  context: VerifierDaemonContext,
  info: KbfEpochInfo,
  members: readonly string[],
  state: EpochStateV1,
): Promise<void> {
  const results = await computeResults(context, info, members)
  const bytes = encodeRoundFile(results)
  const uri = await context.storage.put(bytes, `antseed-kbf-${info.epoch}-results-${context.address.toLowerCase()}.json`)
  await writeJsonAtomic(join(epochDir(context, info.epoch), 'results.json'), results)
  state.results = { uri, root: results.root }
  await writeState(context, info.epoch, state)
  await context.client.attest(context.signer, info.epoch, results.root, uri)
  state.attestedRoot = results.root
  await writeState(context, info.epoch, state)
  const counts = results.results.reduce<Record<string, number>>((acc, result) => ({ ...acc, [result.verdict]: (acc[result.verdict] ?? 0) + 1 }), {})
  context.log(`epoch ${info.epoch}: attested ${results.root} (${JSON.stringify(counts)}, ${results.totalSlices} slices)`)
}

/** Rebuilds the epoch from chain + storage only and scores it. */
export async function computeResults(
  context: Pick<VerifierDaemonContext, 'client' | 'storage' | 'log'>,
  info: KbfEpochInfo,
  members: readonly string[],
): Promise<RoundResultsV1> {
  const { client, storage } = context
  const bankEvent = (await client.bankCommits(info.epoch)).filter((event) => event.bankHash === info.bankHash).at(-1)
  if (!bankEvent) throw new Error(`no BankCommitted event for epoch ${info.epoch}`)
  const bank = JSON.parse(openBank(info.bankKey, await storage.get(bankEvent.bankUri, info.bankHash)).toString('utf8')) as EpochBankV1
  if (bank.kind !== 'antseed-kbf-epoch-bank' || bank.epoch !== info.epoch.toString()) throw new Error('bank does not belong to this epoch')
  const planFile = await loadPlanFile(context, info, false)
  const models = await client.models(info.modelsVersion)
  const allowed = new Set(models.map((model) => model.modelHash.toLowerCase()))
  const targets = planFile.targets.filter((target) => isAuditedTarget(target, allowed, bank))
  const plan = derivePlan({
    epoch: info.epoch.toString(),
    seed: info.seed,
    probesPerService: info.schedule.probesPerService,
    slicesPerService: info.schedule.slicesPerService,
    verifiers: members,
    targets,
    bank,
  })
  const memberSet = new Set(members.map((member) => member.toLowerCase()))
  const manifests: CommittedManifest[] = []
  for (const commit of await client.sliceCommits(info.epoch)) {
    if (!memberSet.has(commit.sender.toLowerCase())) continue
    try {
      const manifest = JSON.parse((await storage.get(commit.uri, commit.hash)).toString('utf8')) as SliceManifestV1
      manifests.push({ collector: commit.sender.toLowerCase(), backup: commit.backup, uri: commit.uri, manifest })
    } catch (error) {
      context.log(`epoch ${info.epoch}: skipping unavailable slices ${commit.uri}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return scoreRound({ epoch: info.epoch, plan, bank, manifests })
}

function isAuditedTarget(target: RoundTargetV1, allowed: Set<string>, bank: EpochBankV1): boolean {
  return allowed.has(target.modelHash.toLowerCase())
    && modelHashOf(target.model) === target.modelHash.toLowerCase()
    && keccak256(toUtf8Bytes(target.service.trim().toLowerCase())) === target.serviceHash.toLowerCase()
    && Boolean(bank.models[target.model])
}

async function loadPlanFile(
  context: Pick<VerifierDaemonContext, 'client' | 'storage'>,
  info: KbfEpochInfo,
  backup: boolean,
): Promise<PlanFileV1> {
  const hash = backup ? info.backupPlanHash : info.planHash
  const event = (await context.client.planCommits(info.epoch)).filter((entry) => entry.backup === backup && entry.hash === hash).at(-1)
  if (!event) throw new Error(`no ${backup ? 'backup ' : ''}PlanCommitted event for epoch ${info.epoch}`)
  const plan = JSON.parse((await context.storage.get(event.uri, hash)).toString('utf8')) as PlanFileV1
  if (plan.kind !== 'antseed-kbf-plan' || plan.epoch !== info.epoch.toString() || plan.seed !== info.seed || plan.backup !== backup) {
    throw new Error(`plan file for epoch ${info.epoch} does not match the chain`)
  }
  return plan
}

/**
 * Applies the finalized results (the first verifier in the epoch's apply ranking does it at
 * once, the others only if it is still undone later) and claims this verifier's reward once
 * the epoch is over.
 */
async function applyAndClaim(context: VerifierDaemonContext, epoch: bigint, current: bigint): Promise<void> {
  const { client } = context
  const info = await client.epochInfo(epoch)
  if (info.voided || isZeroHash(info.finalizedRoot)) return
  const results = await finalizedResults(context, info)
  if (!results) return
  const leaves = [
    ...results.results.map((result) => serviceLeaf(epoch, { agentId: BigInt(result.target.agentId), serviceHash: result.target.serviceHash, modelHash: result.target.modelHash, verdict: result.verdict })),
    ...results.credits.map((credit) => collectorLeaf(epoch, credit.collector, credit.slices, results.totalSlices)),
  ]
  const tree = new ResultsTree(leaves)

  const members = await client.epochVerifiers(epoch)
  const applier = seededRanking(members, info.seed, 'apply')[0]
  const deadlines = kbfEpochDeadlines(info, await client.epochDuration())
  const now = await client.now()
  if (applier === context.address.toLowerCase() || now >= deadlines.attestDeadline + APPLY_FALLBACK_DELAY_SECONDS) {
    const pending: Array<{ result: KbfServiceResult; proof: string[] }> = []
    for (const result of results.results) {
      const input = { agentId: BigInt(result.target.agentId), serviceHash: result.target.serviceHash, modelHash: result.target.modelHash, verdict: result.verdict }
      const leaf = serviceLeaf(epoch, input)
      if (await client.resultApplied(epoch, leaf)) continue
      pending.push({ result: { ...input, verdict: verdictCode(result.verdict) as KbfServiceResult['verdict'] }, proof: tree.proof(leaf) })
    }
    for (let offset = 0; offset < pending.length; offset += APPLY_BATCH) {
      const batch = pending.slice(offset, offset + APPLY_BATCH)
      await tryWrite(context, `apply ${batch.length} results of epoch ${epoch}`, () =>
        client.applyResults(context.signer, epoch, batch.map((entry) => entry.result), batch.map((entry) => entry.proof)))
    }
  }

  if (epoch >= current || await client.rewardClaimed(epoch, context.address)) return
  const credit = results.credits.find((entry) => entry.collector === context.address.toLowerCase())
  const slices = credit?.slices ?? 0
  const proof = credit ? tree.proof(collectorLeaf(epoch, credit.collector, credit.slices, results.totalSlices)) : []
  const pending = await client.pendingReward(context.address, epoch, slices, slices ? results.totalSlices : 0, proof)
  if (pending === 0n) return
  await tryWrite(context, `claim ${pending} for epoch ${epoch}`, () =>
    client.claimRewards(context.signer, epoch, slices, slices ? results.totalSlices : 0, proof))
}

/** This verifier's results when they match the finalized root, otherwise a matching attester's. */
async function finalizedResults(context: VerifierDaemonContext, info: KbfEpochInfo): Promise<RoundResultsV1 | null> {
  const local = await readJson<RoundResultsV1>(join(epochDir(context, info.epoch), 'results.json'))
  if (local && local.root.toLowerCase() === info.finalizedRoot.toLowerCase()) return local
  for (const attestation of await context.client.attestationEvents(info.epoch)) {
    if (attestation.hash.toLowerCase() !== info.finalizedRoot.toLowerCase()) continue
    try {
      const results = JSON.parse((await context.storage.get(attestation.uri)).toString('utf8')) as RoundResultsV1
      if (results.root.toLowerCase() === info.finalizedRoot.toLowerCase()) return results
    } catch {
      // try the next attester's copy
    }
  }
  context.log(`epoch ${info.epoch}: finalized results unavailable`)
  return null
}

async function tryWrite(context: VerifierDaemonContext, label: string, write: () => Promise<string>): Promise<void> {
  try {
    const hash = await write()
    context.log(`${label}: ${hash}`)
  } catch (error) {
    context.log(`${label} failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }
}

function epochDir(context: Pick<VerifierDaemonContext, 'stateDir'>, epoch: bigint): string {
  return join(context.stateDir, epoch.toString())
}

async function readState(context: VerifierDaemonContext, epoch: bigint): Promise<EpochStateV1> {
  return await readJson<EpochStateV1>(join(epochDir(context, epoch), 'state.json')) ?? {}
}

async function writeState(context: VerifierDaemonContext, epoch: bigint, state: EpochStateV1): Promise<void> {
  await mkdir(epochDir(context, epoch), { recursive: true })
  await writeJsonAtomic(join(epochDir(context, epoch), 'state.json'), state)
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}
