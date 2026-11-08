import chalk from 'chalk'
import pkg from '../../../../package.json' with { type: 'json' }
import { requireCurrentVerifier } from '../../../verifier/release-check.js'
import { verifierRuleOverrides } from '../../../verifier/verifier-compat.js'
import type { Command } from 'commander'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalHashBytes32, queryProfileHash, type KbfReferenceV1 } from '@antseed/fingerprints'
import { modelHash, serviceHash } from '@antseed/node/payments'
import type { PeerInfo } from '@antseed/node'
import { resolveEffectiveBuyerConfig } from '../../../config/effective.js'
import { loadConfig } from '../../../config/loader.js'
import type { VerifierCLIConfig } from '../../../config/types.js'
import {
  appendVerifierEvent,
  modelAuditsDirectory,
  modelAuditReportPath,
  modelAuditExtensionsDirectory,
  modelAuditSellersDirectory,
  modelReferencesDirectory,
  readVerifierRunManifest,
  readVerifierStatus,
  writeEpochAuditSummary,
  writeModelAuditReports,
  writeModelAuditSummary,
  writeVerifierRunManifest,
  writeVerifierStatus,
  type EpochAuditSummaryV1,
  type ModelAuditSummaryV1,
  type VerifierRunManifestV1,
  type VerifierStatusV1,
} from '../../../verifier/audit-artifacts.js'
import { resolveAuditEpochWindow, type AuditEpochWindow, type OnchainEpochReader } from '../../../verifier/audit-epoch.js'
import { auditModelListHash, confirmationAssignments, roundRobinAssignmentFor, type AuditAssignment } from '../../../verifier/audit-assignment.js'
import { approvedAuditorsAt, loadAuditorSetEvents, revokedSinceEpochStart } from '../../../verifier/auditor-set.js'
import { chainNow } from '../../../verifier/chain-clock.js'
import {
  describeHandover, handoverModelsFor, loadEpochModelAudits, type AuditHandover,
} from '../../../verifier/audit-handover.js'
import {
  createDepositsClient,
  createEmissionsGateClient,
  createVerifierClient,
  loadCryptoContext,
  openChannelStore,
} from '../../payment-utils.js'
import type { AntseedConfig } from '../../../config/types.js'
import {
  ConcurrencyLimiter,
  KeyedSerialLimiter,
  SerialOperationQueue,
  mapConcurrently,
  mapInLanes,
} from '../../../verifier/audit-concurrency.js'
import { acquirePidFileLock } from '../../../verifier/atomic-files.js'
import { findAdvertisedService } from '../../../verifier/service-discovery.js'
import { configuredVerifierModels, resolveVerifierCommandModels, verifierModelServices } from '../../../verifier/model-config.js'
import { describeAuditorSource, resolveAuditorAddress } from './auditor-identity.js'
import { alreadyJudgedByOther, otherOpinions, type OtherOpinion } from '../../../verifier/third-opinion.js'
import { asError, normalized } from '../../../verifier/utils.js'
import {
  classifyVerificationTargetServices,
  loadBuyerProxySnapshot,
  readModelAuditCheckpoints,
  verifyModelTarget,
  DEFAULT_AUDIT_MAX_TIMEOUT_MS,
  type ModelVerificationFailure,
  type ModelVerificationResumeInput,
  type ModelVerificationSkip,
  type ModelVerificationTargetResult,
  type ProxyVerificationContext,
  type VerificationTargetPolicy,
} from '../../../verifier/model-run.js'
import {
  DEFAULT_MAX_RESERVE_AMOUNT_USDC,
  depositShortfall,
  preRunError,
} from '../../../verifier/pre-run-checks.js'
import { buyerCapShortfall, describeAuditPriceCap, requiredBuyerCap, resolveAuditPriceCaps } from '../../../verifier/audit-price.js'
import { loadHighestEndpointPrice, loadVerifierModelCatalog } from '../../../verifier/openrouter-catalog.js'
import {
  epochSetCalibrationProblem,
  loadEpochQuestionSet,
  missingBankReferenceExchanges,
  loadModelAuditReservation,
  reserveExtensionReference,
  reserveModelAuditReference,
  voidModelAuditReference,
} from '../../../verifier/probe-bank.js'
import {
  addAuditCostSummaries,
  emptyAuditCostSummary,
  verifyProxyAuditEvidenceFile,
  type ProxyAuditEvidenceV1,
} from '../../../verifier/proxy-evidence.js'
import { openResponseAuthReader } from '../../../verifier/response-auth-reader.js'
import { writeEpochOverview } from '../../../verifier/epoch-overview.js'
import {
  CONFIRMATION_ATTEMPTS,
  CONFIRMATION_RECHECK_SPACING_SECONDS,
  sellerRetryWaitUntil,
  countPlan,
  decideRetryGiveUps,
  writeRetryGiveUps,
  type RetryGiveUpV1,
  epochCellKey,
  heldForConfirmationRecheck,
  epochModelRows,
  loadEpochState,
  type EpochCell,
  type EpochState,
} from '../../../verifier/epoch-plan.js'
import { getGlobalOptions } from '../types.js'
import { BUILD_REQUEST_RUNS, ensureEpochQuestionSet } from '../../../verifier/ensure-auditable-reference.js'
import {
  MIN_SECONDS_FOR_ANOTHER_ROUND,
  closeFinishedAuditWindows,
  listAuditWindows,
  openAuditWindow,
  readAuditWindow,
  windowIncludesSeller,
  type AuditWindowV1,
} from '../../../verifier/audit-window.js'
import { createReferenceRequestLimiter, referenceConcurrencyWarning } from '../../../verifier/model-reference.js'
import { runExtensionRounds, type ExtensionRoundStats } from '../../../verifier/extension-round.js'
import { closeCallRuleForExtensions, extensionSets, latestExtension } from '../../../verifier/close-call.js'
import {
  confirmationTargetsByModel,
  describeTallies,
  dropSettledConfirmations,
  epochReports,
  loadBlockTimestamps,
  loadDisputedSellers,
  loadEpochAuditEvents,
  localResultAnswersConfirmation,
  ownLatestReports,
  pendingConfirmations,
  reportKey,
  waitingReportBlocks,
  type ConfirmationTarget,
} from '../../../verifier/pending-confirmations.js'
import { loadPendingExtensions, pendingExtensionKey } from '../../../verifier/pending-extensions.js'
import { VerifierRunProgress } from './run-progress.js'
import { failureOutcomeReason } from '../../../verifier/outcome-reason.js'
import {
  writeModelAuditManifest,
  writeModelProbeConsensusEvidence,
} from '../../../verifier/model-consensus-evidence.js'

export interface RunOptions {
  all?: boolean
  auditor?: string
  peer?: string
  resumeRun?: string
  /** `--no-enroll` sets this to false. */
  enroll?: boolean
  maxEnrollmentRequests?: string
  ignorePreRunChecks?: boolean
  fresh?: boolean
  skipVersionCheck?: boolean
  maxRounds?: string
  /** `--no-confirm` sets this to false. */
  confirm?: boolean
}

/** Reference requests per model a run may spend on enrollment when `--max-enrollment-requests` isn't given. */
export const DEFAULT_ENROLLMENT_REQUESTS = 2_000

/** Rounds per run when `--max-rounds` isn't given. */
export const DEFAULT_MAX_ROUNDS = 3

/**
 * `run` options that `verifier watch` takes too and passes to every tick's run, only when given, so
 * a tick runs with run's own defaults otherwise. `flags`/`description` are commander's.
 */
export const RUN_TUNING_OPTIONS = [
  {
    flags: '--no-enroll',
    description: 'never build questions; a model without this epoch\'s question set is not audited',
    args: (options: RunOptions) => options.enroll === false ? ['--no-enroll'] : [],
  },
  {
    flags: '--max-enrollment-requests <count>',
    description: `physical reference requests per model and round a question build may make, including retries (default: ${DEFAULT_ENROLLMENT_REQUESTS}). `
      + `An unfinished build continues in the next round or run, up to verifier.referenceMaxRequestsPerBuild in total (default: ${BUILD_REQUEST_RUNS} × this)`,
    args: (options: RunOptions) => options.maxEnrollmentRequests !== undefined ? ['--max-enrollment-requests', options.maxEnrollmentRequests] : [],
  },
  {
    flags: '--ignore-pre-run-checks',
    description: 'print the pre-run check problems as warnings and run anyway',
    args: (options: RunOptions) => options.ignorePreRunChecks ? ['--ignore-pre-run-checks'] : [],
  },
  {
    flags: '--max-rounds <count>',
    description: `rounds per run: after a round, retry what is left (failures, close calls waiting for extra questions) until nothing is left or a round makes no progress (default: ${DEFAULT_MAX_ROUNDS})`,
    args: (options: RunOptions) => options.maxRounds !== undefined ? ['--max-rounds', options.maxRounds] : [],
  },
  {
    flags: '--no-confirm',
    description: 'do not audit sellers whose verdicts from other auditors this epoch still wait for a confirmation',
    args: (options: RunOptions) => options.confirm === false ? ['--no-confirm'] : [],
  },
] as const

/** The `run` arguments for the tuning options set in `options`. */
export function runTuningArgs(options: RunOptions): string[] {
  return RUN_TUNING_OPTIONS.flatMap((option) => option.args(options))
}

/** Rejects tuning options that `run` would reject, so `watch` fails at start instead of on every tick. */
export function validateRunTuningOptions(options: RunOptions): void {
  enrollmentRequestBudget(options)
  maxRunRounds(options)
}

/**
 * Reference requests per model the run may spend building fresh questions, or null when it may not
 * build any. Enrollment is on by default: it only calls the reference API for a model whose bank is
 * too small, or whose sellers have already seen too much of it. `--no-enroll` turns it off, and a
 * `--resume-run` repair never enrolls.
 */
export function enrollmentRequestBudget(options: RunOptions): number | null {
  if (options.enroll === false) {
    if (options.maxEnrollmentRequests !== undefined) throw new Error('--max-enrollment-requests cannot be combined with --no-enroll')
    return null
  }
  if (options.resumeRun) {
    if (options.maxEnrollmentRequests !== undefined) {
      throw new Error('--resume-run only repairs a run and never builds fresh questions; drop --max-enrollment-requests')
    }
    return null
  }
  if (options.maxEnrollmentRequests === undefined) return DEFAULT_ENROLLMENT_REQUESTS
  const budget = Number(options.maxEnrollmentRequests)
  if (!Number.isSafeInteger(budget) || budget <= 0) {
    throw new Error('--max-enrollment-requests must be a positive integer (requests per model)')
  }
  return budget
}

/**
 * Reads the epoch the KBF audits contract checks on submit (the results layer's pinned gate). Without a
 * configured KBF audits contract it falls back to the configured emissions gate.
 */
export function auditEpochReader(config: AntseedConfig): OnchainEpochReader {
  let verifier: ReturnType<typeof createVerifierClient> | null = null
  try {
    verifier = createVerifierClient(config)
  } catch {
    return createEmissionsGateClient(config)
  }
  const window = verifier.currentEpochWindow()
  window.catch(() => undefined)
  return {
    currentEpoch: async () => Number((await window).epoch),
    genesis: async () => {
      const { epoch, startedAt, endsAt } = await window
      return startedAt - Number(epoch) * (endsAt - startedAt)
    },
    epochDuration: async () => {
      const { startedAt, endsAt } = await window
      return endsAt - startedAt
    },
  }
}

/**
 * The auditor's share of the audited models this epoch, round robin over the approved auditors (see
 * `assignAuditModelsRoundRobin`). Needs the on-chain epoch: the UTC-day fallback has no epoch
 * number to rotate on, and its evidence could not be submitted anyway.
 */
export function resolveAssignedAuditModels(
  config: AntseedConfig,
  auditor: string,
  epoch: AuditEpochWindow,
  approvedAuditors: readonly string[],
): AuditAssignment {
  if (epoch.source !== 'onchain') {
    throw new Error('the on-chain epoch is unavailable, so there is no model assignment; run `verifier run <model>` or `--all` instead')
  }
  const availableModels = configuredVerifierModels(config.verifier)
  if (availableModels.length === 0) throw new Error('no audited models are built into this CLI')
  if (!approvedAuditors.some((address) => address.toLowerCase() === auditor.toLowerCase())) {
    throw new Error(
      `${auditor} was not an approved auditor when epoch ${epoch.epoch} started, so it has no assigned models. `
      + 'Ask to be approved (see How audits run), or run `verifier run <model>` or `--all` to audit without submitting.',
    )
  }
  return roundRobinAssignmentFor(auditor, { auditors: approvedAuditors, epoch: epoch.epoch, availableModels })
}

/**
 * Unix seconds now, from the chain when a KBF audits contract is configured (`chainNow`: the latest
 * block's timestamp), else the wall clock. Everything that depends on how far the epoch has come
 * (the confirmation fallback, the auditor handover, the time left) reads it, so every auditor sees
 * the same time and on a local fork it follows the fork's time.
 */
export function chainClock(config: AntseedConfig): () => Promise<number> {
  let client: ReturnType<typeof createVerifierClient> | null = null
  try {
    client = createVerifierClient(config)
  } catch {
    client = null
  }
  return () => (client ? chainNow(client.provider) : Promise.resolve(Math.floor(Date.now() / 1_000)))
}

/**
 * The models this auditor stands in for this epoch (`auditHandovers`): those whose assigned auditor
 * has not audited them by halfway through the epoch, handed to the next active auditor in the
 * model's rotation. Nothing when the epoch is not on-chain or no KBF audits contract is
 * configured; a failed read is a warning, not a stop.
 */
