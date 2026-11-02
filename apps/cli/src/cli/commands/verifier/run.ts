import chalk from 'chalk'
import pkg from '../../../../package.json' with { type: 'json' }
import { requireCurrentVerifier } from '../../../verifier/release-check.js'
import type { Command } from 'commander'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalHashBytes32, queryProfileHash, type KbfReferenceV1 } from '@antseed/fingerprints'
import { resolveEffectiveBuyerConfig } from '../../../config/effective.js'
import { loadConfig } from '../../../config/loader.js'
import type { VerifierCLIConfig } from '../../../config/types.js'
import {
  appendVerifierEvent,
  modelAuditsDirectory,
  modelAuditReportPath,
  modelAuditExtensionsDirectory,
  modelAuditRechecksDirectory,
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
import { auditModelListHash, roundRobinAssignmentFor, type AuditAssignment } from '../../../verifier/audit-assignment.js'
import { approvedAuditorsAt, loadAuditorSetEvents } from '../../../verifier/auditor-set.js'
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
} from '../../../verifier/audit-concurrency.js'
import { acquirePidFileLock } from '../../../verifier/atomic-files.js'
import { configuredVerifierModels, resolveVerifierCommandModels, verifierModelServices } from '../../../verifier/model-config.js'
import { describeAuditorSource, resolveAuditorAddress } from './auditor-identity.js'
import { asError } from '../../../verifier/utils.js'
import {
  classifyVerificationTargetServices,
  loadBuyerProxySnapshot,
  readModelAuditCheckpoints,
  verifyModelTarget,
  type ModelVerificationFailure,
  type ModelVerificationResumeInput,
  type ModelVerificationSkip,
  type ModelVerificationTargetResult,
  type VerificationTargetPolicy,
} from '../../../verifier/model-run.js'
import {
  DEFAULT_MAX_RESERVE_AMOUNT_USDC,
  depositShortfall,
  preRunError,
  probeBankProblems,
} from '../../../verifier/pre-run-checks.js'
import { buyerCapShortfall, describeAuditPriceCap, requiredBuyerCap, resolveAuditPriceCaps } from '../../../verifier/audit-price.js'
import { loadHighestEndpointPrice, loadVerifierModelCatalog } from '../../../verifier/openrouter-catalog.js'
import {
  inspectSellerProbeCapacity,
  loadModelAuditReservation,
  reserveDiffRecheckReference,
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
  countPlan,
  epochCellKey,
  epochModelRows,
  loadEpochState,
  type EpochCell,
  type EpochState,
} from '../../../verifier/epoch-plan.js'
import { getGlobalOptions } from '../types.js'
import { enrollFreshProbes, ensureAuditableReference, ensureSellerProbeCapacity } from '../../../verifier/ensure-auditable-reference.js'
import { createReferenceRequestLimiter } from '../../../verifier/model-reference.js'
import { runDiffRechecks, type DiffRecheckStats } from '../../../verifier/diff-recheck.js'
import { runExtensionRounds, type ExtensionRoundStats } from '../../../verifier/extension-round.js'
import { closeCallRuleForExtensions, extensionSets, latestExtension } from '../../../verifier/close-call.js'
import {
  confirmationTargetsByModel,
  describeTallies,
  loadEpochReports,
  pendingConfirmations,
  type ConfirmationTarget,
} from '../../../verifier/pending-confirmations.js'
import { loadPendingDiffRechecks, pendingRecheckKey } from '../../../verifier/pending-rechecks.js'
import { VerifierRunProgress } from './run-progress.js'
import { failureOutcomeReason } from '../../../verifier/outcome-reason.js'
import {
  writeModelAuditManifest,
  writeModelProbeConsensusEvidence,
} from '../../../verifier/model-consensus-evidence.js'

