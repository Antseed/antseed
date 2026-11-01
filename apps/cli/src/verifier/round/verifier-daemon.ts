import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { getAddress, type AbstractSigner } from 'ethers'
import {
  isZeroHash,
  kbfEpochDeadlines,
  VERIFIER_VERDICT,
  type CommitmentEvent,
  type KbfEpochInfo,
  type KbfRoundClient,
  type KbfServiceResult,
} from '@antseed/node/payments'
import { writeJsonAtomic } from '../atomic-files.js'
import { encodeRoundFile } from './encoding.js'
import { collectSlice, type CollectorContext } from './collector.js'
import { checkEnvelope, isListedTarget } from './envelope-check.js'
import { buildResultsTree, collectorLeaf, serviceLeaf } from './merkle.js'
import { derivePlan, sliceCollectors } from './plan.js'
import { createEnvelopeDeliveryChecker, scoreRound, type CommittedManifest } from './scoring.js'
import { acknowledgeKeyShares } from './key-escrow.js'
import { contentHash, openBank, openEnvelope } from './sealing.js'
import { seededRanking } from './seeded.js'
import { boundTargets, type SellerBindingReader } from './seller-binding.js'
import { loadCommittedManifests, manifestBudget } from './manifest-loader.js'
import { ROUND_FILE_MAX_BYTES, type RoundStorage } from './storage.js'
import type {
  EnvelopeSliceV1,
  EpochBankV1,
  PlanFileV1,
  RoundResultsV1,
  RoundTargetV1,
  SliceExchangeV1,
  SliceManifestV1,
} from './types.js'
import { targetKey } from './types.js'

const APPLY_BATCH = 40
/** Verifiers other than the first in the epoch's apply ranking wait this long before applying. */
const APPLY_FALLBACK_DELAY_SECONDS = 2 * 60 * 60
const CLAIM_LOOKBACK_EPOCHS = 4n
/** Stop starting purchases this long before a collection phase ends (capped at a tenth of it). */
const COLLECT_STOP_MARGIN_SECONDS = 5 * 60
/** Do not send a slice commitment closer than this to its phase deadline (capped at a twentieth). */
const COMMIT_MARGIN_SECONDS = 60
/**
 * Share of the attestation window a verifier waits for committed slices it cannot fetch yet.
 * Until then it does not attest (an attestation is final); after it, the unavailable slices
 * count as missing so the round can still finalize.
 */
const UNAVAILABLE_WAIT_SHARE = 0.5
/**
 * Share of the backup window a backup collector waits for primary slice files it cannot fetch
 * yet before treating their slices as undelivered and buying them itself.
 */
export const BACKUP_UNAVAILABLE_WAIT_SHARE = 0.25
/**
 * Time kept free at the end of a phase for what follows downloads: publishing and sending the
 * attestation, or buying backed-up slices (capped at a quarter of the phase).
 */
const FETCH_RESERVE_SECONDS = 2 * 60
/** Default for `maxRequestsPerEpoch`. */
export const DEFAULT_MAX_REQUESTS_PER_EPOCH = 1_000

export interface VerifierDaemonContext {
  client: KbfRoundClient
  signer: AbstractSigner
  address: string
  /** 0x-prefixed X25519 private key the publisher seals this verifier's envelopes to. */
  encryptionPrivateKey: string
  storage: RoundStorage
  /** Seller registry reads that confirm each target's peer belongs to its agent. */
  bindings: SellerBindingReader
  /** Per-epoch state and published files: `<stateDir>/<epoch>/`. */
  stateDir: string
  /** Buys slices; null when the verifier only attests. */
  collector: CollectorContext | null
  /**
   * Most seller requests sent per epoch, retries included, primary and backup together, whatever
   * the envelopes ask for. Default `DEFAULT_MAX_REQUESTS_PER_EPOCH`.
   */
  maxRequestsPerEpoch?: number
  log: (message: string) => void
}

interface EpochStateV1 {
  primary?: { uri: string; root: string; slices: number }
  backup?: { uri: string; root: string; slices: number }
  results?: { uri: string; root: string }
  attestedRoot?: string
  /** Seller requests sent this epoch, retries included, counted against `maxRequestsPerEpoch`. */
  requestsSent?: number
}