export async function loadRunHandovers(input: {
  config: AntseedConfig
  dataDir: string
  auditor: string
  epochWindow: AuditEpochWindow
  approvedAuditors: readonly string[]
  now: number
}): Promise<AuditHandover[]> {
  if (input.epochWindow.source !== 'onchain') return []
  let client: ReturnType<typeof createVerifierClient>
  try {
    client = createVerifierClient(input.config)
  } catch {
    return []
  }
  try {
    const [audits, revoked] = await Promise.all([
      loadEpochModelAudits({
        reader: client,
        epoch: input.epochWindow.epoch,
        epochStartedAt: input.epochWindow.startedAt,
        deploymentBlock: client.deploymentBlock,
      }),
      loadRevokedAuditors(input.config, input.dataDir, input.epochWindow),
    ])
    return handoverModelsFor(input.auditor, {
      auditors: input.approvedAuditors,
      epoch: input.epochWindow.epoch,
      availableModels: configuredVerifierModels(input.config.verifier),
      audits,
      revoked,
      epochStartedAt: input.epochWindow.startedAt,
      epochEndsAt: input.epochWindow.endsAt,
      now: input.now,
    })
  } catch (error) {
    console.warn(chalk.yellow(`Could not read this epoch's model audits for the auditor handover: ${asError(error).message}`))
    return []
  }
}

/** Auditors approved when the epoch started, from the KBF audits contract's `AuditorSet` events. */
export async function loadApprovedAuditors(config: AntseedConfig, dataDir: string, epoch: AuditEpochWindow): Promise<string[]> {
  const events = await loadAuditorSetEvents(createVerifierClient(config), dataDir, (message) => console.log(chalk.dim(message)))
  return approvedAuditorsAt(events, epoch.startedAt)
}

/** Auditors revoked since the epoch started, from the same events. */
async function loadRevokedAuditors(config: AntseedConfig, dataDir: string, epoch: AuditEpochWindow): Promise<Set<string>> {
  return revokedSinceEpochStart(await loadAuditorSetEvents(createVerifierClient(config), dataDir), epoch.startedAt)
}

/** This epoch's disputed sellers for the overview; none when the epoch is not on-chain or no KBF audits contract is configured. */
async function epochDisputes(config: AntseedConfig, epochWindow: AuditEpochWindow): Promise<Set<string>> {
  if (epochWindow.source !== 'onchain') return new Set()
  try {
    const client = createVerifierClient(config)
    return await loadDisputedSellers({ reader: client, epochStartedAt: epochWindow.startedAt, deploymentBlock: client.deploymentBlock })
  } catch {
    return new Set()
  }
}

/**
 * Reports other auditors made this epoch that wait for a confirmation this auditor is to give, as
 * the sellers to audit per model. Confirmations rotate like the assignment
 * (`auditorRotationForModel`): one auditor at a time, for at most two opinions on a seller per model
 * and epoch (see `pendingConfirmations`). Nothing when the epoch is not on-chain or no KBF audits contract is configured; a failed read is a warning,
 * not a stop.
 */
/** A confirmation assigned to this auditor that this run does not audit, and why. */
export interface UnauditedConfirmation {
  model: string
  agentId: bigint
  service: string
  reason: string
}

export function confirmationPlanKey(model: string, agentId: bigint | string): string {
  return `${model.toLowerCase()}:${agentId}`
}

/**
 * The confirmations assigned to this auditor that the run's plan has no audit for. `audited` holds
 * the plan keys that got a target, and `reasons` why each of the seller's peers did not.
 * A seller none of whose peers the buyer sees has no reasons.
 */
export function unauditedConfirmations(input: {
  confirmations: ReadonlyMap<string, ReadonlyMap<string, ConfirmationTarget>>
  plannedModels: readonly string[]
  audited: ReadonlySet<string>
  reasons: ReadonlyMap<string, readonly string[]>
}): UnauditedConfirmation[] {
  const planned = new Set(input.plannedModels.map((model) => model.toLowerCase()))
  const unaudited: UnauditedConfirmation[] = []
  for (const [model, targets] of input.confirmations) {
    for (const target of targets.values()) {
      const key = confirmationPlanKey(model, target.agentId)
      if (input.audited.has(key)) continue
      const reasons = [...new Set(input.reasons.get(key) ?? [])]
      const reason = !planned.has(model.toLowerCase())
        ? `${model} is not audited in this run (see the warnings above)`
        : reasons.length > 0 ? reasons.join('; ') : 'the buyer sees no peer for this seller agent now'
      unaudited.push({ model, agentId: target.agentId, service: target.service, reason })
    }
  }
  return unaudited
}

