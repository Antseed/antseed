import chalk from 'chalk'
import type { Command } from 'commander'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { canonicalHashBytes32, queryProfileHash, type KbfReferenceV1 } from '@antseed/fingerprints'
import { loadConfig } from '../../../config/loader.js'
import type { VerifierCLIConfig } from '../../../config/types.js'
import {
  appendVerifierEvent,
  modelAuditsDirectory,
  modelAuditReportPath,
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
import { utcDayAuditEpochWindow } from '../../../verifier/audit-epoch.js'
import {
  ConcurrencyLimiter,
  KeyedSerialLimiter,
  SerialOperationQueue,
  mapConcurrently,
} from '../../../verifier/audit-concurrency.js'
import { acquirePidFileLock } from '../../../verifier/atomic-files.js'
import { resolveVerifierCommandModels, verifierModelServices } from '../../../verifier/model-config.js'
import { asError } from '../../../verifier/utils.js'
import {
  classifyVerificationTargetServices,
  loadBuyerProxySnapshot,
  readModelAuditCheckpoints,
  verifyModelTarget,
  type ModelVerificationFailure,
  type ModelVerificationResumeInput,
  type ModelVerificationSkip,
} from '../../../verifier/model-run.js'
import {
  epochProbeReferencePath,
  loadModelAuditReservation,
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
import { getGlobalOptions } from '../types.js'
import { VerifierRunProgress } from './run-progress.js'
import { failureOutcomeReason } from '../../../verifier/outcome-reason.js'
import {
  writeModelAuditManifest,
  writeModelProbeConsensusEvidence,
} from '../../../verifier/model-consensus-evidence.js'

interface RunOptions {
  all?: boolean
  allowProbeReuse?: boolean
  peer?: string
  resumeRun?: string
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
    .description('Verify live peers for one configured model or every enabled model')
    .option('--all', 'verify every enabled configured model')
    .option('--allow-probe-reuse', 'allow a new epoch reference to reuse probes assigned in earlier epochs')
    .option('--peer <peerId>', 'verify only this discovered seller peer')
    .option('--resume-run <runId>', 'repair only undetermined sellers from a compatible run')
    .action(async (modelValue: string | undefined, options: RunOptions, command: Command) => {
      const globalOptions = getGlobalOptions(command)
      const config = await loadConfig(globalOptions.config)
      const selectedPeerId = options.peer ? normalizeVerifierPeerId(options.peer) : null
      const banksDir = config.verifier?.banksDir ?? join(globalOptions.dataDir, 'verifier', 'banks')
      const evidenceDir = config.verifier?.evidenceDir ?? join(globalOptions.dataDir, 'verifier', 'evidence')
      const requestedResumeManifest = options.resumeRun
        ? await readVerifierRunManifest(evidenceDir, options.resumeRun)
        : null
      const models = resolveRunModels(config.verifier, modelValue, options.all === true, requestedResumeManifest)
      const runLock = await acquirePidFileLock(join(evidenceDir, '.run.lock'))
      let responseAuthReader: Awaited<ReturnType<typeof openResponseAuthReader>> | null = null
      let status: VerifierStatusV1 | null = null
      let runProgress: VerifierRunProgress | null = null
      try {
        const epochWindow = utcDayAuditEpochWindow()
        const epoch = epochWindow.epoch
        if (requestedResumeManifest && requestedResumeManifest.epoch !== epoch) {
          throw new Error(
            `resume run ${requestedResumeManifest.runId} belongs to epoch ${requestedResumeManifest.epoch}; current epoch is ${epoch}`,
          )
        }
        const previousStatus = requestedResumeManifest ? null : await readVerifierStatus(evidenceDir)
        const automaticResumeManifest = !requestedResumeManifest && previousStatus?.epoch === epoch
          ? await readVerifierRunManifest(evidenceDir, previousStatus.runId).catch(() => null)
          : null
        const resumeManifest = requestedResumeManifest ?? automaticResumeManifest
        const discoveredResumeCandidates = resumeManifest
          ? await loadResumeCandidates(resumeManifest, models)
          : previousStatus?.epoch === epoch
            ? await loadCheckpointResumeCandidates(evidenceDir, previousStatus.runId, epoch, models)
            : new Map<string, ResumeCandidate>()
        const selectedResumeCandidates = selectedPeerId
          ? filterResumeCandidatesByPeer(discoveredResumeCandidates, selectedPeerId)
          : discoveredResumeCandidates
        const resumeCandidates = await filterCompatibleResumeCandidates({
          candidates: selectedResumeCandidates,
          banksDir,
          config: config.verifier,
          epoch,
          strict: requestedResumeManifest !== null,
        })
        const resumeSourceRunId = requestedResumeManifest?.runId
          ?? (resumeCandidates.size > 0 ? previousStatus?.runId ?? null : null)
        const resumeOnly = resumeSourceRunId !== null
        let runModels = resumeOnly
          ? models.filter((model) => [...resumeCandidates.values()]
            .some((candidate) => candidate.model.toLowerCase() === model.toLowerCase()))
          : models
        if (resumeOnly && runModels.length === 0) {
          const peerSuffix = selectedPeerId ? ` and peer ${selectedPeerId}` : ''
          throw new Error(`resume run ${resumeSourceRunId} has no undetermined audits for the selected models${peerSuffix}`)
        }
        const proxy = await loadBuyerProxySnapshot(globalOptions.dataDir)
        const selectedPeers = selectedPeerId
          ? [selectVerifierPeer(proxy.peers, selectedPeerId)]
          : proxy.peers
        const targetPolicy = {
          minReputation: config.buyer.minPeerReputation,
          maxPricing: config.buyer.maxPricing.defaults,
        }
        if (selectedPeerId && !resumeOnly) {
          const advertisedModels = runModels.filter((model) => {
            const eligibility = classifyVerificationTargetServices(
              selectedPeers[0]!,
              verifierModelServices(config.verifier, model),
              targetPolicy,
            )
            return eligibility.eligible || eligibility.code !== 'model_not_advertised'
          })
          if (options.all) {
            runModels = advertisedModels
            if (runModels.length === 0) {
              throw new Error(`peer ${selectedPeerId} does not advertise any enabled configured verifier model`)
            }
          } else if (advertisedModels.length === 0) {
            throw new Error(`peer ${selectedPeerId} does not advertise model ${runModels[0]}`)
          }
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
        const preparedModels = runModels.map((model) => {
          const skipped: ModelVerificationSkip[] = []
          const configuredServices = verifierModelServices(config.verifier, model)
          const targets = selectedPeers.flatMap((peer) => {
            const resumeCandidate = resumeCandidates.get(resumeKey(model, peer.peerId))
            if (resumeOnly && !resumeCandidate) return []
            const services = resumeCandidate
              ? [resumeCandidate.service.toLowerCase(), ...configuredServices]
              : configuredServices
            const eligibility = classifyVerificationTargetServices(peer, services, targetPolicy)
            if (eligibility.eligible) return [{ peer, service: eligibility.service, resumeCandidate }]
            if (eligibility.code !== 'model_not_advertised') {
              const policySkip = eligibility.code !== 'missing_response_auth'
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
                  nextAction: policySkip ? 'adjust buyer routing policy' : 'inspect verifier evidence',
                },
                source: 'preflight',
                auditId: null,
                evidencePath: null,
                evidenceHash: null,
              })
            }
            return []
          })
          return { model, skipped, targets }
        })
        if (selectedPeerId && preparedModels.every((entry) => entry.targets.length + entry.skipped.length === 0)) {
          throw new Error(`peer ${selectedPeerId} does not currently advertise any selected verifier model`)
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
        console.log(chalk.dim(
          `Eligibility: reputation >= ${targetPolicy.minReputation}; maximum pricing input $${targetPolicy.maxPricing.inputUsdPerMillion}/M, output $${targetPolicy.maxPricing.outputUsdPerMillion}/M (buyer config)`,
        ))
        if (resumeSourceRunId) {
          console.log(chalk.dim(`Resume source: ${resumeSourceRunId} (${resumeCandidates.size} unresolved audit(s))`))
        }

        const maxConcurrentModels = config.verifier?.auditMaxConcurrentModels ?? 3
        const maxConcurrentPeersPerModel = config.verifier?.auditMaxConcurrentPeersPerModel ?? 4
        const maxConcurrentBatches = config.verifier?.auditMaxConcurrentBatches ?? 12
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

          const outcomes = await mapConcurrently(targets, maxConcurrentPeersPerModel, async (target) => {
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
                const advertisedConcurrency = target.peer.maxConcurrency && target.peer.maxConcurrency > 0
                  ? target.peer.maxConcurrency
                  : maxConcurrentBatchesPerPeer
                const result = await verifyModelTarget({
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
          const results = outcomes.flatMap((outcome) => outcome.result ? [outcome.result] : [])
          const failures = outcomes.flatMap((outcome) => outcome.failure ? [outcome.failure] : [])
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
            referenceSource: await readEpochReferenceSource(banksDir, model, epoch),
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
            referenceIntegrityPath: consensusEvidence.referenceIntegrityPath ?? undefined,
          })
          await writeModelAuditManifest({
            directory: modelAuditsDirectory(evidenceDir, epoch, model, runId),
            runId,
            epoch,
            model,
            summaryPath,
            consensusPath: consensusEvidence.consensusPath,
            referenceIntegrityPath: consensusEvidence.referenceIntegrityPath,
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
        console.log(chalk.dim(`Estimated audit cost: $${status.cost.estimatedCostUsd.toFixed(6)}`))
        if (status.failures > 0) process.exitCode = 1
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
    })
}

async function readEpochReferenceSource(
  banksDir: string,
  model: string,
  epoch: string,
): Promise<KbfReferenceV1 | undefined> {
  try {
    const value = JSON.parse(await readFile(epochProbeReferencePath(banksDir, model, epoch), 'utf8')) as {
      reference?: KbfReferenceV1
    }
    return value.reference
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
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
  if (resumable.length === 0) throw new Error(`resume run ${resumeManifest.runId} has no enabled configured models`)
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
      if (result.status !== 'UNDETERMINED') continue
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
        || checkpoint.model.toLowerCase() !== model.toLowerCase()) continue
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