interface RunOptions {
  all?: boolean
  auditor?: string
  allowProbeReuse?: boolean
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
 * Reads the epoch the verification contract checks on submit (`registry.emissions()`). Without a
 * configured verification contract it falls back to the configured emissions gate.
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

/** Auditors approved when the epoch started, from the verification contract's `AuditorSet` events. */
export async function loadApprovedAuditors(config: AntseedConfig, dataDir: string, epoch: AuditEpochWindow): Promise<string[]> {
  const events = await loadAuditorSetEvents(createVerifierClient(config), dataDir, (message) => console.log(chalk.dim(message)))
  return approvedAuditorsAt(events, epoch.startedAt)
}

/**
 * Reports other auditors made this epoch that wait for a confirmation this auditor is to give, as
 * the sellers to audit per model. Confirmations rotate like the assignment
 * (`auditorRotationForModel`): the first auditor in a model's rotation that has not reported on the
 * seller confirms it, and from halfway through the epoch any auditor that has not may. Nothing when
 * the epoch is not on-chain or no verification contract is configured; a failed read is a warning,
 * not a stop.
 */
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
    const [auditors, reports, required] = await Promise.all([
      input.approvedAuditors ?? loadApprovedAuditors(input.config, input.dataDir, input.epochWindow),
      loadEpochReports({ reader: client, epochStartedAt: input.epochWindow.startedAt, deploymentBlock: client.deploymentBlock }),
      client.requiredReports(),
    ])
    if (required.DIFF > auditors.length) {
      console.warn(chalk.yellow(
        `A DIFF needs ${required.DIFF} auditors but only ${auditors.length} ${auditors.length === 1 ? 'is' : 'are'} approved; no DIFF can be recorded.`,
      ))
    }
    const pending = pendingConfirmations({
      reports,
      epoch: input.epochWindow.epoch,
      epochStartedAt: input.epochWindow.startedAt,
      epochEndsAt: input.epochWindow.endsAt,
      now: input.now ?? Math.floor(Date.now() / 1_000),
      auditor: auditor.address,
      auditors,
      auditedModels: configuredVerifierModels(input.config.verifier),
      models: input.models,
    })
    if (pending.length > 0) {
      const mine = pending.filter((entry) => entry.mine).length
      console.log(chalk.cyan(`Reports waiting for a confirmation this epoch: ${pending.length}, ${mine} for this auditor`))
      for (const entry of pending) {
        const who = entry.mine ? 'auditing it now' : entry.confirmer ? `confirmer ${entry.confirmer}` : 'every approved auditor has reported'
        console.log(chalk.cyan(`  ${entry.model}: agent ${entry.agentId} ${describeTallies(entry.waiting)} (${who})`))
      }
    }
    return confirmationTargetsByModel(pending, (model) => verifierModelServices(input.config.verifier, model))
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
  verifier
    .command('run [model]')
    .description('Verify live peers for the models assigned to this auditor this epoch (the default), one audited model, or every audited model')
    .option('--all', 'verify every audited model instead of the assigned ones')
    .option('--auditor <address>', 'auditor address to assign models for (default: verifier.auditor, verifier.keystore, or the data-dir identity)')
    .option('--allow-probe-reuse', 'allow a seller\'s new epoch reference to reuse probes it was assigned in earlier epochs')
    .option('--peer <peerId>', 'verify only this discovered seller peer')
    .option('--resume-run <runId>', 'repair only undetermined sellers from a compatible run')
    .option('--no-enroll', 'never build fresh questions; a model whose bank is too small or worn out for its sellers stops the run')
    .option('--max-enrollment-requests <count>', `maximum physical reference requests per model, including retries (default: ${DEFAULT_ENROLLMENT_REQUESTS}; never above verifier.referenceMaxRequestsPerBuild)`)
    .option('--ignore-pre-run-checks', 'print the pre-run check problems as warnings and run anyway')
    .option('--fresh', 'ignore this epoch\'s earlier runs and audit every eligible seller again')
    .option('--skip-version-check', 'run even if this CLI is older than the latest release (its results may not match other auditors)')
    .option('--max-rounds <count>', 'rounds per run: after a round, retry what is left (failures, waiting rechecks) until nothing is left or a round makes no progress', '3')
    .option('--no-confirm', 'do not audit sellers whose verdicts from other auditors this epoch still wait for a confirmation')
    .action(async (modelValue: string | undefined, options: RunOptions, command: Command) => {
      validateAssignedModeOptions(modelValue, options)
      const last = await runVerifierRounds(
        maxRunRounds(options),
        (round) => runVerifierRound(modelValue, round === 1 ? options : { ...options, fresh: false }, command, round),
      )
      // A build that failed in an early round but succeeded later does not fail the command.
      if ((last?.enrollmentFailures?.size ?? 0) > 0) process.exitCode = 1
      console.log(`Next: antseed verifier submit`)
    })
}

/**
 * Runs up to `maxRounds` rounds. After a round, what is left (failed audits, waiting rechecks and
 * models whose fresh-question build failed) is retried in the next round, which re-plans every model
 * and gets a larger enrollment budget, so a build that ran out of requests or hit a network error
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
    // Later rounds continue from the epoch (never --fresh) and get another enrollment budget,
    // so a bank or recheck build that ran out of requests can finish from its checkpoint.
    const outcome = await runRound(round)
    if (outcome.epochChanged) {
      // The round was planned for the previous epoch (assignment, finished sellers, rechecks),
      // so nothing was audited; plan it again for the new epoch, once, without using up a round.
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
      log(chalk.yellow(`${outcome.left} audit(s), recheck(s) or question build(s) still left after ${maxRounds} round(s); run \`antseed verifier run\` again later this epoch to retry them.`))
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
    log(chalk.yellow(`Not audited this run, fresh questions could not be built (${failedBuilds.length}):`))
    for (const [model, reason] of failedBuilds) log(chalk.yellow(`  - ${model}: ${reason}`))
  }
  return last
}

/** No new round starts with less than this left in the epoch, so there is time to submit. */
export const MIN_SECONDS_FOR_ANOTHER_ROUND = 45 * 60