export async function loadRunConfirmations(input: {
  config: AntseedConfig
  dataDir: string
  auditorFlag?: string
  epochWindow: AuditEpochWindow
  /** Models whose waiting reports this run may confirm. */
  models: readonly string[]
  /** Auditors approved at the epoch's start, when already loaded. */
  approvedAuditors?: readonly string[]
  now?: number
}): Promise<Map<string, Map<string, ConfirmationTarget>>> {
  if (input.epochWindow.source !== 'onchain' || input.models.length === 0) return new Map()
  let client: ReturnType<typeof createVerifierClient>
  try {
    client = createVerifierClient(input.config)
  } catch {
    return new Map()
  }
  try {
    const auditor = await resolveAuditorAddress({
      config: input.config.verifier, dataDir: input.dataDir, flag: input.auditorFlag,
    })
    const [auditors, events, required] = await Promise.all([
      input.approvedAuditors ?? loadApprovedAuditors(input.config, input.dataDir, input.epochWindow),
      loadEpochAuditEvents({ reader: client, epochStartedAt: input.epochWindow.startedAt, deploymentBlock: client.deploymentBlock }),
      client.requiredReports(),
    ])
    const revoked = await loadRevokedAuditors(input.config, input.dataDir, input.epochWindow)
    const reports = epochReports(events)
    if (required.DIFF > auditors.length) {
      console.warn(chalk.yellow(
        `A DIFF needs ${required.DIFF} auditors but only ${auditors.length} ${auditors.length === 1 ? 'is' : 'are'} approved; no DIFF can be recorded.`,
      ))
    }
    const blockTimestamps = await loadBlockTimestamps(
      { getBlock: (block) => client.provider.getBlock(block) }, waitingReportBlocks(reports),
    )
    const pending = await dropSettledConfirmations(pendingConfirmations({
      reports,
      epoch: input.epochWindow.epoch,
      blockTimestamps,
      revoked,
      now: input.now ?? Math.floor(Date.now() / 1_000),
      auditor: auditor.address,
      auditors,
      auditedModels: configuredVerifierModels(input.config.verifier),
      models: input.models,
    }), client, BigInt(input.epochWindow.epoch))
    if (pending.length > 0) {
      const mine = pending.filter((entry) => entry.mine).length
      console.log(chalk.cyan(`Reports waiting for a confirmation this epoch: ${pending.length}, ${mine} for this auditor`))
      for (const entry of pending) {
        const who = entry.mine ? 'for this auditor'
          : entry.disputed ? 'two auditors disagree, nobody else is asked'
            : entry.confirmer ? `confirmer ${entry.confirmer}` : 'every approved auditor has reported'
        console.log(chalk.cyan(`  ${entry.model}: agent ${entry.agentId} ${describeTallies(entry.waiting)} (${who})`))
      }
    }
    const targets = confirmationTargetsByModel(pending, (model) => verifierModelServices(input.config.verifier, model))
    // Confirmations of this auditor's that cannot become a target: one per seller and model is
    // audited per run, and only on a service the model's configuration names.
    for (const entry of pending) {
      if (!entry.mine) continue
      const target = targets.get(entry.model)?.get(entry.agentId.toString())
      if (target && normalized(serviceHash(target.service)) === normalized(entry.serviceHash)) continue
      console.log(chalk.yellow(
        `  ${entry.model}: agent ${entry.agentId} is not audited in this run: ${target
          ? `this seller's confirmation on ${target.service} is audited first; this one waits for a later run`
          : `the reported service is not one of the names configured for ${entry.model}`}`,
      ))
    }
    // When this auditor reported on a seller in a round the contract no longer counts, a local
    // result only answers the confirmation if it is newer than that report.
    const ownReports = ownLatestReports(events, auditor.address)
    // Results submitted together share a block, so each block is read once.
    const timestamps = new Map(blockTimestamps)
    for (const [model, agents] of targets) {
      for (const target of agents.values()) {
        const block = ownReports.get(reportKey(target.agentId, serviceHash(target.service), modelHash(model)))?.blockNumber
        if (block === undefined) continue
        let timestamp = timestamps.get(block)
        if (timestamp === undefined) {
          const header = await client.provider.getBlock(block)
          if (!header) throw new Error(`block ${block} of an earlier report is unavailable`)
          timestamp = header.timestamp
          timestamps.set(block, timestamp)
        }
        target.ownReportedAt = timestamp
      }
    }
    return targets
  } catch (error) {
    console.warn(chalk.yellow(`Could not read reports waiting for a confirmation: ${asError(error).message}`))
    return new Map()
  }
}

export function printAuditAssignment(
  assignment: AuditAssignment,
  context: { auditorSource?: string; approvedAuditors: readonly string[]; availableModels: readonly string[] },
): void {
  const from = context.auditorSource ? ` (from ${context.auditorSource})` : ''
  console.log(`Assigned models for ${assignment.auditor}${from}, epoch ${assignment.epoch}: ${assignment.models.join(', ') || 'none'}`)
  const confirms = confirmationAssignments({
    auditors: context.approvedAuditors, epoch: assignment.epoch, availableModels: context.availableModels,
  }).get(assignment.auditor) ?? []
  console.log(`Confirms DIFFs on: ${confirms.join(', ') || 'none'} (audits sellers whose DIFF on these models waits for a second auditor)`)
  console.log(chalk.dim(
    `  round robin: every model is audited every epoch, split across ${context.approvedAuditors.length} approved auditor(s); `
    + `${context.availableModels.length} model(s), model list ${auditModelListHash(context.availableModels).slice(0, 10)}. `
    + 'See every auditor\'s model with `antseed verifier assignment`.',
  ))
}

export function validateAssignedModeOptions(modelValue: string | undefined, options: RunOptions): void {
  if (!options.auditor) return
  if (modelValue?.trim() || options.all) throw new Error('--auditor runs the assigned models; do not combine it with <model> or --all')
  if (options.resumeRun) throw new Error('--auditor cannot be combined with --resume-run')
}

/**
 * Without `<model>`, `--all` or `--resume-run`, `verifier run` audits the models assigned to the
 * auditor (`--auditor`, `verifier.auditor`, `verifier.keystore`, or the data-dir identity).
 */
export function isAssignedMode(modelValue: string | undefined, options: RunOptions): boolean {
  return Boolean(options.auditor) || (!modelValue?.trim() && !options.all && !options.resumeRun)
}

export interface ResumeCandidate {
  model: string
  peerId: string
  service: string
  auditId: string
  reservationAuditId: string
  evidencePath: string
  evidenceHash: string
  referenceId: string
  queryProfileHash: string
  probeIds: string[]
  exchanges: ProxyAuditEvidenceV1['exchanges']
}

export function normalizeVerifierPeerId(value: string): string {
  const normalized = value.trim().replace(/^0x/i, '').toLowerCase()
  if (!/^[0-9a-f]{40}$/.test(normalized)) {
    throw new Error('peer id must be exactly 40 hexadecimal characters, optionally prefixed with 0x')
  }
  return normalized
}

export function selectVerifierPeer<T extends { peerId: string }>(peers: readonly T[], peerId: string): T {
  const selected = peers.find((peer) => peer.peerId.trim().replace(/^0x/i, '').toLowerCase() === peerId)
  if (!selected) {
    throw new Error(`peer ${peerId} is not present in the buyer proxy's live discovered-peer snapshot`)
  }
  return selected
}

export function filterResumeCandidatesByPeer(
  candidates: ReadonlyMap<string, ResumeCandidate>,
  peerId: string,
): Map<string, ResumeCandidate> {
  return new Map([...candidates].filter(([, candidate]) => (
    candidate.peerId.trim().replace(/^0x/i, '').toLowerCase() === peerId
  )))
}

export function registerVerifierRunCommand(verifier: Command): void {
  const run = verifier
    .command('run [model]')
    .description('Verify live peers for the models assigned to this auditor this epoch (the default), one audited model, or every audited model')
    .option('--all', 'verify every audited model instead of the assigned ones')
    .option('--auditor <address>', 'auditor address to assign models for (default: verifier.auditor, verifier.keystore, or the data-dir identity)')
    .option('--peer <peerId>', 'verify only this discovered seller peer')
    .option('--resume-run <runId>', 'repair only undetermined sellers from a compatible run')
    .option('--fresh', 'ignore this epoch\'s earlier runs and audit every eligible seller again')
    .option('--skip-version-check', 'run even if the latest release audits differently from this CLI (its results may not match other auditors)')
  for (const option of RUN_TUNING_OPTIONS) run.option(option.flags, option.description)
  run
    .action(async (modelValue: string | undefined, options: RunOptions, command: Command) => {
      validateAssignedModeOptions(modelValue, options)
      const last = await runVerifierRounds(
        maxRunRounds(options),
        (round) => runVerifierRound(modelValue, round === 1 ? options : { ...options, fresh: false }, command),
      )
      // A build that failed in an early round but succeeded later does not fail the command.
      if ((last?.enrollmentFailures?.size ?? 0) > 0) process.exitCode = 1
      console.log(`Next: antseed verifier submit`)
    })
}

/**
 * Runs up to `maxRounds` rounds. After a round, what is left (failed audits, close calls and
 * models whose fresh-question build failed) is retried in the next round, which re-plans every model
 * and gets another enrollment budget, so a build that ran out of requests or hit a network error
 * continues from its checkpoint. Stops early when nothing is left, a round makes no progress, or the
 * epoch is nearly over.
 */
export async function runVerifierRounds(
  maxRounds: number,
  runRound: (round: number) => Promise<VerifierRoundOutcome>,
  log: (line: string) => void = (line) => console.log(line),
): Promise<VerifierRoundOutcome | null> {
  let previousLeft: number | null = null
  let replannedForNewEpoch = false
  let last: VerifierRoundOutcome | null = null
  for (let round = 1; round <= maxRounds; round += 1) {
    if (round > 1) log(chalk.cyan(`\nRound ${round} of ${maxRounds}: retrying what is left this epoch`))
    // Later rounds continue from the epoch (never --fresh); each round's builds get another
    // enrollment budget, so a bank build that ran out of requests can finish from its checkpoint.
    const outcome = await runRound(round)
    if (outcome.epochChanged) {
      // The round was planned for the previous epoch (assignment, finished sellers, close calls).
      // Models it audited before the change keep their evidence; plan the rest again for the new
      // epoch, once, without using up a round.
      if (replannedForNewEpoch) {
        log(chalk.yellow('The epoch changed again; run `antseed verifier run` again.'))
        break
      }
      replannedForNewEpoch = true
      previousLeft = null
      log(chalk.cyan(`\nThe epoch changed to ${outcome.epochChanged} while fresh questions were built; planning the run again for the new epoch`))
      round -= 1
      continue
    }
    last = outcome
    if (outcome.left === 0) break
    if (round === maxRounds) {
      log(chalk.yellow(`${outcome.left} audit(s), close call(s) or question build(s) still left after ${maxRounds} round(s); run \`antseed verifier run\` again later this epoch to retry them.`))
      break
    }
    if (previousLeft !== null && outcome.left >= previousLeft) {
      log(chalk.yellow(`Round ${round} made no progress (${outcome.left} left); stopping. Run again later this epoch to retry.`))
      break
    }
    if (outcome.secondsLeftInEpoch < MIN_SECONDS_FOR_ANOTHER_ROUND) {
      log(chalk.yellow(`Less than ${MIN_SECONDS_FOR_ANOTHER_ROUND / 60} minutes left in the epoch; stopping so there is time to submit.`))
      break
    }
    previousLeft = outcome.left
  }
  const failedBuilds = [...(last?.enrollmentFailures ?? new Map<string, string>())]
  if (failedBuilds.length > 0) {
    log(chalk.yellow(`Not audited this run (${failedBuilds.length}):`))
    for (const [model, reason] of failedBuilds) log(chalk.yellow(`  - ${model}: ${reason}`))
  }
  return last
}

/** No new round starts (and no audit window opens) with less than this left in the epoch, so there is time to submit. */
export { MIN_SECONDS_FOR_ANOTHER_ROUND }

export function maxRunRounds(options: RunOptions): number {
  if (options.resumeRun) return 1
  const rounds = Number(options.maxRounds ?? String(DEFAULT_MAX_ROUNDS))
  if (!Number.isSafeInteger(rounds) || rounds <= 0) throw new Error('--max-rounds must be a positive integer')
  return rounds
}

export interface VerifierRoundOutcome {
  /** Audits, close calls and question builds a later round can retry. */
  left: number
  secondsLeftInEpoch: number
  /** Set to the new epoch when it started during a build. Models audited before that keep their evidence. */
  epochChanged?: string
  /** Models that could not be audited this round, usually a failed build, with the reason; retried next round. */
  enrollmentFailures?: Map<string, string>
}

/** The part of a model's plan that the run status counts. */
type StatusPlan = { targets: readonly unknown[]; skipped: readonly ModelVerificationSkip[] }

/** One pass over the epoch's remaining work. Returns how much is still left to retry. */
export async function runVerifierRound(
  modelValue: string | undefined,
  options: RunOptions,
  command: Command,
): Promise<VerifierRoundOutcome> {
      // Per build and round: an unfinished build continues from its checkpoint with another budget,
      // up to its total (see `buildRequestLimits`).
      const enrollmentBudget = enrollmentRequestBudget(options)
      const globalOptions = getGlobalOptions(command)
      const config = await loadConfig(globalOptions.config)
      // An outdated CLI would audit other models, or score them differently, from other auditors.
      await requireCurrentVerifier({
        command: 'run',
        currentVersion: pkg.version,
        skip: options.skipVersionCheck === true,
        strictWhenUnavailable: false,
        warn: (text) => console.warn(chalk.yellow(text)),
      })
      const ruleOverrides = verifierRuleOverrides(config.verifier)
      if (ruleOverrides.length > 0) {
        const text = `this config audits differently from other auditors on the same compat: ${ruleOverrides.join('; ')}`
        if (options.skipVersionCheck !== true) throw new Error(`${text}. Remove these settings, or pass --skip-version-check for a test.`)
        console.warn(chalk.yellow(`Skipping the rule check (--skip-version-check): ${text}.`))
      }
      if (config.verifier?.testModels) {
        console.warn(chalk.yellow(
          `verifier.testModels is set: auditing only ${configuredVerifierModels(config.verifier).join(', ')}. For testing only; other auditors must use the same list.`,
        ))
      }
      const resolveEpoch = async (): Promise<AuditEpochWindow> => {
        const resolved = await resolveAuditEpochWindow(() => auditEpochReader(config))
        if (resolved.warning) console.warn(chalk.yellow(resolved.warning))
        return resolved.window
      }
      const epochWindow = await resolveEpoch()
      const clock = chainClock(config)
      let assignedModels: string[] | null = null
      let approvedAuditors: string[] | undefined
      if (isAssignedMode(modelValue, options)) {
        const auditor = await resolveAuditorAddress({
          config: config.verifier, dataDir: globalOptions.dataDir, flag: options.auditor,
        })
        approvedAuditors = await loadApprovedAuditors(config, globalOptions.dataDir, epochWindow)
        const assignment = resolveAssignedAuditModels(config, auditor.address, epochWindow, approvedAuditors)
        printAuditAssignment(assignment, {
          auditorSource: describeAuditorSource(auditor.source),
          approvedAuditors,
          availableModels: configuredVerifierModels(config.verifier),
        })
        // Liveness: models whose auditor is absent this epoch are audited by a stand-in from halfway on.
        const handovers = await loadRunHandovers({
          config, dataDir: globalOptions.dataDir, auditor: auditor.address, epochWindow, approvedAuditors, now: await clock(),
        })
        for (const entry of handovers) console.log(chalk.cyan(`Stand-in: ${describeHandover(entry)}`))
        const own = new Set(assignment.models.map((model) => model.toLowerCase()))
        assignedModels = [...assignment.models, ...handovers.map((entry) => entry.model).filter((model) => !own.has(model.toLowerCase()))]
      }
      const selectedPeerId = options.peer ? normalizeVerifierPeerId(options.peer) : null
      const banksDir = config.verifier?.banksDir ?? join(globalOptions.dataDir, 'verifier', 'banks')
      const evidenceDir = config.verifier?.evidenceDir ?? join(globalOptions.dataDir, 'verifier', 'evidence')
      const requestedResumeManifest = options.resumeRun
        ? await readVerifierRunManifest(evidenceDir, options.resumeRun)
        : null
      const requestedModels = assignedModels ?? resolveRunModels(config.verifier, modelValue, options.all === true, requestedResumeManifest)
      if (assignedModels) {
        // A stand-in keeps a model while its audit window is open, also after the 75 % stage names the
        // next stand-in: its sellers' retries finish and the window is submitted instead of stranded.
        for (const window of await listAuditWindows(evidenceDir, epochWindow.epoch)) {
          if (window.state !== 'open' || requestedModels.some((model) => model.toLowerCase() === window.model.toLowerCase())) continue
          requestedModels.push(window.model)
          console.log(chalk.cyan(`Keeping ${window.model}: its audit window from an earlier hand-over is still open`))
        }
      }
      // Never a third opinion (third-opinion.ts): a seller another auditor has already judged this epoch
      // is not audited again, unless the planner makes it a confirmation. Read once per run.
      let othersOpinions: ReadonlyMap<string, ReadonlyMap<string, OtherOpinion>> = new Map()
      if (epochWindow.source === 'onchain' && !requestedResumeManifest) {
        try {
          const client = createVerifierClient(config)
          const me = (await resolveAuditorAddress({ config: config.verifier, dataDir: globalOptions.dataDir, flag: options.auditor })).address
          const events = await loadEpochAuditEvents({ reader: client, epochStartedAt: epochWindow.startedAt, deploymentBlock: client.deploymentBlock })
          othersOpinions = otherOpinions(events, me)
        } catch (error) {
          console.warn(chalk.yellow(`Could not read other auditors' reports this epoch: ${asError(error).message}`))
        }
      }
      const judgedByOthers = new Map<string, number>()
      // Verdicts other auditors reported this epoch that still need more auditors: their sellers
      // are audited here too, as the same model, on this auditor's own probes.
      const confirmations = requestedResumeManifest || options.confirm === false
        ? new Map<string, Map<string, ConfirmationTarget>>()
        : await loadRunConfirmations({
          config, dataDir: globalOptions.dataDir, auditorFlag: options.auditor, epochWindow, approvedAuditors, now: await clock(),
          // An explicit model run confirms only that model's reports; the assigned run confirms
          // every audited model's it is responsible for.
          models: assignedModels ? configuredVerifierModels(config.verifier) : requestedModels,
        })
      // Models outside this run's own models are audited only for the sellers awaiting a confirmation.
      const confirmationOnly = new Map<string, Map<string, ConfirmationTarget>>([...confirmations].filter(([model]) => (
        !requestedModels.some((entry) => entry.toLowerCase() === model.toLowerCase())
      )))
      const models = [...requestedModels, ...confirmationOnly.keys()]
      if (models.length === 0) {
        console.log('No model is assigned to this auditor this epoch (more approved auditors than models) and no report waits for a confirmation; nothing to audit.')
        return { left: 0, secondsLeftInEpoch: Infinity }
      }
      const confirmationFor = (model: string, peer: { onChainAgentId?: number | bigint | string | null }) => (
        peer.onChainAgentId != null ? confirmations.get(model)?.get(String(peer.onChainAgentId)) : undefined
      )
      // Audit windows (`audit-window.ts`): a model's first run this epoch opens its window and fixes its
      // sellers; later runs only finish those sellers, and a closed window audits nobody new. Only
      // confirmations are audited outside windows. No window opens late in the epoch, and a build or
      // a wait for an audit slot can run into that time, so each lane reads the clock again.
      const windowsOpenable = !options.peer && !options.resumeRun
      const pastCutoff = async (): Promise<boolean> => epochWindow.endsAt - await clock() < MIN_SECONDS_FOR_ANOTHER_ROUND
      let lateInEpoch = await pastCutoff()
      const readLateInEpoch = async (): Promise<boolean> => {
        if (await pastCutoff()) lateInEpoch = true
        return lateInEpoch
      }
      const auditWindows = new Map<string, AuditWindowV1 | null>()
      const auditsPeer = (model: string, peer: { peerId: string; onChainAgentId?: number | bigint | string | null }): boolean => {
        if (confirmationFor(model, peer) !== undefined) return true
        if (confirmationOnly.has(model)) return false
        const window = auditWindows.get(model)
        if (window) return window.state === 'open' && windowIncludesSeller(window, peer.peerId)
        return !lateInEpoch
      }
      const runLock = await acquirePidFileLock(join(evidenceDir, '.run.lock'))
      let responseAuthReader: Awaited<ReturnType<typeof openResponseAuthReader>> | null = null
      let status: VerifierStatusV1 | null = null
      let runProgress: VerifierRunProgress | null = null
      const enrollmentFailures = new Map<string, string>()
      try {
        const epoch = epochWindow.epoch
        if (requestedResumeManifest && requestedResumeManifest.epoch !== epoch) {
          throw new Error(
            `resume run ${requestedResumeManifest.runId} belongs to epoch ${requestedResumeManifest.epoch}; current epoch is ${epoch}`,
          )
        }
        // Windows close here, after a look at the buyer's peers: a seller that stopped listing a model
        // must not hold its window, and one that came back must be seen before its window closes.
        // A buyer that can't be read decides nothing, and fails the run further down.
        const peerList = await loadBuyerProxySnapshot(globalOptions.dataDir).catch(() => null)
        if (peerList) {
          await updateRetryGiveUps({
            evidenceDir, epoch, peers: peerList.peers,
            servicesFor: (cell, peer) => {
              const confirmation = confirmationFor(cell.model, peer)
              return [
                ...verifierModelServices(config.verifier, cell.model),
                ...(cell.result ? [cell.result.service] : []),
                ...(confirmation ? [confirmation.service] : []),
              ]
            },
          })
        }
        await closeFinishedAuditWindows({
          evidenceDir, epoch,
          state: await loadEpochState(evidenceDir, epoch),
          secondsLeftInEpoch: epochWindow.endsAt - await clock(),
        })
        for (const model of models) {
          if (!confirmationOnly.has(model)) auditWindows.set(model, await readAuditWindow(evidenceDir, epoch, model))
        }
        if (lateInEpoch && [...auditWindows.values()].some((window) => window === null)) {
          console.log(chalk.yellow(
            `Less than ${MIN_SECONDS_FOR_ANOTHER_ROUND / 60} minutes left in the epoch: models not audited yet this epoch wait for the next one.`,
          ))
        }
        // Everything this epoch's earlier runs settled: finished sellers are skipped, the rest are
        // retried, extended or audited for the first time. `--fresh` and `--resume-run` ignore it.
        const epochState: EpochState | null = options.fresh || requestedResumeManifest
          ? null
          : await loadEpochState(evidenceDir, epoch)
        const epochCellFor = (model: string, peerId: string): EpochCell | undefined =>
          epochState?.cells.get(epochCellKey(model, peerId))
        const isDone = (model: string, peerId: string): boolean => epochCellFor(model, peerId)?.action === 'done'
        // A seller this epoch already finished is audited again when a confirmation assigned to this
        // auditor is still open for it: its finished result is for another service, or it was
        // submitted in a report round the contract no longer counts.
        const openConfirmationFor = (model: string, peer: PeerInfo): ConfirmationTarget | undefined => {
          const confirmation = confirmationFor(model, peer)
          if (!confirmation) return undefined
          const cell = epochCellFor(model, peer.peerId)
          const completedAt = cell?.result
            ? epochState?.manifests.find((manifest) => manifest.runId === cell.runId)?.completedAt
            : undefined
          const local = cell?.result && completedAt
            ? { service: cell.result.service, completedAt: Date.parse(completedAt) / 1_000 }
            : null
          return localResultAnswersConfirmation(confirmation, local) ? undefined : confirmation
        }
        // When a confirmation's UNDETERMINED held for another audit may be audited again, or null when
        // the seller has none: attempts are spaced, so one seller outage does not use them all up.
        const confirmationRecheckDueAt = (model: string, peer: PeerInfo): number | null => {
          const cell = epochCellFor(model, peer.peerId)
          if (!cell || !heldForConfirmationRecheck(cell)) return null
          const completedAt = epochState?.manifests.find((manifest) => manifest.runId === cell.runId)?.completedAt
          return completedAt ? Date.parse(completedAt) / 1_000 + CONFIRMATION_RECHECK_SPACING_SECONDS : null
        }
        const finished = (model: string, peer: PeerInfo): boolean => (
          isDone(model, peer.peerId) && openConfirmationFor(model, peer) === undefined
        )
        // The service names a seller is audited under. A confirmation is only answered by a report on
        // the service it waits on: confirmation-only work and the re-audit of a finished seller try
        // that service alone, and stay waiting when it is not eligible.
        const targetServicesFor = (model: string, peer: PeerInfo, resumeService?: string): string[] => {
          const configured = verifierModelServices(config.verifier, model)
          if (resumeService) return [resumeService.toLowerCase(), ...configured]
          const confirmation = openConfirmationFor(model, peer)
          if (!confirmation) return configured
          if (confirmationOnly.has(model) || isDone(model, peer.peerId)) return [confirmation.service]
          return [confirmation.service, ...configured]
        }
        // A run that stopped before writing its manifest left checkpoints; their exchanges are reused
        // (not with --fresh, which audits every seller again).
        const previousStatus = requestedResumeManifest || options.fresh ? null : await readVerifierStatus(evidenceDir)
        const interruptedRunId = previousStatus?.epoch === epoch
          && !(epochState?.manifests ?? []).some((manifest) => manifest.runId === previousStatus.runId)
          && !(await readVerifierRunManifest(evidenceDir, previousStatus.runId).then(() => true, () => false))
          ? previousStatus.runId
          : null
        const discoveredResumeCandidates = requestedResumeManifest
          ? await loadResumeCandidates(requestedResumeManifest, models)
          : new Map<string, ResumeCandidate>([
            ...(interruptedRunId
              ? await loadCheckpointResumeCandidates(evidenceDir, interruptedRunId, epoch, models)
              : new Map<string, ResumeCandidate>()),
            ...(epochState ? await loadEpochRetryCandidates(epochState, models) : new Map<string, ResumeCandidate>()),
          ])
        const selectedResumeCandidates = selectedPeerId
          ? filterResumeCandidatesByPeer(discoveredResumeCandidates, selectedPeerId)
          : discoveredResumeCandidates
        const resumeCandidates = requestedResumeManifest
          ? await filterCompatibleResumeCandidates({
            candidates: selectedResumeCandidates, banksDir, config: config.verifier, epoch, strict: true,
          })
          : await keepCompatibleResumeCandidates({
            candidates: selectedResumeCandidates, banksDir, config: config.verifier, epoch,
          })
        const resumeSourceRunId = requestedResumeManifest?.runId ?? null
        // Only an explicit --resume-run limits the run to repairs.
        const resumeOnly = resumeSourceRunId !== null
        // Close calls whose extra questions could not be asked in earlier runs this epoch: finished
        // here without repeating the first check. --fresh audits those sellers from the start instead.
        const pendingExtensions = !options.fresh && (config.verifier?.closeCallExtensions ?? 2) > 0
          ? await loadPendingExtensions(evidenceDir, epoch, models)
          : new Map()
        if (selectedPeerId) {
          for (const [key, entry] of pendingExtensions) {
            if (entry.result.peerId.trim().replace(/^0x/i, '').toLowerCase() !== selectedPeerId) pendingExtensions.delete(key)
          }
        }
        let runModels = resumeOnly
          ? models.filter((model) => [...resumeCandidates.values(), ...pendingExtensions.values()]
            .some((candidate) => candidate.model.toLowerCase() === model.toLowerCase()))
          : models
        if (resumeOnly && runModels.length === 0) {
          const peerSuffix = selectedPeerId ? ` and peer ${selectedPeerId}` : ''
          throw new Error(`resume run ${resumeSourceRunId} has no undetermined audits for the selected models${peerSuffix}`)
        }
        const proxy = peerList ?? await loadBuyerProxySnapshot(globalOptions.dataDir)
        // The limits the running buyer enforces; a buyer from an older build doesn't record them,
        // so this config's buyer settings stand in.
        const configBuyer = resolveEffectiveBuyerConfig({ config })
        const buyerLimits = {
          minPeerReputation: proxy.settings?.minPeerReputation ?? configBuyer.minPeerReputation,
          maxPricing: proxy.settings?.maxPricing ?? configBuyer.maxPricing.defaults,
          reported: proxy.settings?.maxPricing != null,
        }
        const selectedPeers = selectedPeerId
          ? [selectVerifierPeer(proxy.peers, selectedPeerId)]
          : proxy.peers
        // Each audited model is audited only at or below its genuine price: the highest price any
        // OpenRouter provider charges for it. Sellers above it are skipped here, so they never get a request.
        const priceCaps = await resolveAuditPriceCaps(
          config.verifier, runModels, () => loadVerifierModelCatalog(config.verifier),
          (upstreamModel) => loadHighestEndpointPrice(config.verifier, upstreamModel),
        )
        for (const [model, reason] of priceCaps.unpriced) {
          console.warn(chalk.yellow(`SKIPPED ${model}: ${reason}`))
          process.exitCode = 1
        }
        runModels = runModels.filter((model) => priceCaps.caps.has(model))
        if (runModels.length === 0) throw new Error('no audited model has a reference price; see the warnings above')
        // Audit requests go through the running buyer, which refuses sellers above its own cap.
        // Its caps must be at or above every audited model's reference price, or sellers the audit
        // allows would be refused and end UNDETERMINED on our side: stop before any request.
        const buyerCapShortfalls = runModels.flatMap((model) => {
          const shortfall = buyerCapShortfall(buyerLimits.maxPricing, priceCaps.caps.get(model)!)
          return shortfall ? [shortfall] : []
        })
        if (buyerCapShortfalls.length > 0) {
          const needed = requiredBuyerCap(runModels.map((model) => priceCaps.caps.get(model)!))
          throw new Error(
            `the ${buyerLimits.reported ? 'running' : 'configured'} buyer would refuse sellers priced at or below the reference:\n`
            + buyerCapShortfalls.map((line) => `  - ${line}`).join('\n')
            + `\nSet buyer.maxPricing.defaults to at least input ${needed.input}, output ${needed.output}`
            + ' (and cachedInputUsdPerMillion, if set, to at least the input value) and restart the buyer.',
          )
        }
        const targetPolicyFor = (model: string): VerificationTargetPolicy => ({
          minReputation: buyerLimits.minPeerReputation,
          priceCap: priceCaps.caps.get(model)!,
        })
        if (selectedPeerId && !resumeOnly) {
          const advertisedModels = runModels.filter((model) => {
            const eligibility = classifyVerificationTargetServices(
              selectedPeers[0]!,
              verifierModelServices(config.verifier, model),
              targetPolicyFor(model),
            )
            return eligibility.eligible || eligibility.code !== 'model_not_advertised'
          })
          if (options.all || assignedModels) {
            runModels = advertisedModels
            if (runModels.length === 0) {
              throw new Error(`peer ${selectedPeerId} does not advertise any audited model`)
            }
          } else if (advertisedModels.length === 0) {
            throw new Error(`peer ${selectedPeerId} does not advertise model ${runModels[0]}`)
          }
        }
        if (enrollmentBudget !== null && resumeOnly) {
          throw new Error('an audit resume is pending; complete it before enrolling new probes')
        }
        responseAuthReader = await openResponseAuthReader({
          dataDir: globalOptions.dataDir,
          timeoutMs: config.verifier?.responseAuthWaitTimeoutMs,
        })
        const startedAtMs = Date.now()
        const runId = canonicalHashBytes32({
          domain: 'antseed-verifier-epoch-run-v1',
          epoch,
          models: runModels.map((model) => model.toLowerCase()),
          peerIds: selectedPeerId ? [selectedPeerId] : undefined,
          buyerProxy: proxy.baseUrl,
          startedAt: startedAtMs,
        })
        // Confirmations assigned to this auditor: which got a target (or are already answered by a
        // result this epoch), and why each of the seller's other peers did not.
        const auditedConfirmations = new Set<string>()
        const confirmationSkipReasons = new Map<string, string[]>()
        const planModel = (model: string, peers: readonly PeerInfo[]) => {
          let doneCount = 0
          const skipped: ModelVerificationSkip[] = []
          const targets = peers.flatMap((peer) => {
            if (!auditsPeer(model, peer)) return []
            const confirmationKey = confirmationFor(model, peer) ? confirmationPlanKey(model, String(peer.onChainAgentId)) : null
            const notAudited = (reason: string): void => {
              if (confirmationKey) confirmationSkipReasons.set(confirmationKey, [...confirmationSkipReasons.get(confirmationKey) ?? [], reason])
            }
            const resumeCandidate = resumeCandidates.get(resumeKey(model, peer.peerId))
            const pendingExtension = pendingExtensions.get(pendingExtensionKey(model, peer.peerId))
            if (!confirmationKey && peer.onChainAgentId != null) {
              const judged = alreadyJudgedByOther(othersOpinions, peer.onChainAgentId, targetServicesFor(model, peer, resumeCandidate?.service), model)
              if (judged) {
                doneCount += 1
                judgedByOthers.set(model, (judgedByOthers.get(model) ?? 0) + 1)
                return []
              }
            }
            if (resumeOnly && !resumeCandidate && !pendingExtension) return []
            const recheckDueAt = confirmationRecheckDueAt(model, peer)
            if (recheckDueAt !== null && recheckDueAt > Date.now() / 1_000) {
              // A confirmation's held UNDETERMINED: audited again only once its spacing has passed.
              doneCount += 1
              notAudited(`its UNDETERMINED (attempt ${epochCellFor(model, peer.peerId)!.attempts} of ${CONFIRMATION_ATTEMPTS}) `
                + `is audited again from ${new Date(recheckDueAt * 1_000).toISOString()}`)
              return []
            }
            // A seller's one retry waits instead of failing again in the same outage, also
            // when it resumes automatically from this epoch's retry cell. Only --resume-run skips it.
            const retryDueAt = sellerRetryWaitUntil(epochCellFor(model, peer.peerId), Date.now() / 1_000, resumeOnly)
            if (retryDueAt !== null) {
              doneCount += 1
              notAudited(`its failed audit is retried from ${new Date(retryDueAt * 1_000).toISOString()}`)
              return []
            }
            if (!pendingExtension && finished(model, peer)) {
              doneCount += 1
              if (confirmationKey) auditedConfirmations.add(confirmationKey)
              return []
            }
            const services = targetServicesFor(model, peer, resumeCandidate?.service)
            const eligibility = classifyVerificationTargetServices(peer, services, targetPolicyFor(model))
            if (eligibility.eligible) {
              if (confirmationKey) auditedConfirmations.add(confirmationKey)
              const resumable = resumeCandidate
                && resumeCandidate.service.toLowerCase() === eligibility.service.toLowerCase()
              const carried = pendingExtension
                && pendingExtension.result.service.toLowerCase() === eligibility.service.toLowerCase()
              return [{
                peer,
                service: eligibility.service,
                resumeCandidate: resumable ? resumeCandidate : undefined,
                pendingExtension: carried ? pendingExtension : undefined,
              }]
            }
            if (eligibility.code !== 'model_not_advertised') {
              const policySkip = eligibility.code !== 'missing_response_auth'
              const priceSkip = eligibility.code === 'price_above_reference'
              skipped.push({
                peerId: peer.peerId,
                displayName: peer.displayName ?? null,
                agentId: peer.onChainAgentId ? String(peer.onChainAgentId) : null,
                service: eligibility.service,
                status: 'SKIPPED',
                code: eligibility.code,
                reason: eligibility.reason,
                outcomeReason: {
                  code: eligibility.code,
                  summary: eligibility.reason,
                  retryable: false,
                  source: policySkip ? 'policy' : 'response_auth',
                  affectedBatchCount: 0,
                  totalBatchCount: 0,
                  nextAction: priceSkip
                    ? 'seller must price at or below the reference'
                    : policySkip ? 'adjust buyer routing policy' : 'inspect verifier evidence',
                },
                source: 'preflight',
                auditId: null,
                evidencePath: null,
                evidenceHash: null,
              })
            }
            notAudited(eligibility.code === 'model_not_advertised'
              ? `peer ${peer.peerId.slice(0, 12)}… no longer advertises ${services.join(' or ')}`
              : `peer ${peer.peerId.slice(0, 12)}… is skipped: ${eligibility.reason}`)
            return []
          })
          return { model, skipped, targets, doneCount }
        }
        const plannedModels = runModels.map((model) => planModel(model, selectedPeers))
        // A confirmation that gets no audit stays waiting; say why instead of dropping it silently.
        if (!resumeOnly) {
          // A --peer run only answers for the selected seller's confirmations.
          const relevant = selectedPeerId
            ? new Map([...confirmations].map(([model, agents]) => [model, new Map([...agents].filter(([agentId]) => (
              selectedPeers.some((peer) => String(peer.onChainAgentId) === agentId)
            )))]))
            : confirmations
          const unaudited = unauditedConfirmations({
            confirmations: relevant,
            plannedModels: runModels,
            audited: auditedConfirmations,
            reasons: confirmationSkipReasons,
          })
          const total = [...relevant.values()].reduce((sum, agents) => sum + agents.size, 0)
          if (total > 0) {
            console.log(chalk.cyan(
              `Confirmations for this auditor: ${total - unaudited.length} audited now (or answered by an earlier result this epoch), `
              + `${unaudited.length} cannot be audited now`,
            ))
          }
          for (const entry of unaudited) {
            console.log(chalk.yellow(
              `  ${entry.model}: agent ${entry.agentId} (${entry.service}) stays waiting: ${entry.reason}`,
            ))
          }
        }
        // A model whose sellers are all finished this epoch has nothing left to run.
        const hasWorkLeft = (entry: { targets: unknown[]; skipped: unknown[]; doneCount: number }): boolean => (
          entry.targets.length + entry.skipped.length > 0 || entry.doneCount === 0
        )
        const preparedModels = plannedModels
          .filter(hasWorkLeft)
          .map(({ model, skipped, targets }) => ({ model, skipped, targets }))
        runModels = preparedModels.map((entry) => entry.model)
        if (epochState) {
          printEpochPlan(epoch, epochState, plannedModels, resumeCandidates)
        }
        if (preparedModels.every((entry) => entry.targets.length === 0)) {
          if (epochState && epochState.manifests.length > 0) {
            printEpochTable(epoch, await loadEpochState(evidenceDir, epoch), runModels.length > 0 ? runModels : models)
            console.log(chalk.green(`Epoch ${epoch}: nothing left to audit (sellers still skipped are listed above).`))
            console.log(`Next: antseed verifier submit`)
            return { left: 0, secondsLeftInEpoch: epochWindow.endsAt - await clock() }
          }
        }
        if (selectedPeerId && preparedModels.every((entry) => entry.targets.length + entry.skipped.length === 0)) {
          throw new Error(`peer ${selectedPeerId} does not currently advertise any selected verifier model`)
        }
        // Problems on the auditor's side stop the run here, before any request is paid for.
        const preRunProblems = await collectPreRunProblems({
          config,
          dataDir: globalOptions.dataDir,
          banksDir,
          epoch,
          epochSource: epochWindow.source,
          reserveUsdc: proxy.settings?.maxReserveAmountUsdc ?? null,
          models: preparedModels.map(({ model, targets }) => ({ model, sellerPeerIds: targets.map((target) => target.peer.peerId) })),
          checkQuestionSets: false,
        })
        if (preRunProblems.length > 0) {
          if (!options.ignorePreRunChecks) throw preRunError(preRunProblems)
          console.log(chalk.yellow(`Ignoring ${preRunProblems.length} pre-run problem(s) (--ignore-pre-run-checks):`))
          for (const problem of preRunProblems) console.log(chalk.yellow(`  - ${problem}`))
        }
        status = {
          version: 1,
          kind: 'antseed-verifier-status',
          state: 'running',
          runId,
          epoch,
          startedAt: new Date(startedAtMs).toISOString(),
          completedAt: null,
          epochStartedAt: epochTimestamp(epochWindow.startedAt),
          epochEndsAt: epochTimestamp(epochWindow.endsAt),
          currentModel: null,
          currentPeerId: null,
          activeAudits: [],
          queuedAudits: preparedModels.reduce((total, model) => total + model.targets.length, 0),
          modelsCompleted: 0,
          modelsTotal: runModels.length,
          auditsCompleted: 0,
          skipped: preparedModels.reduce((total, model) => total + model.skipped.length, 0),
          failures: 0,
          cost: emptyAuditCostSummary(),
          reasonCounts: countOutcomeReasons([], [], preparedModels.flatMap((entry) => entry.skipped)),
          message: 'starting verifier run',
        }
        await writeVerifierStatus(evidenceDir, status)
        await appendVerifierEvent(evidenceDir, epoch, {
          type: 'run-started', runId, epoch, models: runModels,
          resumedFromRunId: resumeSourceRunId,
          at: status.startedAt,
        })

        console.log(chalk.dim(`Epoch: ${epoch} (${status.epochStartedAt} – ${status.epochEndsAt})`))
        console.log(chalk.dim(`Epoch source: ${epochWindow.source}`))
        console.log(chalk.dim(`Buyer proxy: ${proxy.baseUrl} (pid ${proxy.pid})`))
        if (selectedPeerId) console.log(chalk.dim(`Peer selector: ${selectedPeerId}`))
        console.log(chalk.dim('Evidence: verified ResponseAuth required for every successful batch'))
        console.log(chalk.dim(`Eligibility: reputation >= ${buyerLimits.minPeerReputation}; price at or below the reference:`))
        for (const model of runModels) console.log(chalk.dim(`  ${describeAuditPriceCap(priceCaps.caps.get(model)!)}`))
        if (resumeSourceRunId) {
          console.log(chalk.dim(`Resume source: ${resumeSourceRunId} (${resumeCandidates.size} unresolved audit(s))`))
        }
        const pendingExtensionCount = pendingExtensions.size
        if (pendingExtensionCount > 0) {
          console.log(chalk.cyan(
            `Close calls waiting for extra questions from earlier runs this epoch: ${pendingExtensionCount}; asking them now`,
          ))
        }

        const maxConcurrentModels = config.verifier?.auditMaxConcurrentModels ?? 6
        const maxConcurrentPeersPerModel = config.verifier?.auditMaxConcurrentPeersPerModel ?? 4
        const maxConcurrentBatches = config.verifier?.auditMaxConcurrentBatches ?? 24
        const maxConcurrentBatchesPerPeer = config.verifier?.auditMaxConcurrentBatchesPerPeer ?? 2
        const batchLimiter = new ConcurrencyLimiter(maxConcurrentBatches)
        // Each seller's thinking suppression, discovered once per run (see `ProxyVerificationContext.sellerThinking`).
        const sellerThinking: NonNullable<ProxyVerificationContext['sellerThinking']> = new Map()
        const sellerLimiter = new KeyedSerialLimiter()
        const statusQueue = new SerialOperationQueue()
        const eventQueue = new SerialOperationQueue()
        const updateStatus = async (mutate: (value: VerifierStatusV1) => void): Promise<void> => {
          await statusQueue.run(async () => {
            mutate(status!)
            const current = status!.activeAudits[0] ?? null
            status!.currentModel = current?.model ?? null
            status!.currentPeerId = current?.peerId ?? null
            status!.message = status!.activeAudits.length > 0
              ? `running ${status!.activeAudits.length} audit(s), ${status!.queuedAudits} queued`
              : `${status!.queuedAudits} audit(s) queued`
            await writeVerifierStatus(evidenceDir, status!)
          })
        }
        const closeCallExtensions = config.verifier?.closeCallExtensions ?? 2
        const closeCallRule = closeCallRuleForExtensions(closeCallExtensions)
        const extensionTotals: ExtensionRoundStats = {
          extended: 0, same: 0, diff: 0, undetermined: 0, continued: 0, pending: 0, cost: emptyAuditCostSummary(),
        }
        const appendEvent = async (event: Record<string, unknown>): Promise<void> => {
          await eventQueue.run(async () => { await appendVerifierEvent(evidenceDir, epoch, event) })
        }

        console.log(chalk.dim(
          `Concurrency: ${maxConcurrentModels} models, ${maxConcurrentPeersPerModel} peers/model, `
          + `${maxConcurrentBatches} total batches, ${maxConcurrentBatchesPerPeer} batches/audit`,
        ))
        // One shared limiter caps the reference requests in flight across every model's build.
        const concurrencyWarning = enrollmentBudget === null ? null : referenceConcurrencyWarning(config.verifier)
        if (concurrencyWarning) console.warn(chalk.yellow(concurrencyWarning))
        const requestLimiter = enrollmentBudget === null ? null : createReferenceRequestLimiter(config.verifier)
        runProgress = new VerifierRunProgress(preparedModels.map(({ model, targets, skipped }) => ({
          model,
          providerCount: targets.length + skipped.length,
          skippedCount: skipped.length,
        })))
        runProgress.start()

        type ModelLane = (typeof preparedModels)[number] & { proxy: typeof proxy }
        const auditModel = async (
          { model, skipped, targets, proxy: laneProxy }: ModelLane,
        ): Promise<EpochAuditSummaryV1['models'][number]> => {
          const modelStartedAt = new Date().toISOString()
          await appendEvent({
            type: 'model-started', runId, epoch, model, at: modelStartedAt,
          })
          for (const entry of skipped) {
            await appendEvent({
              type: 'audit-skipped', runId, epoch, model, peerId: entry.peerId,
              code: entry.code, reason: entry.reason, outcomeReason: entry.outcomeReason,
              source: entry.source, at: modelStartedAt,
            })
          }
          runProgress!.activate(model)
          if (!runProgress!.interactive) {
            console.log(chalk.dim(`${model}: ${targets.length} eligible target(s), ${skipped.length} skipped`))
            if (judgedByOthers.get(model)) {
              console.log(chalk.yellow(`${model}: ${judgedByOthers.get(model)} seller(s) already judged by another auditor this epoch; not audited again (one audit and one confirmation per seller, never a third opinion)`))
            }
          }

          // Every seller is asked this epoch's question set; a resumed audit may still use an older reference.
          const referenceSources = new Map<string, KbfReferenceV1>()
          // First audits and extra sets share timeouts and concurrency; only where evidence goes differs.
          const verificationContext = (peer: PeerInfo, auditEvidenceDir: string): ProxyVerificationContext => ({
            proxy: laneProxy,
            evidenceDir: auditEvidenceDir,
            checkpointRootDir: modelAuditsDirectory(evidenceDir, epoch, model, runId),
            requestTimeoutMs: config.verifier?.probeRequestTimeoutMs ?? 120_000,
            auditTimeoutMs: config.verifier?.auditPeerTimeoutMs ?? 600_000,
            auditMaxTimeoutMs: config.verifier?.auditPeerMaxTimeoutMs ?? DEFAULT_AUDIT_MAX_TIMEOUT_MS,
            responseAuthReader: responseAuthReader!,
            batchConcurrency: Math.min(
              maxConcurrentBatchesPerPeer,
              peer.maxConcurrency && peer.maxConcurrency > 0 ? peer.maxConcurrency : maxConcurrentBatchesPerPeer,
            ),
            batchConcurrencyPromotionLatencyMs: config.verifier?.auditConcurrencyPromotionLatencyMs ?? 30_000,
            batchLimiter,
            sellerThinking,
          })
          const outcomes = await mapConcurrently(targets, maxConcurrentPeersPerModel, async (target) => {
            if (target.pendingExtension) {
              // The first check ran in an earlier run; only its extra questions are left.
              await updateStatus((value) => { value.queuedAudits -= 1 })
              runProgress!.recordVerdict(model, target.pendingExtension.result.status, target.pendingExtension.result.outcomeReason)
              if (!runProgress!.interactive) {
                console.log(chalk.dim(
                  `Close call ${target.peer.peerId.slice(0, 12)}… from run ${target.pendingExtension.runId.slice(0, 10)}: extra questions only`,
                ))
              }
              return { result: target.pendingExtension.result, failure: null, skipped: null }
            }
            return sellerLimiter.run(target.peer.peerId, async () => {
              const startedAt = new Date().toISOString()
              await updateStatus((value) => {
                value.queuedAudits -= 1
                value.activeAudits.push({ model, peerId: target.peer.peerId, startedAt })
              })
              if (!runProgress!.interactive) {
                console.log(chalk.dim(`Verifying ${model} on ${target.peer.peerId.slice(0, 12)}… (${target.service})`))
              }
              try {
                let reservationAuditId: string
                let reference
                let auditId: string
                let resume: ModelVerificationResumeInput | undefined
                if (target.resumeCandidate) {
                  const loaded = await loadModelAuditReservation({
                    banksDir,
                    model,
                    sellerPeerId: target.peer.peerId,
                    auditId: target.resumeCandidate.reservationAuditId,
                    config: config.verifier,
                  })
                  validateResumeCandidate(target.resumeCandidate, loaded.reference, target.service, epoch)
                  reservationAuditId = target.resumeCandidate.reservationAuditId
                  reference = loaded.reference
                  auditId = canonicalHashBytes32({
                    domain: 'antseed-verifier-repair-audit-v1',
                    runId,
                    parentAuditId: target.resumeCandidate.auditId,
                    startedAt,
                  })
                  resume = {
                    parentAuditId: target.resumeCandidate.auditId,
                    reservationAuditId: target.resumeCandidate.reservationAuditId,
                    parentEvidenceHash: target.resumeCandidate.evidenceHash,
                    exchanges: target.resumeCandidate.exchanges,
                  }
                } else {
                  const reserved = await reserveModelAuditReference({
                    banksDir,
                    model,
                    sellerPeerId: target.peer.peerId,
                    service: target.service,
                    runId,
                    epoch,
                    config: config.verifier,
                  })
                  reservationAuditId = reserved.auditId
                  reference = reserved.reference
                  auditId = reserved.auditId
                }
                referenceSources.set(reference.referenceId, reference)
                const verified = await verifyModelTarget({
                  context: verificationContext(target.peer, modelAuditSellersDirectory(evidenceDir, epoch, model, runId)),
                  target: target.peer,
                  service: target.service,
                  reference,
                  auditId,
                  resume,
                  checkpointIdentity: { runId, epoch, model },
                })
                // New first audits are decided by the close-call rule unless it is turned off.
                const result = verified.status !== 'SKIPPED' && closeCallRule
                  ? { ...verified, decisionRule: closeCallRule.id }
                  : verified
                if (result.status === 'SKIPPED') {
                  await voidModelAuditReference({
                    banksDir,
                    model,
                    sellerPeerId: target.peer.peerId,
                    auditId: reservationAuditId,
                    reason: `${result.code}: ${result.reason}`,
                  })
                  await appendEvent({
                    type: 'audit-skipped', runId, epoch, model, peerId: result.peerId,
                    auditId: result.auditId, code: result.code, reason: result.reason,
                    outcomeReason: result.outcomeReason, source: result.source,
                    evidencePath: result.evidencePath, at: new Date().toISOString(),
                  })
                  await updateStatus((value) => { value.skipped += 1 })
                  await updateStatus((value) => incrementReasonCount(value.reasonCounts, result.outcomeReason))
                  runProgress!.recordSkip(model, result.outcomeReason)
                  if (!runProgress!.interactive) {
                    console.log(chalk.yellow(`SKIPPED ${target.peer.peerId.slice(0, 12)}…: ${result.reason}`))
                  }
                  return { result: null, failure: null, skipped: result }
                }
                await appendEvent({
                  type: 'audit-completed', runId, epoch, model, peerId: result.peerId,
                  auditId: result.auditId, verdict: result.status, cost: result.cost,
                  outcomeReason: result.outcomeReason,
                  at: new Date().toISOString(),
                })
                await updateStatus((value) => {
                  value.auditsCompleted += 1
                  value.cost = addAuditCostSummaries(value.cost, result.cost)
                  incrementReasonCount(value.reasonCounts, result.outcomeReason)
                })
                runProgress!.recordVerdict(model, result.status, result.outcomeReason)
                if (!runProgress!.interactive) {
                  console.log(chalk.green(
                    `${result.status} ${target.peer.peerId.slice(0, 12)}… `
                    + `(${result.parsedProbeCount}/${result.probeCount} scoreable, `
                    + `$${result.cost.estimatedCostUsd.toFixed(6)})`,
                  ))
                }
                return { result, failure: null, skipped: null }
              } catch (error) {
                const reason = asError(error).message
                const outcomeReason = failureOutcomeReason(reason)
                const failure: ModelVerificationFailure = {
                  peerId: target.peer.peerId,
                  agentId: target.peer.onChainAgentId ? String(target.peer.onChainAgentId) : null,
                  service: target.service,
                  status: 'FAILED',
                  reason,
                  outcomeReason,
                }
                runProgress!.recordFailure(model, outcomeReason)
                if (!runProgress!.interactive) {
                  console.warn(chalk.yellow(`FAILED ${target.peer.peerId.slice(0, 12)}…: ${reason}`))
                }
                await appendEvent({
                  type: 'audit-failed', runId, epoch, model, peerId: target.peer.peerId,
                  reason, outcomeReason, at: new Date().toISOString(),
                })
                await updateStatus((value) => {
                  value.failures += 1
                  incrementReasonCount(value.reasonCounts, outcomeReason)
                })
                return { result: null, failure, skipped: null }
              } finally {
                await updateStatus((value) => {
                  value.activeAudits = value.activeAudits.filter((audit) => !(
                    audit.model === model && audit.peerId === target.peer.peerId
                  ))
                })
              }
            })
          })
          const firstResults = outcomes.flatMap((outcome) => outcome.result ? [outcome.result] : [])
          const failures = outcomes.flatMap((outcome) => outcome.failure ? [outcome.failure] : [])
          let results = firstResults
          const targetByPeer = new Map(targets.map((target) => [target.peer.peerId.toLowerCase(), target]))
          // Extra questions for a close call on the same seller and service as its first check, with
          // their own evidence directory and audit ID.
          const verifyFollowUp = async (input: {
            first: ModelVerificationTargetResult
            reference: KbfReferenceV1
            reservationAuditId: string
          }): Promise<ModelVerificationTargetResult | ModelVerificationSkip> => {
            const target = targetByPeer.get(input.first.peerId.toLowerCase())
            if (!target) throw new Error(`seller ${input.first.peerId} is no longer a target`)
            referenceSources.set(input.reference.referenceId, input.reference)
            const followUp = await verifyModelTarget({
              context: verificationContext(
                target.peer,
                modelAuditExtensionsDirectory(evidenceDir, epoch, model, runId, extensionSets(input.first).length + 1),
              ),
              target: target.peer,
              service: target.service,
              reference: input.reference,
              auditId: canonicalHashBytes32({
                domain: 'antseed-verifier-extension-audit-v1',
                runId,
                firstAuditId: input.first.auditId,
                reservationAuditId: input.reservationAuditId,
              }),
              checkpointIdentity: { runId, epoch, model },
              extension: true,
            })
            if (followUp.status === 'SKIPPED') {
              await voidModelAuditReference({
                banksDir, model, sellerPeerId: input.first.peerId, auditId: input.reservationAuditId,
                reason: `${followUp.code}: ${followUp.reason}`,
              })
            } else {
              await updateStatus((value) => { value.cost = addAuditCostSummaries(value.cost, followUp.cost) })
            }
            return followUp
          }
          if (closeCallExtensions > 0) {
            const extended = await runExtensionRounds({
              results,
              reserve: (first) => reserveExtensionReference({
                banksDir, model, sellerPeerId: first.peerId, service: first.service,
                runId, epoch, probeCount: first.probeCount, extensionIndex: extensionSets(first).length + 1,
                config: config.verifier,
              }),
              verify: (first, reference, reservationAuditId) => verifyFollowUp({ first, reference, reservationAuditId }),
              concurrency: async (tasks) => {
                await mapConcurrently(tasks, maxConcurrentPeersPerModel, (task) => task())
              },
              log: (message) => console.log(chalk.cyan(`[close-call:${model}] ${message}`)),
            })
            results = extended.results
            extensionTotals.extended += extended.stats.extended
            extensionTotals.same += extended.stats.same
            extensionTotals.diff += extended.stats.diff
            extensionTotals.undetermined += extended.stats.undetermined
            extensionTotals.continued += extended.stats.continued
            extensionTotals.pending += extended.stats.pending
            extensionTotals.cost = addAuditCostSummaries(extensionTotals.cost, extended.stats.cost)
            for (const result of results) {
              const before = firstResults.find((first) => first.auditId === result.auditId)
              const latest = latestExtension(result)
              if (!latest || extensionSets(result).length === (before ? extensionSets(before).length : 0)) continue
              await appendEvent({
                type: 'audit-extended', runId, epoch, model, peerId: result.peerId,
                firstAuditId: result.auditId, extensionAuditId: latest.auditId,
                extensionAuditIds: extensionSets(result).map((set) => set.auditId),
                firstPValue: latest.firstLook.pValue, pooledPValue: latest.pooled.pValueBinomial,
                verdict: latest.pooled.extendNext ? 'PENDING' : result.status, at: new Date().toISOString(),
              })
            }
          }
          const allSkipped = [
            ...skipped,
            ...outcomes.flatMap((outcome) => outcome.skipped ? [outcome.skipped] : []),
          ].sort((left, right) => left.peerId.localeCompare(right.peerId))

          const noAuditableProviders = targets.length === 0 && allSkipped.length === 0
          if (noAuditableProviders) {
            const reason = resumeOnly
              ? `no currently eligible advertised provider matched the unresolved ${model} audit(s) from run ${resumeSourceRunId}`
              : `no peers advertise ${model} with ResponseAuth support`
            const outcomeReason = failureOutcomeReason(reason)
            failures.push({
              peerId: `model:${model}`,
              displayName: `${model} audit`,
              agentId: null,
              service: model,
              status: 'FAILED',
              reason,
              outcomeReason,
            })
            console.warn(chalk.yellow(`${model}: ${reason}`))
            await updateStatus((value) => { value.failures += 1 })
            await updateStatus((value) => incrementReasonCount(value.reasonCounts, outcomeReason))
            await appendEvent({
              type: 'audit-failed', runId, epoch, model, peerId: null,
              reason, outcomeReason, at: new Date().toISOString(),
            })
            runProgress!.recordFailure(model, outcomeReason)
          }
          // Results answering a DIFF that waits for this auditor's confirmation: an UNDETERMINED among
          // them is held and audited again before it is submitted (see `CONFIRMATION_ATTEMPTS`).
          results = results.map((result) => {
            const target = targetByPeer.get(result.peerId.toLowerCase())
            const confirmation = target ? confirmationFor(model, target.peer) : undefined
            return confirmation && confirmation.waiting.some((tally) => tally.verdict === 'DIFF')
              && normalized(confirmation.service) === normalized(result.service)
              ? { ...result, confirmsDiff: true }
              : result
          })
          const modelCompletedAt = new Date().toISOString()
          const modelCost = addAuditCostSummaries(...results.map((result) => result.cost))
          const reasonCounts = countOutcomeReasons(results, failures, allSkipped)
          const consensusEvidence = await writeModelProbeConsensusEvidence({
            directory: modelAuditsDirectory(evidenceDir, epoch, model, runId),
            referencesDirectory: modelReferencesDirectory(evidenceDir, epoch, model),
            runId,
            epoch,
            model,
            createdAt: modelCompletedAt,
            results,
            referenceSources: [...referenceSources.values()],
          })
          const summaryPath = await writeModelAuditSummary(evidenceDir, epoch, model, {
            version: 1,
            kind: 'antseed-verifier-model-summary',
            runId,
            epoch,
            model,
            startedAt: modelStartedAt,
            completedAt: modelCompletedAt,
            results,
            failures,
            skipped: allSkipped,
            cost: modelCost,
            reasonCounts,
            consensusEvidencePath: consensusEvidence.consensusPath,
            referenceIntegrityPaths: consensusEvidence.referenceIntegrityPaths,
          })
          await writeModelAuditManifest({
            directory: modelAuditsDirectory(evidenceDir, epoch, model, runId),
            runId,
            epoch,
            model,
            summaryPath,
            consensusPath: consensusEvidence.consensusPath,
            referenceIntegrityPaths: consensusEvidence.referenceIntegrityPaths,
            results,
          })
          const modelSummary = {
            model,
            summaryPath,
            reportPath: modelAuditReportPath(evidenceDir, epoch, model),
            resultCount: results.length,
            failureCount: failures.length,
            skippedCount: allSkipped.length,
            cost: modelCost,
            reasonCounts,
          }
          await updateStatus((value) => { value.modelsCompleted += 1 })
          await appendEvent({
            type: 'model-completed', runId, epoch, model, summaryPath,
            resultCount: results.length, failureCount: failures.length,
            skippedCount: allSkipped.length, cost: modelCost,
            at: modelCompletedAt,
          })
          runProgress!.complete(model)
          return modelSummary
        }

        const buildQuestionSet = async (model: string): Promise<boolean> => {
          const log = (message: string) => runProgress!.above(() => console.log(chalk.dim(`[enrollment:${model}] ${message}`)))
          const sellersToAudit = selectedPeers.filter((peer) => auditsPeer(model, peer) && !finished(model, peer)
            && classifyVerificationTargetServices(peer, targetServicesFor(model, peer), targetPolicyFor(model)).eligible)
          if (sellersToAudit.length === 0) {
            log('no eligible seller left to audit; no enrollment calls needed')
            return true
          }
          try {
            const referencesDir = config.verifier?.referencesDir ?? join(globalOptions.dataDir, 'verifier', 'references')
            // Every seller of the model is asked this epoch's question set, built now when there is none.
            await ensureEpochQuestionSet({
              model, banksDir, referencesDir,
              config: config.verifier,
              maxRequests: enrollmentBudget!,
              epoch,
              runId: canonicalHashBytes32({ domain: 'antseed-verifier-question-set-build-v1', epoch, model, at: Date.now() }),
              extensionCount: closeCallRuleForExtensions(config.verifier?.closeCallExtensions ?? 2)?.maxExtensions ?? 0,
              buyerProxyPort: config.buyer.proxyPort,
              requestLimiter: requestLimiter!,
              log,
            })
            return true
          } catch (error) {
            const reason = asError(error).message
            runProgress!.above(() => console.warn(chalk.yellow(`SKIPPED ${model}: enrollment failed: ${reason}`)))
            enrollmentFailures.set(model, reason)
            return false
          }
        }

        // What a model's plan adds to the status totals. Lanes change it as they plan again or stop.
        const replaceStatusPlan = (before: StatusPlan, after: StatusPlan): Promise<void> => updateStatus((value) => {
          value.queuedAudits += after.targets.length - before.targets.length
          value.skipped += after.skipped.length - before.skipped.length
          for (const entry of before.skipped) decrementReasonCount(value.reasonCounts, entry.outcomeReason)
          for (const entry of after.skipped) incrementReasonCount(value.reasonCounts, entry.outcomeReason)
        })

        // A model that leaves the run before its audits start gives back what its plan added.
        const leaveRun = async (model: string, plan: StatusPlan, phase: string, failure?: string): Promise<null> => {
          if (failure !== undefined) enrollmentFailures.set(model, failure)
          await replaceStatusPlan(plan, { targets: [], skipped: [] })
          await updateStatus((value) => { value.modelsTotal -= 1 })
          runProgress!.setPhase(model, phase)
          return null
        }
        const planLane = async (model: string, before: StatusPlan, laneProxy: typeof proxy) => {
          const peers = selectedPeerId ? [selectVerifierPeer(laneProxy.peers, selectedPeerId)] : laneProxy.peers
          const planned = planModel(model, peers)
          await replaceStatusPlan(before, planned)
          runProgress!.updatePlan(model, planned.targets.length + planned.skipped.length, planned.skipped.length)
          return planned
        }
        // Models the epoch's cutoff stopped. That isn't a failure or work left: they wait for the next epoch.
        const modelsPastCutoff = new Set<string>()
        // The start of the round's rule, applied to a lane now. Past the cutoff a model without a window
        // gets none: its confirmations are still audited, and with none it stops here.
        const applyEpochCutoff = async (lane: ModelLane): Promise<ModelLane | null> => {
          const { model } = lane
          if (auditWindows.get(model) !== null || !(await readLateInEpoch())) return lane
          const planned = await planLane(model, lane, lane.proxy)
          if (planned.targets.length > 0) return { ...lane, targets: planned.targets, skipped: planned.skipped }
          modelsPastCutoff.add(model)
          runProgress!.above(() => console.log(chalk.yellow(
            `Less than ${MIN_SECONDS_FOR_ANOTHER_ROUND / 60} minutes left in the epoch: ${model}, not audited yet this epoch, waits for the next one.`,
          )))
          return await leaveRun(model, planned, 'waits for the next epoch')
        }

        // Each model runs in its own lane: its build, then its audits as soon as the build is done.
        let epochChangedTo: string | undefined
        const prepareLane = async (prepared: (typeof preparedModels)[number]): Promise<ModelLane | null> => {
          const { model } = prepared
          let statusPlan: StatusPlan = prepared
          try {
            let lane: ModelLane = { ...prepared, proxy }
            if (enrollmentBudget !== null) {
              runProgress!.setPhase(model, 'building questions')
              const built = await buildQuestionSet(model)
              const now = await resolveEpoch()
              if (now.epoch !== epoch) {
                // This model's plan belongs to the previous epoch; the caller plans it again for the new one.
                epochChangedTo = now.epoch
                return await leaveRun(model, statusPlan, 'epoch changed')
              }
              if (!built) return await leaveRun(model, statusPlan, 'no question set')
              // A build can take hours, and sellers come and go in the meantime.
              const laneProxy = await loadBuyerProxySnapshot(globalOptions.dataDir)
              const planned = await planLane(model, statusPlan, laneProxy)
              statusPlan = planned
              if (!hasWorkLeft(planned)) return await leaveRun(model, statusPlan, 'nothing left')
              lane = { model, skipped: planned.skipped, targets: planned.targets, proxy: laneProxy }
              runProgress!.setPhase(model, 'waiting')
            }
            const beforeChecks = await applyEpochCutoff(lane)
            if (!beforeChecks) return null
            lane = beforeChecks
            statusPlan = lane
            const problems = await collectPreRunProblems({
              config,
              dataDir: globalOptions.dataDir,
              banksDir,
              epoch,
              epochSource: epochWindow.source,
              reserveUsdc: lane.proxy.settings?.maxReserveAmountUsdc ?? null,
              models: [{ model, sellerPeerIds: lane.targets.map((target) => target.peer.peerId) }],
              checkAuditor: false,
            })
            if (problems.length > 0) {
              const ignored = options.ignorePreRunChecks === true
              runProgress!.above(() => {
                for (const problem of problems) {
                  console.warn(chalk.yellow(ignored ? `Ignoring (--ignore-pre-run-checks): ${problem}` : `SKIPPED ${problem}`))
                }
              })
              if (!ignored) return await leaveRun(model, statusPlan, 'no usable question set', problems.join('; '))
            }
            return lane
          } catch (error) {
            // For example the buyer stopped, or a --peer seller left, during this model's build.
            const reason = asError(error).message
            runProgress!.above(() => console.warn(chalk.yellow(`SKIPPED ${model}: ${reason}`)))
            return await leaveRun(model, statusPlan, 'failed', reason)
          }
        }
        // With an audit slot taken, right before the audits: a lane can wait for its slot past the cutoff.
        const startLane = async (prepared: ModelLane): Promise<ModelLane | null> => {
          const { model } = prepared
          let lane = prepared
          try {
            const ready = await applyEpochCutoff(lane)
            if (!ready) return null
            lane = ready
            // The first run of a model this epoch opens its window with the sellers it audits now.
            if (windowsOpenable && !lateInEpoch && auditWindows.get(model) === null && lane.targets.length > 0) {
              const opened = await openAuditWindow({
                evidenceDir, epoch, model, runId, sellers: lane.targets.map((target) => target.peer.peerId),
              })
              auditWindows.set(model, opened)
              runProgress!.above(() => console.log(chalk.cyan(`${model}: audit window opened with ${opened.sellers.length} seller(s); results are submitted together once every seller of it is finished`)))
            }
            return lane
          } catch (error) {
            const reason = asError(error).message
            runProgress!.above(() => console.warn(chalk.yellow(`SKIPPED ${model}: ${reason}`)))
            return await leaveRun(model, lane, 'failed', reason)
          }
        }
        // A model that fails here has no summary, so it stays out of the manifest and its window stays
        // open for the next round. The other models' finished audits are still recorded.
        const runLane = async (prepared: ModelLane): Promise<EpochAuditSummaryV1['models'][number] | null> => {
          const lane = await startLane(prepared)
          if (!lane) return null
          try {
            return await auditModel(lane)
          } catch (error) {
            const reason = asError(error).message
            runProgress!.above(() => console.warn(chalk.yellow(`FAILED ${lane.model}: ${reason}`)))
            enrollmentFailures.set(lane.model, reason)
            await updateStatus((value) => { value.modelsTotal -= 1 })
            runProgress!.setPhase(lane.model, 'failed')
            return null
          }
        }
        const laneSummaries = await mapInLanes(preparedModels, maxConcurrentModels, prepareLane, runLane)
        const epochModels = laneSummaries.flatMap((entry) => entry ? [entry] : [])
        runProgress.finish()
        if (epochModels.length === 0) {
          // Nothing was audited, so there is no run to record. The next round builds the models again.
          const stopped = epochChangedTo !== undefined
            ? 'the epoch changed'
            : enrollmentFailures.size > 0 ? 'no model could be audited' : null
          if (epochChangedTo === undefined && enrollmentFailures.size > 0) {
            console.warn(chalk.yellow(`No model could be audited (${enrollmentFailures.size} failed).`))
          }
          status.state = stopped ? 'failed' : 'completed'
          status.completedAt = new Date().toISOString()
          status.currentModel = null
          status.currentPeerId = null
          status.message = stopped ?? (modelsPastCutoff.size > 0 ? 'too late in the epoch to open an audit window' : 'nothing left to audit')
          await writeVerifierStatus(evidenceDir, status)
          await appendVerifierEvent(evidenceDir, epoch, {
            type: 'run-stopped', runId, epoch, reason: status.message, at: status.completedAt,
          })
          return {
            left: epochChangedTo === undefined ? enrollmentFailures.size : 0,
            secondsLeftInEpoch: epochWindow.endsAt - await clock(),
            enrollmentFailures,
            ...(epochChangedTo === undefined ? {} : { epochChanged: epochChangedTo }),
          }
        }

        const completedAt = new Date().toISOString()
        const epochSummary = {
          version: 1,
          kind: 'antseed-verifier-epoch-summary',
          runId,
          epoch,
          epochStartedAt: status.epochStartedAt,
          epochEndsAt: status.epochEndsAt,
          startedAt: status.startedAt,
          completedAt,
          reportPaths: epochModels.map((model) => ({
            model: model.model,
            path: modelAuditReportPath(evidenceDir, epoch, model.model),
          })),
          models: epochModels,
          failureCount: status.failures,
          cost: status.cost,
          reasonCounts: status.reasonCounts ?? {},
        } satisfies EpochAuditSummaryV1
        const epochSummaryPath = await writeEpochAuditSummary(evidenceDir, epoch, epochSummary)
        const manifestPath = await writeVerifierRunManifest(evidenceDir, {
          version: 1,
          kind: 'antseed-verifier-run-manifest',
          runId,
          state: status.failures > 0 ? 'completed-with-failures' : 'completed',
          epoch,
          epochSource: epochWindow.source,
          epochStartedAt: status.epochStartedAt,
          epochEndsAt: status.epochEndsAt,
          startedAt: status.startedAt,
          completedAt,
          summaryPath: epochSummaryPath,
          selection: selectedPeerId ? { peerIds: [selectedPeerId] } : undefined,
          modelOrder: epochModels.map((entry) => entry.model),
          models: epochModels,
          failureCount: status.failures,
        })
        const reportPaths = await writeModelAuditReports(evidenceDir, epoch, epochSummary)
        const overviewPath = await writeEpochOverview(evidenceDir, epoch, undefined, await epochDisputes(config, epochWindow))
        status.state = status.failures > 0 ? 'failed' : 'completed'
        status.completedAt = completedAt
        status.currentModel = null
        status.currentPeerId = null
        status.message = status.failures > 0
          ? `completed with ${status.failures} failure(s)`
          : 'completed successfully'
        await writeVerifierStatus(evidenceDir, status)
        await appendVerifierEvent(evidenceDir, epoch, {
          type: 'run-completed', runId, epoch, summaryPath: epochSummaryPath,
          failures: status.failures, cost: status.cost, at: completedAt,
        })
        console.log(chalk.dim(`Summary: ${epochSummaryPath}`))
        console.log(chalk.dim(`Run manifest: ${manifestPath}`))
        for (const report of reportPaths) console.log(chalk.dim(`Report (${report.model}): ${report.path}`))
        if (overviewPath) console.log(chalk.cyan(`Epoch overview (all runs this epoch): ${overviewPath}`))
        const closeCallCount = extensionTotals.same + extensionTotals.diff + extensionTotals.undetermined + extensionTotals.pending
        if (closeCallExtensions > 0 && closeCallCount > 0) {
          console.log(chalk.cyan(
            `Close calls: ${closeCallCount}, ${extensionTotals.extended} extra set(s) asked `
            + `(${extensionTotals.same} SAME, ${extensionTotals.diff} DIFF, `
            + `${extensionTotals.undetermined} UNDETERMINED, ${extensionTotals.pending} waiting for extra questions), `
            + `$${extensionTotals.cost.estimatedCostUsd.toFixed(6)}`,
          ))
          if (extensionTotals.pending > 0) {
            console.log(chalk.yellow(
              `${extensionTotals.pending} close call(s) are kept but not submitted until their extra questions are asked. `
              + 'Fix the reason in the [close-call:…] lines above, then run `antseed verifier run` again this epoch.',
            ))
          }
        }
        console.log(chalk.dim(`Estimated audit cost: $${status.cost.estimatedCostUsd.toFixed(6)}`))
        const finalState = await loadEpochState(evidenceDir, epoch)
        printEpochTable(epoch, finalState, models)
        for (const window of await closeFinishedAuditWindows({
          evidenceDir, epoch, state: finalState, secondsLeftInEpoch: epochWindow.endsAt - await clock(),
        })) {
          console.log(chalk.green(`${window.model}: audit window closed (${window.closeReason}); \`antseed verifier submit\` sends its results`))
        }
        const left = countPlan([...finalState.cells.values()].filter((cell) => (
          models.some((model) => model.toLowerCase() === cell.model.toLowerCase())
        )))
        const remaining = left.retryAuditor + left.retrySeller + left.extend + enrollmentFailures.size
        if (remaining > 0) {
          console.log(chalk.yellow(
            `Epoch ${epoch}: ${left.retryAuditor + left.retrySeller} audit(s) can be retried and ${left.extend} `
            + 'close call(s) wait for extra questions'
            + (enrollmentFailures.size > 0 ? `; ${enrollmentFailures.size} model(s) were not audited.` : '.'),
          ))
        } else if (modelsPastCutoff.size === 0) {
          console.log(chalk.green(`Epoch ${epoch}: every eligible seller is finished.`))
        }
        if (status.failures > 0) process.exitCode = 1
        return {
          left: remaining,
          secondsLeftInEpoch: epochWindow.endsAt - await clock(),
          enrollmentFailures,
          ...(epochChangedTo === undefined ? {} : { epochChanged: epochChangedTo }),
        }
      } catch (error) {
        if (status) {
          status.state = 'failed'
          status.completedAt = new Date().toISOString()
          status.message = asError(error).message
          await writeVerifierStatus(evidenceDir, status).catch(() => undefined)
        }
        throw error
      } finally {
        runProgress?.finish()
        responseAuthReader?.close()
        await runLock.release()
      }
}

/** The buyer's peer list counts as fresh if it saw a peer this recently; it refreshes every 5 minutes. */
const PEER_LIST_MAX_AGE_MS = 30 * 60_000

/**
 * Gives up the retries of sellers that stopped listing their model, and takes back the ones whose
 * seller is listed again (`decideRetryGiveUps`). A stale peer list decides nothing.
 */
export async function updateRetryGiveUps(input: {
  evidenceDir: string
  epoch: string
  peers: readonly PeerInfo[]
  servicesFor: (cell: EpochCell, peer: PeerInfo) => string[]
  nowMs?: number
}): Promise<void> {
  const { evidenceDir, epoch } = input
  const nowMs = input.nowMs ?? Date.now()
  if (nowMs - Math.max(...input.peers.map((peer) => peer.lastSeen)) > PEER_LIST_MAX_AGE_MS) {
    console.warn(chalk.yellow('The buyer\'s peer list is out of date, so no retry is given up this run.'))
    return
  }
  const state = await loadEpochState(evidenceDir, epoch)
  const closedModels = new Set((await listAuditWindows(evidenceDir, epoch))
    .filter((window) => window.state === 'closed')
    .map((window) => normalized(window.model)))
  const peers = new Map(input.peers.map((peer) => [peer.peerId.toLowerCase(), peer]))
  const { entries, added, restored } = decideRetryGiveUps({
    cells: state.cells.values(),
    nowSeconds: nowMs / 1_000,
    windowClosed: (cell) => closedModels.has(normalized(cell.model)),
    offersModel: (cell) => {
      const peer = peers.get(cell.peerId.trim().replace(/^0x/i, '').toLowerCase())
      return peer !== undefined && input.servicesFor(cell, peer).some((service) => findAdvertisedService(peer, service) !== null)
    },
  })
  if (added.length + restored.length === 0) return
  await writeRetryGiveUps(evidenceDir, epoch, entries)
  const seller = (entry: RetryGiveUpV1): string => `${entry.displayName ?? 'seller'} (${entry.peerId.slice(0, 12)}…)`
  const at = new Date(nowMs).toISOString()
  for (const entry of added) {
    console.log(chalk.yellow(`${entry.model}: gave up on ${seller(entry)}: ${entry.reason}. It keeps its result (attempt ${entry.attempts}).`))
    await appendVerifierEvent(evidenceDir, epoch, { type: 'retry-given-up', epoch, ...entry, at })
  }
  for (const entry of restored) {
    console.log(chalk.cyan(`${entry.model}: ${seller(entry)} is listed again, so its retry is back on.`))
    await appendVerifierEvent(evidenceDir, epoch, { type: 'retry-restored', epoch, model: entry.model, peerId: entry.peerId, at })
  }
}

/**
 * What would make this run fail on the auditor's side: no on-chain epoch (the chain can't be
 * reached), a deposit too small for the new payment channels, or a model without this epoch's
 * question set. Empty when the run can start. A run checks the chain and deposit once, before any
 * build (`checkQuestionSets: false`), and each model's question set in its lane, when it's built
 * (`checkAuditor: false`).
 */
async function collectPreRunProblems(input: {
  config: AntseedConfig
  dataDir: string
  banksDir: string
  epoch: string
  epochSource: AuditEpochWindow['source']
  reserveUsdc: bigint | null
  models: ReadonlyArray<{ model: string; sellerPeerIds: readonly string[] }>
  checkAuditor?: boolean
  checkQuestionSets?: boolean
}): Promise<string[]> {
  const problems: string[] = []
  if (input.checkAuditor !== false && input.epochSource !== 'onchain') {
    problems.push('the chain can\'t be reached (on-chain epoch unavailable), so this run\'s evidence could not be submitted. '
      + 'Check payments.crypto.rpcUrl or ANTSEED_BASE_RPC_URL')
  }

  const sellers = [...new Set(input.models.flatMap((entry) => entry.sellerPeerIds.map((id) => id.toLowerCase())))]
  if (input.checkAuditor !== false && sellers.length > 0 && input.config.payments?.crypto) {
    try {
      const { address } = await loadCryptoContext(input.dataDir)
      const store = openChannelStore(input.dataDir)
      let open: Set<string>
      try {
        open = new Set(store.getActiveChannelsByBuyer('buyer', address).map((channel) => channel.peerId.toLowerCase()))
      } finally {
        store.close()
      }
      const balance = await createDepositsClient(input.config).getBuyerBalance(address)
      const configured = input.config.payments?.maxReserveAmountUsdc
      const reserveUsdc = input.reserveUsdc
        ?? (configured && /^\d+$/.test(configured) ? BigInt(configured) : DEFAULT_MAX_RESERVE_AMOUNT_USDC)
      const shortfall = depositShortfall({
        availableUsdc: balance.available,
        reserveUsdc,
        newChannelCount: sellers.filter((seller) => !open.has(seller)).length,
      })
      if (shortfall) problems.push(`deposit: ${shortfall}`)
    } catch (error) {
      problems.push(`deposit: could not read the buyer deposit (${asError(error).message}); check the chain connection`)
    }
  }

  for (const { model, sellerPeerIds } of input.models) {
    if (input.checkQuestionSets === false || sellerPeerIds.length === 0) continue
    try {
      const set = await loadEpochQuestionSet({ banksDir: input.banksDir, model, epoch: input.epoch, config: input.config.verifier })
      if (!set) {
        problems.push(`${model}: no question set for epoch ${input.epoch} yet; run without --no-enroll to build it`)
        continue
      }
      const calibrationProblem = epochSetCalibrationProblem(set)
      if (calibrationProblem) {
        problems.push(`${model}: the question set for epoch ${input.epoch} ${calibrationProblem}`
          + `${set.calibration ? '; the model is not audited this epoch' : '; run without --no-enroll to calibrate it'}`)
        continue
      }
      const missing = await missingBankReferenceExchanges(input.banksDir, model)
      if (missing.length > 0) {
        problems.push(`${model}: the probe bank's reference evidence is missing (${missing.slice(0, 3).join(', ')}`
          + `${missing.length > 3 ? `, and ${missing.length - 3} more` : ''}), so the submission would fail after the run; `
          + 'restore the bank\'s reference-evidence folder')
      }
    } catch (error) {
      problems.push(`${model}: the probe bank can't be used (${asError(error).message}); `
        + `rebuild it with antseed verifier reference build ${model}`)
    }
  }
  return problems
}

function epochTimestamp(value: number): string {
  return new Date(value * 1_000).toISOString()
}

export function resolveRunModels(
  config: VerifierCLIConfig | undefined,
  modelValue: string | undefined,
  all: boolean,
  resumeManifest: VerifierRunManifestV1 | null,
): string[] {
  if (!resumeManifest) return resolveVerifierCommandModels(config, modelValue, all)
  const model = modelValue?.trim() ?? ''
  if (model && all) throw new Error('provide at most one of <model> or --all with --resume-run')
  const configured = new Set(resolveVerifierCommandModels(config, undefined, true).map((value) => value.toLowerCase()))
  const resumable = resumeManifest.modelOrder.filter((value) => configured.has(value.toLowerCase()))
  if (model) {
    const selected = resolveVerifierCommandModels(config, model, false)[0]!
    if (!resumable.some((value) => value.toLowerCase() === selected.toLowerCase())) {
      throw new Error(`resume run ${resumeManifest.runId} does not include model ${selected}`)
    }
    return [selected]
  }
  if (resumable.length === 0) throw new Error(`resume run ${resumeManifest.runId} has no audited models`)
  return resumable
}

export async function loadResumeCandidates(
  manifest: VerifierRunManifestV1,
  models: string[],
): Promise<Map<string, ResumeCandidate>> {
  const requested = new Set(models.map((model) => model.toLowerCase()))
  const candidates = new Map<string, ResumeCandidate>()
  for (const model of manifest.models) {
    if (!requested.has(model.model.toLowerCase())) continue
    const summary = JSON.parse(await readFile(model.summaryPath, 'utf8')) as ModelAuditSummaryV1
    if (summary.version !== 1 || summary.kind !== 'antseed-verifier-model-summary'
      || summary.runId !== manifest.runId || summary.epoch !== manifest.epoch) {
      throw new Error(`resume model summary is incompatible: ${model.summaryPath}`)
    }
    for (const result of summary.results) {
      if (result.status !== 'UNDETERMINED' || result.extension) continue
      const evidence = await verifyProxyAuditEvidenceFile(result.evidencePath, result.evidenceHash)
      candidates.set(resumeKey(model.model, result.peerId), {
        model: model.model,
        peerId: result.peerId,
        service: result.service,
        auditId: result.auditId,
        reservationAuditId: evidence.resume?.reservationAuditId
          ?? evidence.resume?.parentAuditId
          ?? result.auditId,
        evidencePath: result.evidencePath,
        evidenceHash: result.evidenceHash,
        referenceId: evidence.reference.referenceId,
        queryProfileHash: evidence.reference.queryProfileHash,
        probeIds: evidence.reference.probes.map((probe) => probe.id),
        exchanges: evidence.exchanges,
      })
    }
  }
  return candidates
}

/**
 * UNDETERMINED audits from this epoch that the plan retries: the retry keeps the exchanges that
 * already succeeded and only asks the rest again, on the same probes.
 */
export async function loadEpochRetryCandidates(
  state: EpochState,
  models: string[],
): Promise<Map<string, ResumeCandidate>> {
  const requested = new Set(models.map((model) => model.toLowerCase()))
  const candidates = new Map<string, ResumeCandidate>()
  for (const cell of state.cells.values()) {
    if (cell.action !== 'retry' || !cell.result || cell.result.status !== 'UNDETERMINED'
      || cell.result.extension) continue
    if (!requested.has(cell.model.toLowerCase())) continue
    const model = models.find((value) => value.toLowerCase() === cell.model.toLowerCase())!
    const result = cell.result
    let evidence: ProxyAuditEvidenceV1
    try {
      evidence = await verifyProxyAuditEvidenceFile(result.evidencePath, result.evidenceHash)
    } catch {
      continue
    }
    candidates.set(resumeKey(model, result.peerId), {
      model,
      peerId: result.peerId,
      service: result.service,
      auditId: result.auditId,
      reservationAuditId: evidence.resume?.reservationAuditId ?? evidence.resume?.parentAuditId ?? result.auditId,
      evidencePath: result.evidencePath,
      evidenceHash: result.evidenceHash,
      referenceId: evidence.reference.referenceId,
      queryProfileHash: evidence.reference.queryProfileHash,
      probeIds: evidence.reference.probes.map((probe) => probe.id),
      exchanges: evidence.exchanges,
    })
  }
  return candidates
}

/** Keeps each resume candidate that still matches the probe bank; the others are audited afresh. */
export async function keepCompatibleResumeCandidates(input: {
  candidates: ReadonlyMap<string, ResumeCandidate>
  banksDir: string
  config?: VerifierCLIConfig
  epoch: string
}): Promise<Map<string, ResumeCandidate>> {
  const compatible = new Map<string, ResumeCandidate>()
  for (const [key, candidate] of input.candidates) {
    const one = await filterCompatibleResumeCandidates({
      candidates: new Map([[key, candidate]]), banksDir: input.banksDir, config: input.config, epoch: input.epoch, strict: false,
    })
    if (one.size > 0) compatible.set(key, candidate)
  }
  return compatible
}

/** What this run will do, given the epoch's earlier runs. */
export function printEpochPlan(
  epoch: string,
  state: EpochState,
  planned: ReadonlyArray<{ model: string; targets: ReadonlyArray<{ peer: { peerId: string }; pendingExtension?: unknown; resumeCandidate?: unknown }>; skipped: readonly unknown[]; doneCount: number }>,
  resumeCandidates: ReadonlyMap<string, ResumeCandidate>,
): void {
  if (state.manifests.length === 0) {
    const sellers = planned.reduce((total, model) => total + model.targets.length, 0)
    console.log(chalk.dim(`Epoch ${epoch}: no earlier run this epoch; auditing ${sellers} seller(s) planned for this run.`))
    return
  }
  let done = 0
  let closeCalls = 0
  let retryAuditor = 0
  let retrySeller = 0
  let fresh = 0
  for (const entry of planned) {
    done += entry.doneCount
    for (const target of entry.targets) {
      const cell = state.cells.get(epochCellKey(entry.model, target.peer.peerId))
      if (target.pendingExtension) closeCalls += 1
      else if (!cell || cell.state === 'skipped') fresh += 1
      else if (cell.blame === 'auditor') retryAuditor += 1
      else retrySeller += 1
    }
  }
  const audits = retryAuditor + retrySeller + fresh
  console.log(chalk.cyan(
    `Epoch ${epoch} plan (from ${state.manifests.length} earlier run(s)): ${done} finished, `
    + `${retryAuditor} retry (our side), ${retrySeller} retry (seller or unclear, last try this epoch), `
    + `${closeCalls} close call(s) to finish, ${fresh} new. Running ${audits} audit(s) and ${closeCalls} follow-up(s)`
    + (resumeCandidates.size > 0 ? `; ${resumeCandidates.size} retry(s) keep their answered questions.` : '.'),
  ))
  console.log(chalk.dim('  Use --fresh to ignore the earlier runs.'))
}

export function printEpochTable(epoch: string, state: EpochState, models: readonly string[]): void {
  const wanted = new Set(models.map((model) => model.toLowerCase()))
  const rows = epochModelRows([...state.cells.values()].filter((cell) => wanted.has(cell.model.toLowerCase())), models)
  if (rows.length === 0) return
  console.log(chalk.bold(`Epoch ${epoch}, all runs so far:`))
  const pad = (value: string | number, width: number) => String(value).padStart(width)
  console.log(`  ${'model'.padEnd(22)}${pad('SAME', 6)}${pad('DIFF', 6)}${pad('UNDET', 7)}${pad('CLOSE', 9)}${pad('FAILED', 8)}${pad('SKIPPED', 9)}${pad('LEFT', 6)}`)
  for (const row of rows) {
    console.log(`  ${row.model.padEnd(22)}${pad(row.same, 6)}${pad(row.diff, 6)}${pad(row.undetermined, 7)}`
      + `${pad(row.closeCalls, 9)}${pad(row.failed, 8)}${pad(row.skipped, 9)}${pad(row.left, 6)}`)
  }
}

export async function loadCheckpointResumeCandidates(
  evidenceDir: string,
  sourceRunId: string,
  epoch: string,
  models: string[],
): Promise<Map<string, ResumeCandidate>> {
  const candidates = new Map<string, ResumeCandidate>()
  for (const model of models) {
    const checkpoints = await readModelAuditCheckpoints(modelAuditsDirectory(evidenceDir, epoch, model, sourceRunId))
    for (const { path, checkpoint } of checkpoints) {
      if (checkpoint.runId !== sourceRunId
        || checkpoint.epoch !== epoch
        || checkpoint.model.toLowerCase() !== model.toLowerCase()
        || checkpoint.extension) continue
      const evidenceHash = canonicalHashBytes32(checkpoint)
      candidates.set(resumeKey(model, checkpoint.targetPeerId), {
        model,
        peerId: checkpoint.targetPeerId,
        service: checkpoint.service,
        auditId: checkpoint.auditId,
        reservationAuditId: checkpoint.reservationAuditId
          ?? checkpoint.parentAuditId
          ?? checkpoint.auditId,
        evidencePath: path,
        evidenceHash,
        referenceId: checkpoint.referenceId,
        queryProfileHash: checkpoint.queryProfileHash,
        probeIds: checkpoint.probeIds,
        exchanges: checkpoint.exchanges,
      })
    }
  }
  return candidates
}

export async function filterCompatibleResumeCandidates(input: {
  candidates: ReadonlyMap<string, ResumeCandidate>
  banksDir: string
  config?: VerifierCLIConfig
  epoch: string
  strict: boolean
}): Promise<Map<string, ResumeCandidate>> {
  const compatible = new Map<string, ResumeCandidate>()
  for (const [key, candidate] of input.candidates) {
    try {
      const loaded = await loadModelAuditReservation({
        banksDir: input.banksDir,
        model: candidate.model,
        sellerPeerId: candidate.peerId,
        auditId: candidate.reservationAuditId,
        config: input.config,
      })
      validateResumeCandidate(candidate, loaded.reference, candidate.service, input.epoch)
      compatible.set(key, candidate)
    } catch (error) {
      if (input.strict) {
        throw new Error(
          `resume audit ${candidate.auditId} is incompatible with the active probe bank: ${asError(error).message}`,
        )
      }
      return new Map()
    }
  }
  return compatible
}

export function validateResumeCandidate(
  candidate: ResumeCandidate,
  reference: KbfReferenceV1,
  liveService: string,
  epoch: string,
): void {
  if (candidate.service.toLowerCase() !== liveService.toLowerCase()
    || candidate.peerId.trim() === '') {
    throw new Error(`resume audit ${candidate.auditId} seller or service mismatch`)
  }
  if (candidate.referenceId !== reference.referenceId
    || candidate.queryProfileHash !== queryProfileHash(reference.queryProfile)
    || candidate.probeIds.length !== reference.probes.length
    || candidate.probeIds.some((probeId, index) => probeId !== reference.probes[index]?.id)) {
    throw new Error(`resume audit ${candidate.auditId} reference or query profile mismatch for epoch ${epoch}`)
  }
}

function resumeKey(model: string, peerId: string): string {
  return `${model.trim().toLowerCase()}\u0000${peerId.trim().toLowerCase()}`
}

function countOutcomeReasons(
  ...groups: Array<Array<{ outcomeReason?: { code: string } | null }>>
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const entry of groups.flat()) incrementReasonCount(counts, entry.outcomeReason)
  return counts
}

function incrementReasonCount(
  counts: Record<string, number> | undefined,
  reason?: { code: string } | null,
): void {
  if (!counts || !reason) return
  counts[reason.code] = (counts[reason.code] ?? 0) + 1
}

function decrementReasonCount(
  counts: Record<string, number> | undefined,
  reason?: { code: string } | null,
): void {
  if (!counts?.[reason?.code ?? '']) return
  counts[reason!.code]! -= 1
  if (counts[reason!.code] === 0) delete counts[reason!.code]
}