/** Some committed slices could not be fetched yet; attesting now would be final and incomplete. */
export class ManifestsUnavailableError extends Error {
  constructor(readonly uris: string[]) {
    super(`${uris.length} committed slice files unavailable: ${uris.join(', ')}`)
    this.name = 'ManifestsUnavailableError'
  }
}

/** One pass over the current epoch and the recent past; safe to run repeatedly and after restarts. */
export async function verifierTick(context: VerifierDaemonContext): Promise<void> {
  const epoch = await context.client.currentEpoch()
  // A failing current epoch must not hold back applying and claiming earlier ones, nor one
  // earlier epoch the others.
  const failures: string[] = []
  try {
    await stepEpoch(context, epoch)
  } catch (error) {
    failures.push(`epoch ${epoch}: ${error instanceof Error ? error.message : String(error)}`)
  }
  for (let back = 1n; back <= CLAIM_LOOKBACK_EPOCHS && back <= epoch; back++) {
    try {
      await applyAndClaim(context, epoch - back, epoch)
    } catch (error) {
      failures.push(`epoch ${epoch - back}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (failures.length > 0) throw new Error(failures.join('; '))
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
  if (
    !isZeroHash(info.keySharesHash) && isZeroHash(info.planHash) && now < deadlines.commitDeadline
    && getAddress(info.publisher) !== getAddress(context.address)
  ) {
    await acknowledgeKeyShares(context, info)
  }
  const state = await readState(context, epoch)

  if (context.collector && !isZeroHash(info.planHash) && now < deadlines.commitDeadline && !state.primary) {
    await collect(context, info, members, state, false)
  }
  if (
    context.collector && !isZeroHash(info.planHash) && now >= deadlines.commitDeadline
    && now < deadlines.backupDeadline && !state.backup
  ) {
    await collect(context, info, members, state, true)
  }
  if (!isZeroHash(info.bankKey) && now < deadlines.attestDeadline) {
    const attested = await client.attestation(epoch, context.address)
    if (isZeroHash(attested)) await scoreAndAttest(context, info, members, state)
  }
  if (!isZeroHash(info.finalizedRoot)) await applyAndClaim(context, epoch, epoch)
}

interface CollectCheckpointV1 {
  /** `<targetKey>#<sliceIndex>` → batch index → the signed exchange, or null when the batch failed. */
  batches: Record<string, Record<string, SliceExchangeV1 | null>>
}

/**
 * Buys this verifier's slices for one phase and commits them. The envelope is checked against
 * everything public before anything is bought (`checkEnvelope`), and purchases stop at the
 * operator's per-epoch budget whatever it asks for. In the backup phase only the backed-up slices
 * whose owner did not deliver are bought. Bought batches are checkpointed as they complete and the
 * finished manifest is kept on disk before it is uploaded, so a failed upload or commit only
 * retries publication: nothing is bought twice. Buying stops when the phase is about to end, and a
 * manifest is only committed while its phase is still open, because the contract labels a
 * commitment by the time it lands.
 */
async function collect(
  context: VerifierDaemonContext,
  info: KbfEpochInfo,
  members: readonly string[],
  state: EpochStateV1,
  backup: boolean,
): Promise<void> {
  const phase = backup ? 'backup' : 'primary'
  const label = backup ? 'backup ' : ''
  const deadlines = kbfEpochDeadlines(info, await context.client.epochDuration())
  const deadline = backup ? deadlines.backupDeadline : deadlines.commitDeadline
  const phaseSeconds = backup ? info.schedule.backupSeconds : info.schedule.collectSeconds
  const stopMargin = Math.min(COLLECT_STOP_MARGIN_SECONDS, Math.floor(phaseSeconds / 10))
  const commitMargin = Math.min(COMMIT_MARGIN_SECONDS, Math.floor(phaseSeconds / 20))

  // A commit that landed although its receipt was lost: adopt it instead of buying again.
  const landed = (await context.client.sliceCommits(info.epoch))
    .filter((entry) => entry.backup === backup && entry.sender.toLowerCase() === context.address.toLowerCase())
    .at(-1)
  const manifestPath = join(epochDir(context, info.epoch), backup ? 'slices-backup.json' : 'slices.json')
  if (landed) {
    const local = await readJson<SliceManifestV1>(manifestPath)
    state[phase] = { uri: landed.uri, root: landed.hash, slices: local?.slices.length ?? 0 }
    await writeState(context, info.epoch, state)
    context.log(`epoch ${info.epoch}: ${label}slices already committed (${landed.uri})`)
    return
  }

  let manifest = await readJson<SliceManifestV1>(manifestPath)
  if (!manifest) {
    const plan = await loadPlanFile(context, info)
    const me = context.address.toLowerCase()
    const sealed = (backup ? plan.backupEnvelopes : plan.envelopes)[me]
    const nothingToBuy = async (reason: string): Promise<void> => {
      state[phase] = { uri: '', root: '', slices: 0 }
      await writeState(context, info.epoch, state)
      if (reason) context.log(`epoch ${info.epoch}: ${reason}`)
    }
    if (!sealed) return nothingToBuy('')
    const models = await context.client.models(info.modelsVersion)
    const envelope = checkEnvelope(JSON.parse(openEnvelope(context.encryptionPrivateKey, sealed).toString('utf8')), {
      epoch: info.epoch, seed: info.seed, collector: me, backup, verifiers: members, targets: plan.targets,
      allowedModels: new Set(models.map((model) => model.modelHash.toLowerCase())),
      probesPerService: info.schedule.probesPerService, slicesPerService: info.schedule.slicesPerService,
    })
    // Never buy from a target whose peer is not its agent's seller: verifiers will not score it.
    const bound = new Set((await boundTargets(context.bindings, uniqueTargets(envelope.slices.map((slice) => slice.target)), info.seedBlock, context.log)).map(targetKey))
    let assigned = envelope.slices.filter((slice) => bound.has(targetKey(slice.target)))
    if (backup) {
      assigned = await undeliveredSlices(context, info, members, plan.targets, assigned)
      if (assigned.length === 0) return nothingToBuy('every slice this verifier backs up was delivered; no backups to buy')
    }
    const checkpointPath = join(epochDir(context, info.epoch), `collect-${phase}.json`)
    const checkpoint = await readJson<CollectCheckpointV1>(checkpointPath) ?? { batches: {} }
    const budget = context.maxRequestsPerEpoch ?? DEFAULT_MAX_REQUESTS_PER_EPOCH
    context.log(`epoch ${info.epoch}: collecting ${assigned.length} ${label}slices (${state.requestsSent ?? 0} of ${budget} requests sent this epoch)`)
    let stopped = false
    let overBudget = false
    // Every request attempt is counted, and saved, before it is sent.
    const beforeRequest = async (): Promise<boolean> => {
      overBudget ||= (state.requestsSent ?? 0) >= budget
      stopped ||= overBudget || await context.client.now() + stopMargin >= deadline
      if (stopped) return false
      state.requestsSent = (state.requestsSent ?? 0) + 1
      await writeState(context, info.epoch, state)
      return true
    }
    const slices = []
    for (const slice of assigned) {
      const key = `${targetKey(slice.target)}#${slice.sliceIndex}`
      const done = new Map(Object.entries(checkpoint.batches[key] ?? {}).map(([index, exchange]) => [Number(index), exchange]))
      slices.push(await collectSlice(slice, context.collector!, {
        done,
        beforeRequest,
        onBatch: async (batchIndex, exchange) => {
          checkpoint.batches[key] = { ...checkpoint.batches[key], [batchIndex]: exchange }
          await writeJsonAtomic(checkpointPath, checkpoint)
        },
      }))
    }
    if (overBudget) context.log(`epoch ${info.epoch}: reached the budget of ${budget} requests this epoch; committing what was collected`)
    else if (stopped) context.log(`epoch ${info.epoch}: ${label}phase ends soon; stopped buying, committing what was collected`)
    manifest = {
      kind: 'antseed-kbf-slices', version: 1, epoch: info.epoch.toString(),
      collector: context.address.toLowerCase(), backup, slices,
    }
    await writeJsonAtomic(manifestPath, manifest)
  }

  // Landing after the deadline would file it under the wrong phase, where it cannot be scored.
  // Checked again after the upload, which can take long enough to cross the deadline.
  const phaseMissed = async (): Promise<boolean> => {
    if (await context.client.now() + commitMargin < deadline) return false
    state[phase] = { uri: '', root: '', slices: 0 }
    await writeState(context, info.epoch, state)
    context.log(`epoch ${info.epoch}: ${label}phase over before the slices were committed; ${manifest!.slices.length} slices not delivered`)
    return true
  }
  if (await phaseMissed()) return
  const bytes = encodeRoundFile(manifest)
  const uri = await context.storage.put(bytes, `antseed-kbf-${info.epoch}-slices-${context.address.toLowerCase()}${backup ? '-backup' : ''}.json`)
  if (await phaseMissed()) return
  const root = contentHash(bytes)
  await context.client.commitSlices(context.signer, info.epoch, root, uri)
  state[phase] = { uri, root, slices: manifest.slices.length }
  await writeState(context, info.epoch, state)
  context.log(`epoch ${info.epoch}: committed ${manifest.slices.length} ${label}slices (${uri})`)
}

async function scoreAndAttest(
  context: VerifierDaemonContext,
  info: KbfEpochInfo,
  members: readonly string[],
  state: EpochStateV1,
): Promise<void> {
  const deadlines = kbfEpochDeadlines(info, await context.client.epochDuration())
  const waitUntil = deadlines.backupDeadline + Math.floor(info.schedule.attestSeconds * UNAVAILABLE_WAIT_SHARE)
  const now = await context.client.now()
  const allowUnavailable = now >= waitUntil
  const signal = phaseFetchSignal(now, deadlines.attestDeadline, info.schedule.attestSeconds)
  let results: RoundResultsV1
  try {
    results = await computeResults(context, info, members, { allowUnavailable, signal })
  } catch (error) {
    if (!(error instanceof ManifestsUnavailableError)) throw error
    context.log(`epoch ${info.epoch}: not attesting yet, ${error.message}; retrying until ${new Date(waitUntil * 1_000).toISOString()}`)
    return
  }
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

/**
 * Rebuilds the epoch from chain + storage only and scores it. A committed slice file that cannot
 * be fetched throws `ManifestsUnavailableError` unless `allowUnavailable`; one whose bytes are
 * not the committed ones, or that is not a slice manifest, is invalid and simply not used.
 */
export async function computeResults(
  context: Pick<VerifierDaemonContext, 'client' | 'storage' | 'bindings' | 'log'>,
  info: KbfEpochInfo,
  members: readonly string[],
  options: { allowUnavailable?: boolean; signal?: AbortSignal } = {},
): Promise<RoundResultsV1> {
  const { client, storage } = context
  const bankEvent = (await client.bankCommits(info.epoch)).filter((event) => event.bankHash === info.bankHash).at(-1)
  if (!bankEvent) throw new Error(`no BankCommitted event for epoch ${info.epoch}`)
  const bank = JSON.parse(openBank(info.bankKey, await storage.get(bankEvent.bankUri, info.bankHash, ROUND_FILE_MAX_BYTES.bank)).toString('utf8')) as EpochBankV1
  if (bank.kind !== 'antseed-kbf-epoch-bank' || bank.epoch !== info.epoch.toString()) throw new Error('bank does not belong to this epoch')
  const planFile = await loadPlanFile(context, info)
  const models = await client.models(info.modelsVersion)
  const allowed = new Set(models.map((model) => model.modelHash.toLowerCase()))
  const audited = planFile.targets.filter((target) => isAuditedTarget(target, allowed, bank))
  const targets = await boundTargets(context.bindings, audited, info.seedBlock, context.log)
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
  const unavailable: string[] = []
  const commits = (await client.sliceCommits(info.epoch)).filter((commit) => memberSet.has(commit.sender.toLowerCase()))
  const budgetFor = roundManifestBudget(info, members, planFile.targets)
  for (const { commit, load } of await loadCommittedManifests(storage, commits, budgetFor, options.signal)) {
    if (load.kind === 'loaded') {
      manifests.push(load.manifest)
    } else if (load.kind === 'invalid') {
      context.log(`epoch ${info.epoch}: ignoring slices ${commit.uri}: ${load.reason}`)
    } else {
      const reason = load.error instanceof Error ? load.error.message : String(load.error)
      if (load.kind === 'mismatch') {
        context.log(`epoch ${info.epoch}: ignoring invalid slices ${commit.uri}: ${reason}`)
      } else {
        unavailable.push(commit.uri)
        context.log(`epoch ${info.epoch}: slices ${commit.uri} unavailable: ${reason}`)
      }
    }
  }
  if (unavailable.length > 0 && !options.allowUnavailable) throw new ManifestsUnavailableError(unavailable)
  return scoreRound({ epoch: info.epoch, plan, bank, manifests })
}

/**
 * Aborts downloads once a phase is down to its reserve, so unfetchable files cannot hold this
 * verifier past `deadline` (unix seconds): they count as unavailable and the usual rules apply.
 */
export function phaseFetchSignal(now: number, deadline: number, phaseSeconds: number): AbortSignal {
  const reserve = Math.min(FETCH_RESERVE_SECONDS, Math.floor(phaseSeconds / 4))
  return AbortSignal.timeout(Math.max(0, deadline - reserve - now) * 1_000)
}

/**
 * Each commitment's size budget, from the slices the seed gives its sender in that phase, over
 * the plan file's public targets: the same for every verifier.
 */
function roundManifestBudget(info: KbfEpochInfo, members: readonly string[], targets: readonly RoundTargetV1[]) {
  const budgets = new Map<string, ReturnType<typeof manifestBudget>>()
  return (commit: CommitmentEvent) => {
    const key = `${commit.sender.toLowerCase()}|${commit.backup}`
    let budget = budgets.get(key)
    if (!budget) {
      budget = manifestBudget({
        verifiers: members,
        seed: info.seed,
        targets,
        probesPerService: info.schedule.probesPerService,
        slicesPerService: info.schedule.slicesPerService,
        collector: commit.sender,
        backup: commit.backup,
      })
      budgets.set(key, budget)
    }
    return budget
  }
}

function isAuditedTarget(target: RoundTargetV1, allowed: Set<string>, bank: EpochBankV1): boolean {
  return isListedTarget(target, allowed) && Object.hasOwn(bank.models, target.model)
}

/**
 * The backed-up slices whose owner did not commit a complete, valid primary copy, judged from
 * the committed primary files exactly as scoring will judge them. Primary files that cannot be
 * fetched are waited for during the first part of the backup window, then counted as missing.
 */
async function undeliveredSlices(
  context: Pick<VerifierDaemonContext, 'client' | 'storage' | 'log'>,
  info: KbfEpochInfo,
  members: readonly string[],
  targets: readonly RoundTargetV1[],
  slices: readonly EnvelopeSliceV1[],
): Promise<EnvelopeSliceV1[]> {
  const memberSet = new Set(members.map((member) => member.toLowerCase()))
  const manifests: CommittedManifest[] = []
  const unavailable: string[] = []
  const deadlines = kbfEpochDeadlines(info, await context.client.epochDuration())
  const commits = (await context.client.sliceCommits(info.epoch))
    .filter((commit) => !commit.backup && memberSet.has(commit.sender.toLowerCase()))
  const signal = phaseFetchSignal(await context.client.now(), deadlines.backupDeadline, info.schedule.backupSeconds)
  for (const { commit, load } of await loadCommittedManifests(context.storage, commits, roundManifestBudget(info, members, targets), signal)) {
    if (load.kind === 'loaded') manifests.push(load.manifest)
    else if (load.kind === 'unavailable') unavailable.push(commit.uri)
  }
  if (unavailable.length > 0) {
    const waitUntil = deadlines.commitDeadline + Math.floor(info.schedule.backupSeconds * BACKUP_UNAVAILABLE_WAIT_SHARE)
    if (await context.client.now() < waitUntil) {
      throw new Error(`${unavailable.length} primary slice files unavailable; retrying before buying backups`)
    }
    context.log(`epoch ${info.epoch}: ${unavailable.length} primary slice files still unavailable; buying their backed-up slices`)
  }
  const delivered = createEnvelopeDeliveryChecker(manifests, info.epoch.toString())
  return slices.filter((slice) => !delivered(slice, sliceCollectors(members, info.seed, slice.target, slice.sliceIndex).owner))
}

function uniqueTargets(targets: readonly RoundTargetV1[]): RoundTargetV1[] {
  return [...new Map(targets.map((target) => [targetKey(target), target])).values()]
}

async function loadPlanFile(
  context: Pick<VerifierDaemonContext, 'client' | 'storage'>,
  info: KbfEpochInfo,
): Promise<PlanFileV1> {
  const event = (await context.client.planCommits(info.epoch)).filter((entry) => entry.hash === info.planHash).at(-1)
  if (!event) throw new Error(`no PlanCommitted event for epoch ${info.epoch}`)
  const plan = JSON.parse((await context.storage.get(event.uri, info.planHash, ROUND_FILE_MAX_BYTES.plan)).toString('utf8')) as PlanFileV1
  if (
    plan.kind !== 'antseed-kbf-plan' || plan.epoch !== info.epoch.toString() || plan.seed !== info.seed
    || !Array.isArray(plan.targets) || !isRecord(plan.envelopes) || !isRecord(plan.backupEnvelopes)
  ) {
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
  const tree = buildResultsTree(epoch, results)

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
      pending.push({ result: { ...input, verdict: VERIFIER_VERDICT[result.verdict] }, proof: tree.proof(leaf) })
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

/**
 * This verifier's results, or a matching attester's copy, but only once its leaves rebuild the
 * finalized root: a file is never trusted for its `root` property alone, because applying or
 * claiming from altered leaves (say, a missing collector credit) can forfeit a reward for good.
 */
async function finalizedResults(context: VerifierDaemonContext, info: KbfEpochInfo): Promise<RoundResultsV1 | null> {
  const local = authenticResults(info, await readJson<unknown>(join(epochDir(context, info.epoch), 'results.json')))
  if (local) return local
  for (const attestation of await context.client.attestationEvents(info.epoch)) {
    if (attestation.hash.toLowerCase() !== info.finalizedRoot.toLowerCase()) continue
    try {
      const results = authenticResults(info, JSON.parse((await context.storage.get(attestation.uri, undefined, ROUND_FILE_MAX_BYTES.results)).toString('utf8')))
      if (results) return results
      context.log(`epoch ${info.epoch}: ignoring results ${attestation.uri}: leaves do not rebuild the finalized root`)
    } catch {
      // try the next attester's copy
    }
  }
  context.log(`epoch ${info.epoch}: finalized results unavailable`)
  return null
}

/** `value` as results of `info.epoch` whose leaves rebuild `info.finalizedRoot`, else null. */
export function authenticResults(info: Pick<KbfEpochInfo, 'epoch' | 'finalizedRoot'>, value: unknown): RoundResultsV1 | null {
  if (!value || typeof value !== 'object') return null
  const results = value as RoundResultsV1
  const wellFormed = results.kind === 'antseed-kbf-results' && results.epoch === info.epoch.toString()
    && Array.isArray(results.results) && Array.isArray(results.credits)
    && Number.isSafeInteger(results.totalSlices) && results.totalSlices >= 0
    && results.results.every((entry) => entry && typeof entry === 'object' && entry.target && typeof entry.target === 'object'
      && typeof entry.target.agentId === 'string' && /^[1-9]\d*$/.test(entry.target.agentId)
      && typeof entry.target.serviceHash === 'string' && typeof entry.target.modelHash === 'string'
      && typeof entry.verdict === 'string')
    && results.credits.every((entry) => entry && typeof entry === 'object' && typeof entry.collector === 'string'
      && Number.isSafeInteger(entry.slices) && entry.slices > 0)
  if (!wellFormed) return null
  try {
    if (buildResultsTree(info.epoch, results).root.toLowerCase() !== info.finalizedRoot.toLowerCase()) return null
    // Leaves hash checksummed addresses, so any casing authenticates; credits are looked up lowercase.
    return { ...results, credits: results.credits.map((entry) => ({ ...entry, collector: entry.collector.toLowerCase() })) }
  } catch {
    return null
  }
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}