export function maxRunRounds(options: RunOptions): number {
  if (options.resumeRun) return 1
  const rounds = Number(options.maxRounds ?? '3')
  if (!Number.isSafeInteger(rounds) || rounds <= 0) throw new Error('--max-rounds must be a positive integer')
  return rounds
}

export interface VerifierRoundOutcome {
  /** Audits, rechecks and question builds a later round can retry. */
  left: number
  secondsLeftInEpoch: number
  /** Set to the new epoch when it started during enrollment; the round audited nothing. */
  epochChanged?: string
  /** Models whose fresh-question build failed this round, with the reason; retried next round. */
  enrollmentFailures?: Map<string, string>
}

/** One pass over the epoch's remaining work. Returns how much is still left to retry or recheck. */
async function runVerifierRound(
  modelValue: string | undefined,
  options: RunOptions,
  command: Command,
  round: number,
): Promise<VerifierRoundOutcome> {
      const baseBudget = enrollmentRequestBudget(options)
      const enrollmentBudget = baseBudget === null ? null : baseBudget * round
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
      const resolveEpoch = async (): Promise<AuditEpochWindow> => {
        const resolved = await resolveAuditEpochWindow(() => auditEpochReader(config))
        if (resolved.warning) console.warn(chalk.yellow(resolved.warning))
        return resolved.window
      }
      let epochWindow = await resolveEpoch()
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
        assignedModels = assignment.models
      }
      const selectedPeerId = options.peer ? normalizeVerifierPeerId(options.peer) : null
      const banksDir = config.verifier?.banksDir ?? join(globalOptions.dataDir, 'verifier', 'banks')
      const evidenceDir = config.verifier?.evidenceDir ?? join(globalOptions.dataDir, 'verifier', 'evidence')
      const requestedResumeManifest = options.resumeRun
        ? await readVerifierRunManifest(evidenceDir, options.resumeRun)
        : null
      const requestedModels = assignedModels ?? resolveRunModels(config.verifier, modelValue, options.all === true, requestedResumeManifest)
      // Verdicts other auditors reported this epoch that still need more auditors: their sellers
      // are audited here too, as the same model, on this auditor's own probes.
      const confirmations = requestedResumeManifest || options.confirm === false
        ? new Map<string, Map<string, ConfirmationTarget>>()
        : await loadRunConfirmations({
          config, dataDir: globalOptions.dataDir, auditorFlag: options.auditor, epochWindow, approvedAuditors,
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
      const auditsPeer = (model: string, peer: { onChainAgentId?: number | bigint | string | null }): boolean => (
        !confirmationOnly.has(model) || confirmationFor(model, peer) !== undefined
      )
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
        // Everything this epoch's earlier runs settled: finished sellers are skipped, the rest are
        // retried, rechecked or audited for the first time. `--fresh` and `--resume-run` ignore it.
        const epochState: EpochState | null = options.fresh || requestedResumeManifest
          ? null
          : await loadEpochState(evidenceDir, epoch)
        const epochCellFor = (model: string, peerId: string): EpochCell | undefined =>
          epochState?.cells.get(epochCellKey(model, peerId))
        const isDone = (model: string, peerId: string): boolean => epochCellFor(model, peerId)?.action === 'done'
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
        // Close calls whose extra questions could not be asked, and stage-1 DIFFs whose recheck could
        // not run, in earlier runs this epoch: finished here without repeating the first check.
        // --fresh audits those sellers from the start instead.
        const pendingRechecks = !options.fresh
          ? await loadPendingDiffRechecks(evidenceDir, epoch, models)
          : new Map()
        for (const [key, entry] of pendingRechecks) {
          const enabled = entry.kind === 'extension'
            ? (config.verifier?.closeCallExtensions ?? 2) > 0
            : (config.verifier?.diffConfirmationRuns ?? 1) > 0
          if (!enabled) pendingRechecks.delete(key)
        }
        if (selectedPeerId) {
          for (const [key, entry] of pendingRechecks) {
            if (entry.result.peerId.trim().replace(/^0x/i, '').toLowerCase() !== selectedPeerId) pendingRechecks.delete(key)
          }
        }
        let runModels = resumeOnly
          ? models.filter((model) => [...resumeCandidates.values(), ...pendingRechecks.values()]
            .some((candidate) => candidate.model.toLowerCase() === model.toLowerCase()))
          : models
        if (resumeOnly && runModels.length === 0) {
          const peerSuffix = selectedPeerId ? ` and peer ${selectedPeerId}` : ''
          throw new Error(`resume run ${resumeSourceRunId} has no undetermined audits for the selected models${peerSuffix}`)
        }
        let proxy = await loadBuyerProxySnapshot(globalOptions.dataDir)
        // The limits the running buyer enforces; a buyer from an older build doesn't record them,
        // so this config's buyer settings stand in.
        const configBuyer = resolveEffectiveBuyerConfig({ config })
        const buyerLimits = {
          minPeerReputation: proxy.settings?.minPeerReputation ?? configBuyer.minPeerReputation,
          maxPricing: proxy.settings?.maxPricing ?? configBuyer.maxPricing.defaults,
          reported: proxy.settings?.maxPricing != null,
        }
        let selectedPeers = selectedPeerId
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
        if (enrollmentBudget !== null) {
          if (resumeOnly) throw new Error('an audit resume is pending; complete it before enrolling new probes')
          // Every model enrolls at once; one shared limiter caps the reference requests in flight.
          const requestLimiter = createReferenceRequestLimiter(config.verifier)
          const enrolled = await Promise.all(runModels.map(async (model) => {
            const sellersToAudit = selectedPeers.filter((peer) => auditsPeer(model, peer) && !isDone(model, peer.peerId)
              && classifyVerificationTargetServices(
                peer, verifierModelServices(config.verifier, model), targetPolicyFor(model),
              ).eligible)
            if (sellersToAudit.length === 0) {
              console.log(chalk.dim(`[enrollment:${model}] no eligible seller left to audit; no enrollment calls needed`))
              return true
            }
            try {
              const referencesDir = config.verifier?.referencesDir ?? join(globalOptions.dataDir, 'verifier', 'references')
              const log = (message: string) => console.log(chalk.dim(`[enrollment:${model}] ${message}`))
              await ensureAuditableReference({
                model, banksDir, referencesDir,
                config: config.verifier,
                maxRequests: enrollmentBudget,
                buyerProxyPort: config.buyer.proxyPort,
                requestLimiter,
                log,
              })
              // The bank can be ready while sellers audited in earlier epochs have seen most of it:
              // build fresh questions until each seller has an unseen audit set and recheck set.
              await ensureSellerProbeCapacity({
                model, banksDir, referencesDir,
                config: config.verifier,
                maxRequests: enrollmentBudget,
                epoch,
                sellerPeerIds: sellersToAudit.map((peer) => peer.peerId),
                recheck: (config.verifier?.diffConfirmationRuns ?? 1) > 0,
                buyerProxyPort: config.buyer.proxyPort,
                requestLimiter,
                log,
              })
              return true
            } catch (error) {
              const reason = asError(error).message
              console.warn(chalk.yellow(`SKIPPED ${model}: enrollment failed: ${reason}`))
              enrollmentFailures.set(model, reason)
              return false
            }
          }))
          const readyModels = runModels.filter((_, index) => enrolled[index])
          runModels = readyModels
          if (runModels.length === 0) {
            // Nothing to audit this round; the next round (with a larger budget) builds them again.
            console.warn(chalk.yellow(`No model is ready after building fresh questions (${enrollmentFailures.size} failed).`))
            const now = await resolveEpoch()
            if (now.epoch !== epoch) {
              return { left: 0, secondsLeftInEpoch: now.endsAt - Date.now() / 1_000, epochChanged: now.epoch }
            }
            return { left: enrollmentFailures.size, secondsLeftInEpoch: now.endsAt - Date.now() / 1_000, enrollmentFailures }
          }
          epochWindow = await resolveEpoch()
          if (epochWindow.epoch !== epoch) {
            // Everything planned so far (assignment, finished sellers, waiting rechecks) belongs to
            // the previous epoch; the caller plans the round again for the new one.
            return { left: 0, secondsLeftInEpoch: epochWindow.endsAt - Date.now() / 1_000, epochChanged: epochWindow.epoch }
          }
          proxy = await loadBuyerProxySnapshot(globalOptions.dataDir)
          selectedPeers = selectedPeerId ? [selectVerifierPeer(proxy.peers, selectedPeerId)] : proxy.peers
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
        const plannedModels = runModels.map((model) => {
          let doneCount = 0
          const skipped: ModelVerificationSkip[] = []
          const configuredServices = verifierModelServices(config.verifier, model)
          const targets = selectedPeers.flatMap((peer) => {
            if (!auditsPeer(model, peer)) return []
            const resumeCandidate = resumeCandidates.get(resumeKey(model, peer.peerId))
            const pendingRecheck = pendingRechecks.get(pendingRecheckKey(model, peer.peerId))
            if (resumeOnly && !resumeCandidate && !pendingRecheck) return []
            if (!pendingRecheck && isDone(model, peer.peerId)) {
              doneCount += 1
              return []
            }
            // A confirmation audits the service the other auditors reported on.
            const confirmation = confirmationFor(model, peer)
            const services = resumeCandidate
              ? [resumeCandidate.service.toLowerCase(), ...configuredServices]
              : confirmation ? [confirmation.service, ...configuredServices] : configuredServices
            const eligibility = classifyVerificationTargetServices(peer, services, targetPolicyFor(model))
            if (eligibility.eligible) {
              const resumable = resumeCandidate
                && resumeCandidate.service.toLowerCase() === eligibility.service.toLowerCase()
              const carried = pendingRecheck
                && pendingRecheck.result.service.toLowerCase() === eligibility.service.toLowerCase()
              return [{
                peer,
                service: eligibility.service,
                resumeCandidate: resumable ? resumeCandidate : undefined,
                pendingRecheck: carried ? pendingRecheck : undefined,
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
            return []
          })
          return { model, skipped, targets, doneCount }
        })
        // A model whose sellers are all finished this epoch has nothing left to run.
        const preparedModels = plannedModels
          .filter((entry) => entry.targets.length + entry.skipped.length > 0 || entry.doneCount === 0)
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
            return { left: 0, secondsLeftInEpoch: epochWindow.endsAt - Date.now() / 1_000 }
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
          enrollIfNeeded: enrollmentBudget !== null,
          allowProbeReuse: options.allowProbeReuse === true,
          reserveUsdc: proxy.settings?.maxReserveAmountUsdc ?? null,
          models: preparedModels.map(({ model, targets }) => ({ model, sellerPeerIds: targets.map((target) => target.peer.peerId) })),
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
        const pendingExtensionCount = [...pendingRechecks.values()].filter((entry) => entry.kind === 'extension').length
        if (pendingExtensionCount > 0) {
          console.log(chalk.cyan(
            `Close calls waiting for extra questions from earlier runs this epoch: ${pendingExtensionCount}; asking them now`,
          ))
        }
        if (pendingRechecks.size - pendingExtensionCount > 0) {
          console.log(chalk.cyan(
            `DIFFs waiting for a recheck from earlier runs this epoch: ${pendingRechecks.size - pendingExtensionCount}; rechecking them now`,
          ))
        }

        const maxConcurrentModels = config.verifier?.auditMaxConcurrentModels ?? 6
        const maxConcurrentPeersPerModel = config.verifier?.auditMaxConcurrentPeersPerModel ?? 4
        const maxConcurrentBatches = config.verifier?.auditMaxConcurrentBatches ?? 24
        const maxConcurrentBatchesPerPeer = config.verifier?.auditMaxConcurrentBatchesPerPeer ?? 2
        const batchLimiter = new ConcurrencyLimiter(maxConcurrentBatches)
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
        const diffConfirmationRuns = config.verifier?.diffConfirmationRuns ?? 1
        const closeCallExtensions = config.verifier?.closeCallExtensions ?? 2
        const closeCallRule = closeCallRuleForExtensions(closeCallExtensions)
        const recheckTotals: DiffRecheckStats = {
          rechecked: 0, confirmed: 0, notConfirmed: 0, pending: 0, cost: emptyAuditCostSummary(),
        }
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
        runProgress = new VerifierRunProgress(preparedModels.map(({ model, targets, skipped }) => ({
          model,
          providerCount: targets.length + skipped.length,
          skippedCount: skipped.length,
        })))
        runProgress.start()

        const epochModels = await mapConcurrently(
          preparedModels,
          maxConcurrentModels,
          async ({ model, skipped, targets }): Promise<EpochAuditSummaryV1['models'][number]> => {
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
          }

          // Each seller is audited against its own probe subset, so one run
          // can span several references drawn from the same bank.
          const referenceSources = new Map<string, KbfReferenceV1>()
          const outcomes = await mapConcurrently(targets, maxConcurrentPeersPerModel, async (target) => {
            if (target.pendingRecheck) {
              // The first check ran in an earlier run; only its extra questions or its recheck are left.
              const extending = target.pendingRecheck.kind === 'extension'
              await updateStatus((value) => { value.queuedAudits -= 1 })
              runProgress!.recordVerdict(
                model, extending ? target.pendingRecheck.result.status : 'DIFF', target.pendingRecheck.result.outcomeReason,
              )
              if (!runProgress!.interactive) {
                console.log(chalk.dim(
                  `${extending ? 'Close call' : 'DIFF'} ${target.peer.peerId.slice(0, 12)}… from run `
                  + `${target.pendingRecheck.runId.slice(0, 10)}: ${extending ? 'extra questions' : 'recheck'} only`,
                ))
              }
              return { result: target.pendingRecheck.result, failure: null, skipped: null }
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
                    allowProbeReuse: options.allowProbeReuse === true,
                    config: config.verifier,
                  })
                  reservationAuditId = reserved.auditId
                  reference = reserved.reference
                  auditId = reserved.auditId
                }
                referenceSources.set(reference.referenceId, reference)
                const advertisedConcurrency = target.peer.maxConcurrency && target.peer.maxConcurrency > 0
                  ? target.peer.maxConcurrency
                  : maxConcurrentBatchesPerPeer
                const verified = await verifyModelTarget({
                  context: {
                    proxy,
                    evidenceDir: modelAuditSellersDirectory(evidenceDir, epoch, model, runId),
                    checkpointRootDir: modelAuditsDirectory(evidenceDir, epoch, model, runId),
                    requestTimeoutMs: config.verifier?.probeRequestTimeoutMs ?? 120_000,
                    auditTimeoutMs: config.verifier?.auditPeerTimeoutMs ?? 600_000,
                    responseAuthReader: responseAuthReader!,
                    batchConcurrency: Math.min(maxConcurrentBatchesPerPeer, advertisedConcurrency),
                    batchConcurrencyPromotionLatencyMs:
                      config.verifier?.auditConcurrencyPromotionLatencyMs ?? 30_000,
                    batchLimiter,
                  },
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
          const enrollForFollowUps = enrollmentBudget === null ? null : async () => {
            await enrollFreshProbes({
              model, banksDir,
              referencesDir: config.verifier?.referencesDir ?? join(globalOptions.dataDir, 'verifier', 'references'),
              config: config.verifier,
              maxRequests: enrollmentBudget,
              buyerProxyPort: config.buyer.proxyPort,
              log: (message) => console.log(chalk.dim(`[enrollment:${model}] ${message}`)),
            })
          }
          // A follow-up check (extra questions for a close call, or a DIFF recheck) on the same seller
          // and service as its first check, with its own evidence directory and audit ID.
          const verifyFollowUp = async (input: {
            first: ModelVerificationTargetResult
            reference: KbfReferenceV1
            reservationAuditId: string
            kind: 'extension' | 'diff-recheck'
          }): Promise<ModelVerificationTargetResult | ModelVerificationSkip> => {
            const target = targetByPeer.get(input.first.peerId.toLowerCase())
            if (!target) throw new Error(`seller ${input.first.peerId} is no longer a target`)
            referenceSources.set(input.reference.referenceId, input.reference)
            const advertisedConcurrency = target.peer.maxConcurrency && target.peer.maxConcurrency > 0
              ? target.peer.maxConcurrency
              : maxConcurrentBatchesPerPeer
            const extension = input.kind === 'extension'
            const followUp = await verifyModelTarget({
              context: {
                proxy,
                evidenceDir: extension
                  ? modelAuditExtensionsDirectory(evidenceDir, epoch, model, runId, extensionSets(input.first).length + 1)
                  : modelAuditRechecksDirectory(evidenceDir, epoch, model, runId),
                checkpointRootDir: modelAuditsDirectory(evidenceDir, epoch, model, runId),
                requestTimeoutMs: config.verifier?.probeRequestTimeoutMs ?? 120_000,
                auditTimeoutMs: config.verifier?.auditPeerTimeoutMs ?? 600_000,
                responseAuthReader: responseAuthReader!,
                batchConcurrency: Math.min(maxConcurrentBatchesPerPeer, advertisedConcurrency),
                batchConcurrencyPromotionLatencyMs:
                  config.verifier?.auditConcurrencyPromotionLatencyMs ?? 30_000,
                batchLimiter,
              },
              target: target.peer,
              service: target.service,
              reference: input.reference,
              auditId: canonicalHashBytes32({
                domain: extension ? 'antseed-verifier-extension-audit-v1' : 'antseed-verifier-diff-recheck-audit-v1',
                runId,
                firstAuditId: input.first.auditId,
                reservationAuditId: input.reservationAuditId,
              }),
              checkpointIdentity: { runId, epoch, model },
              ...(extension ? { extension: true } : { diffRecheck: true }),
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
              enroll: enrollForFollowUps,
              verify: (first, reference, reservationAuditId) => verifyFollowUp({
                first, reference, reservationAuditId, kind: 'extension',
              }),
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
          if (diffConfirmationRuns > 0) {
            const rechecked = await runDiffRechecks({
              // After the close-call round: pooled DIFFs are rechecked, and its results are kept.
              results,
              reserve: (first) => reserveDiffRecheckReference({
                banksDir, model, sellerPeerId: first.peerId, service: first.service,
                runId, epoch, config: config.verifier,
              }),
              enroll: enrollForFollowUps,
              verify: (first, reference, reservationAuditId) => verifyFollowUp({
                first, reference, reservationAuditId, kind: 'diff-recheck',
              }),
              concurrency: async (tasks) => {
                await mapConcurrently(tasks, maxConcurrentPeersPerModel, (task) => task())
              },
              log: (message) => console.log(chalk.cyan(`[recheck:${model}] ${message}`)),
            })
            results = rechecked.results
            failures.push(...rechecked.failures)
            if (rechecked.failures.length > 0) {
              await updateStatus((value) => { value.failures += rechecked.failures.length })
            }
            recheckTotals.rechecked += rechecked.stats.rechecked
            recheckTotals.confirmed += rechecked.stats.confirmed
            recheckTotals.notConfirmed += rechecked.stats.notConfirmed
            recheckTotals.pending += rechecked.stats.pending
            recheckTotals.cost = addAuditCostSummaries(recheckTotals.cost, rechecked.stats.cost)
            for (const result of results) {
              if (!result.recheck) continue
              await appendEvent({
                type: 'audit-rechecked', runId, epoch, model, peerId: result.peerId,
                firstAuditId: result.auditId, recheckAuditId: result.recheck.auditId,
                recheckVerdict: result.recheck.status, verdict: result.status, at: new Date().toISOString(),
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
        })
        runProgress.finish()

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
          modelOrder: runModels,
          models: epochModels,
          failureCount: status.failures,
        })
        const reportPaths = await writeModelAuditReports(evidenceDir, epoch, epochSummary)
        const overviewPath = await writeEpochOverview(evidenceDir, epoch)
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
            + `(${extensionTotals.same} SAME, ${extensionTotals.diff} DIFF → recheck, `
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
        const recheckCount = recheckTotals.confirmed + recheckTotals.notConfirmed + recheckTotals.pending
        if (diffConfirmationRuns > 0 && recheckCount > 0) {
          console.log(chalk.cyan(
            `DIFF rechecks: ${recheckCount} (${recheckTotals.confirmed} confirmed, `
            + `${recheckTotals.notConfirmed} not confirmed, ${recheckTotals.pending} waiting for a recheck), `
            + `$${recheckTotals.cost.estimatedCostUsd.toFixed(6)}`,
          ))
          if (recheckTotals.pending > 0) {
            console.log(chalk.yellow(
              `${recheckTotals.pending} DIFF(s) are kept but not submitted until rechecked. Fix the reason in the `
              + '[recheck:…] lines above (for example reference credits, or run without --no-enroll for fresh questions), '
              + 'then run `antseed verifier run` again this epoch: it rechecks them without repeating the first check.',
            ))
          }
        } else if (diffConfirmationRuns === 0) {
          console.log(chalk.yellow('DIFF rechecks: off (verifier.diffConfirmationRuns = 0)'))
        }
        console.log(chalk.dim(`Estimated audit cost: $${status.cost.estimatedCostUsd.toFixed(6)}`))
        const finalState = await loadEpochState(evidenceDir, epoch)
        printEpochTable(epoch, finalState, models)
        const left = countPlan([...finalState.cells.values()].filter((cell) => (
          models.some((model) => model.toLowerCase() === cell.model.toLowerCase())
        )))
        const remaining = left.retryAuditor + left.retrySeller + left.recheck + enrollmentFailures.size
        if (remaining > 0) {
          console.log(chalk.yellow(
            `Epoch ${epoch}: ${left.retryAuditor + left.retrySeller} audit(s) can be retried and ${left.recheck} `
            + 'close call(s) or DIFF(s) wait for extra questions or a recheck'
            + (enrollmentFailures.size > 0 ? `; fresh questions for ${enrollmentFailures.size} model(s) must be built again.` : '.'),
          ))
        } else {
          console.log(chalk.green(`Epoch ${epoch}: every eligible seller is finished.`))
        }
        if (status.failures > 0) process.exitCode = 1
        return { left: remaining, secondsLeftInEpoch: epochWindow.endsAt - Date.now() / 1_000, enrollmentFailures }
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

/**
 * What would make this run fail on the auditor's side: no on-chain epoch (the chain can't be
 * reached), a deposit too small for the new payment channels, or a probe bank that can't be loaded
 * or has too few unseen questions for the sellers. Empty when the run can start.
 */
async function collectPreRunProblems(input: {
  config: AntseedConfig
  dataDir: string
  banksDir: string
  epoch: string
  epochSource: AuditEpochWindow['source']
  enrollIfNeeded: boolean
  allowProbeReuse: boolean
  reserveUsdc: bigint | null
  models: ReadonlyArray<{ model: string; sellerPeerIds: readonly string[] }>
}): Promise<string[]> {
  const problems: string[] = []
  if (input.epochSource !== 'onchain') {
    problems.push('the chain can\'t be reached (on-chain epoch unavailable), so this run\'s evidence could not be submitted. '
      + 'Check payments.crypto.rpcUrl or ANTSEED_BASE_RPC_URL')
  }

  const sellers = [...new Set(input.models.flatMap((entry) => entry.sellerPeerIds.map((id) => id.toLowerCase())))]
  if (sellers.length > 0 && input.config.payments?.crypto) {
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

  const recheck = (input.config.verifier?.diffConfirmationRuns ?? 1) > 0
  for (const { model, sellerPeerIds } of input.models) {
    if (sellerPeerIds.length === 0) continue
    try {
      const capacity = await inspectSellerProbeCapacity({
        banksDir: input.banksDir, model, epoch: input.epoch, sellerPeerIds, recheck, config: input.config.verifier,
        allowProbeReuse: input.allowProbeReuse,
      })
      if (capacity.selectedProbeCount === null && !input.enrollIfNeeded) {
        problems.push(`${model}: the probe bank has too few usable questions for one audit; `
          + 'run without --no-enroll, or rebuild it')
        continue
      }
      problems.push(...probeBankProblems({ model, sellers: capacity.sellers, enrollIfNeeded: input.enrollIfNeeded }))
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
      // An unconfirmed DIFF stays UNDETERMINED; repairing its first check could only bring the DIFF back.
      if (result.status !== 'UNDETERMINED' || result.recheck || result.extension) continue
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
    if (cell.action !== 'retry' || !cell.result || cell.result.status !== 'UNDETERMINED' || cell.result.recheck
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
  planned: ReadonlyArray<{ model: string; targets: ReadonlyArray<{ peer: { peerId: string }; pendingRecheck?: unknown; resumeCandidate?: unknown }>; skipped: readonly unknown[]; doneCount: number }>,
  resumeCandidates: ReadonlyMap<string, ResumeCandidate>,
): void {
  if (state.manifests.length === 0) {
    console.log(chalk.dim(`Epoch ${epoch}: no earlier run this epoch; auditing every eligible seller.`))
    return
  }
  let done = 0
  let recheck = 0
  let retryAuditor = 0
  let retrySeller = 0
  let fresh = 0
  for (const entry of planned) {
    done += entry.doneCount
    for (const target of entry.targets) {
      const cell = state.cells.get(epochCellKey(entry.model, target.peer.peerId))
      if (target.pendingRecheck) recheck += 1
      else if (!cell || cell.state === 'skipped') fresh += 1
      else if (cell.blame === 'auditor') retryAuditor += 1
      else retrySeller += 1
    }
  }
  const audits = retryAuditor + retrySeller + fresh
  console.log(chalk.cyan(
    `Epoch ${epoch} plan (from ${state.manifests.length} earlier run(s)): ${done} finished, `
    + `${retryAuditor} retry (our side), ${retrySeller} retry (seller or unclear, last try this epoch), `
    + `${recheck} close call(s) or DIFF(s) to finish, ${fresh} new. Running ${audits} audit(s) and ${recheck} follow-up(s)`
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
  console.log(`  ${'model'.padEnd(22)}${pad('SAME', 6)}${pad('DIFF', 6)}${pad('UNDET', 7)}${pad('RECHECK', 9)}${pad('FAILED', 8)}${pad('SKIPPED', 9)}${pad('LEFT', 6)}`)
  for (const row of rows) {
    console.log(`  ${row.model.padEnd(22)}${pad(row.same, 6)}${pad(row.diff, 6)}${pad(row.undetermined, 7)}`
      + `${pad(row.pendingRecheck, 9)}${pad(row.failed, 8)}${pad(row.skipped, 9)}${pad(row.left, 6)}`)
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
        || checkpoint.diffRecheck || checkpoint.extension) continue
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
