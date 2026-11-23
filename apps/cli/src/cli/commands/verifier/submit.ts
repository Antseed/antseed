import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { acquirePidFileLock, LockHeldError, type FileLock } from '../../../verifier/atomic-files.js'
import { createInterface } from 'node:readline/promises'
import chalk from 'chalk'
import pkg from '../../../../package.json' with { type: 'json' }
import { readAuditWindow } from '../../../verifier/audit-window.js'
import { closeFinishedWindowsRecovering } from '../../../verifier/first-look-recovery.js'
import { confirmationHoldReason, confirmationTurnKey, confirmationsHoldingSubmit } from '../../../verifier/confirmation-hold.js'
import { chainNow } from '../../../verifier/chain-clock.js'
import { requireCurrentVerifier } from '../../../verifier/release-check.js'
import Table from 'cli-table3'
import type { Command } from 'commander'
import { getAddress } from 'ethers'
import { ReceiptWaitTimeoutError, type AuditorSetEvent, type ModelAuditedEvent, type ServiceAuditedEvent, type VerifierClient } from '@antseed/node/payments'
import { loadConfig } from '../../../config/loader.js'
import {
  canonicalEvidenceBytes,
  modelAuditEvidencePath,
  modelAuditLedgerPath,
  prepareModelAudits,
  readModelAuditLedger,
  modelAuditUpstreams,
  preparedFromEvidence,
  readModelAuditEvidence,
  resultTimeKey,
  sentAuditTimes,
  writeModelAuditEvidence,
  writeModelAuditLedger,
  type AuditPublicationV1,
  type ModelAuditSellerResultV1,
  type ModelAuditLedgerEntryV1,
  type ModelAuditLedgerV1,
  type PreparedModelAudit,
} from '../../../verifier/model-audit.js'
import { readVerifierRunManifest, type VerifierRunManifestV1 } from '../../../verifier/audit-artifacts.js'
import { prepareAuditPublication, publishVerificationToPinata } from '../../../verifier/ipfs-publication.js'
import { publishVerificationToDirectory, testPublicationFor } from '../../../verifier/test-publication.js'

/** Where `submit` publishes a model audit's evidence: Pinata (public IPFS), or this machine for a dry run on a fork. */
type PublicationTarget = { kind: 'pinata'; jwt: string } | { kind: 'local-test'; directory: string }
import { retireEpochQuestionSet } from '../../../verifier/probe-bank.js'
import { asError, normalized } from '../../../verifier/utils.js'
import { DIFF_HOLD_EPOCHS, diffHolds } from '../../../verifier/diff-hold.js'
import { createVerifierClient, requireCryptoConfig, useVerifierEventCache } from '../../payment-utils.js'
import { resolveAuditorAddress, resolveAuditorSigner } from './auditor-identity.js'
import { writeEpochOverview } from '../../../verifier/epoch-overview.js'
import { heldForConfirmationRecheck, loadEpochState, writeEpochSubmissionManifest } from '../../../verifier/epoch-plan.js'
import { getGlobalOptions } from '../types.js'
import {
  dropSettledConfirmations, epochReports, loadBlockTimestamps, loadDisputedSellers, loadEpochAuditEvents, loadEpochReports, ownResultTallies, pendingConfirmations, waitingReportBlocks,
  type PendingConfirmation,
} from '../../../verifier/pending-confirmations.js'
import { alreadyOnChainFilter, revocationPositions } from '../../../verifier/submission-delta.js'
import { opinionKey, thirdOpinionFilter } from '../../../verifier/third-opinion.js'
import { createPublishedFlagReader, sameCheckFilter } from '../../../verifier/same-check.js'
import { canonicalJsonStringify, validateKbfReferenceV1 } from '@antseed/fingerprints'
import { fetchIpfsText } from '@antseed/model-verifier'
import { verifierVerdict } from '@antseed/node/payments'
import { approvedAuditorsAt, loadAuditorSetEvents, revokedSinceEpochStart } from '../../../verifier/auditor-set.js'
import { configuredVerifierModels } from '../../../verifier/model-config.js'
import {
  dryRunPreparedPath, markDryRunPreparing, markUnsentReported, recordSubmitOutcome, unsentEpochRuns, unsentEpochRunsMessage, writeDryRunPrepared,
} from '../../../verifier/epoch-submission-record.js'

interface SubmitOptions {
  runId?: string
  publishIpfs?: boolean
  dryRun?: boolean
  publishOnly?: boolean
  auditor?: string
  yes?: boolean
  rpcUrl?: string
  keystore?: string
  skipVersionCheck?: boolean
}

interface PendingModelAudit {
  audit: PreparedModelAudit
  previous: ModelAuditLedgerEntryV1 | null
  alreadySubmitted: boolean
  expectsCredit: boolean
}

export interface EpochWindow {
  epoch: bigint
  startedAt: number
  endsAt: number
}

/**
 * What `submit` prints when a model's transaction did not go through. A timeout is the RPC not
 * answering in time (often the gas estimate), and the transaction may or may not have been sent:
 * the next `submit` looks for it on-chain first (`findSubmission`) and sends it only when it is not
 * there, so nothing is lost and nothing is sent twice.
 */
export function describeSubmissionFailure(error: unknown): string {
  const message = asError(error).message
  if (error instanceof ReceiptWaitTimeoutError) {
    return `sent (${error.hashes.at(-1)}) but not mined within ${Math.round(error.waitedMs / 60_000)} min. `
      + 'Nothing is sent again while it is pending: the next `antseed verifier submit` or watch tick waits for it, and records it once it is mined. '
      + 'If it stays pending, the network is congested or the RPC dropped it.'
  }
  const timedOut = (error as { code?: unknown } | null)?.code === 'TIMEOUT' || /\btime(d)? ?out\b/i.test(message)
  if (!timedOut) return `submission failed (continuing): ${message}. The next \`antseed verifier submit\` or watch tick tries again.`
  return 'not confirmed: the RPC did not answer in time, so it is unknown whether the transaction was sent. '
    + 'Nothing is lost: the next `antseed verifier submit` or watch tick checks the chain first and sends it only if it is not there. '
    + `If this repeats, use a faster RPC (\`--rpc-url\` or payments.crypto.rpcUrl). (${message})`
}

/**
 * A run can only be submitted in the on-chain epoch it was audited in: the contract rejects any
 * other `expectedEpoch`, and credits are counted per epoch.
 */
export function validateRunEpoch(manifest: VerifierRunManifestV1, window: EpochWindow): void {
  if (manifest.epochSource !== 'onchain') {
    throw new Error(`run ${manifest.runId} used the ${manifest.epochSource} epoch fallback; only runs on an on-chain epoch can be submitted`)
  }
  if (!/^\d+$/.test(manifest.epoch) || BigInt(manifest.epoch) !== window.epoch) {
    throw new Error(`run ${manifest.runId} belongs to epoch ${manifest.epoch}; the current on-chain epoch is ${window.epoch}`)
  }
  const startedAt = Date.parse(manifest.startedAt)
  const completedAt = Date.parse(manifest.completedAt)
  if (!Number.isFinite(startedAt) || !Number.isFinite(completedAt)
    || startedAt < window.startedAt * 1_000 || completedAt > window.endsAt * 1_000) {
    throw new Error(`run ${manifest.runId} timestamps fall outside on-chain epoch ${window.epoch}`)
  }
}

export function registerVerifierSubmitCommand(verifierCmd: Command): void {
  verifierCmd
    .command('submit')
    .description('Submit one audit per model for the current epoch, merging every run of the epoch (approved auditors only)')
    .option('--run-id <run-id>', 'submit only this completed run instead of the whole epoch')
    .option('--no-publish-ipfs', 'do not publish the audit evidence to IPFS (by default each model audit\'s public evidence is pinned to Pinata and its ipfs:// URI recorded; needs PINATA_JWT)')
    .option('--dry-run', 'preview the audits without publishing or broadcasting')
    .option('--publish-only', 'write and publish each model audit\'s evidence and record it in the ledger, without sending transactions')
    .option('--auditor <address>', 'with --publish-only or --dry-run: auditor address the evidence is written or previewed for, so no signer is needed')
    .option('--yes', 'submit without an interactive confirmation prompt')
    .option('--rpc-url <url>', 'Base JSON-RPC URL override')
    .option('--keystore <path>', 'sign with this encrypted JSON keystore (e.g. a Foundry keystore) instead of verifier.keystore or the data-dir identity; the password is asked on the terminal')
    .option('--skip-version-check', 'submit even if the latest release audits differently from this CLI, or the check cannot be made')
    .action(async (options: SubmitOptions, command: Command) => {
      const globalOptions = getGlobalOptions(command)
      useVerifierEventCache(globalOptions.dataDir)
      const config = await loadConfig(globalOptions.config)
      // Audits from a CLI that audits differently from the latest release are not submitted.
      await requireCurrentVerifier({
        command: 'submit',
        currentVersion: pkg.version,
        skip: options.skipVersionCheck === true,
        strictWhenUnavailable: !options.dryRun,
        warn: (text) => console.warn(chalk.yellow(text)),
      })
      const evidenceDir = config.verifier?.evidenceDir ?? join(globalOptions.dataDir, 'verifier', 'evidence')
      const banksDir = config.verifier?.banksDir ?? join(globalOptions.dataDir, 'verifier', 'banks')
      // One submit per data dir at a time: the ledger is read once and rewritten after every model, so a
      // submit by hand next to `verifier watch`'s would lose updates and could send a model twice.
      if (!options.dryRun) {
        const lock = await acquireSubmitLock(evidenceDir)
        if (!lock) {
          console.warn(chalk.yellow(
            'Another `verifier submit` is running on this data dir, so this one sends nothing. '
            + 'The next `antseed verifier submit` or watch tick tries again.',
          ))
          process.exitCode = 1
          return
        }
        process.once('exit', () => lock.releaseSync())
      }
      const verifierClient = createVerifierClient(config, options.rpcUrl ? { rpcUrl: String(options.rpcUrl) } : {})
      let manifest: VerifierRunManifestV1 | null
      let sourceRunIds: string[]
      // Results the merged epoch leaves out for now (a DIFF confirmation held for its re-check).
      let heldInEpoch: string[] = []
      if (options.runId) {
        manifest = await readVerifierRunManifest(evidenceDir, options.runId)
        sourceRunIds = [options.runId]
      } else {
        const currentEpoch = (await verifierClient.currentEpochWindow()).epoch
        await warnUnsentPreviousEpoch(evidenceDir, currentEpoch)
        const merged = await epochSubmissionManifest(evidenceDir, currentEpoch)
        manifest = merged?.manifest ?? null
        sourceRunIds = merged?.runIds ?? []
        heldInEpoch = merged?.held ?? []
      }
      if (!manifest) {
        // E.g. a confirmer with nothing to confirm yet: `verifier watch` calls submit every tick.
        console.log('Nothing to submit: no verifier run completed this epoch yet.')
        return
      }
      if (options.publishOnly && options.publishIpfs === false) throw new Error('--publish-only cannot be combined with --no-publish-ipfs')
      // A dry run sends nothing and signs nothing, so it may preview for an address without its signer.
      if (options.auditor && !options.publishOnly && !options.dryRun) throw new Error('--auditor is only valid with --publish-only or --dry-run')
      const { wallet, address } = options.auditor
        ? { wallet: null, address: getAddress(options.auditor) }
        : options.publishOnly
          ? { wallet: null, ...await resolveAuditorAddress({ config: config.verifier, dataDir: globalOptions.dataDir }) }
          : await resolveAuditorSigner({
            config: config.verifier, dataDir: globalOptions.dataDir, keystoreFlag: options.keystore,
          })
      const publishIpfs = options.publishIpfs !== false
      // A dry run on a local fork publishes on this machine instead (`verifier.testPublication`, refused off a local RPC).
      const testPublication = config.verifier?.testPublication
        ? testPublicationFor(config.verifier.testPublication, requireCryptoConfig(config, options.rpcUrl ? { rpcUrl: String(options.rpcUrl) } : {}).rpcUrl)
        : null
      const pinataJwt = publishIpfs && !testPublication ? process.env['PINATA_JWT']?.trim() : undefined
      const target: PublicationTarget = testPublication ? { kind: 'local-test', directory: testPublication.directory } : { kind: 'pinata', jwt: pinataJwt ?? '' }
      if (publishIpfs && !testPublication && !pinataJwt) {
        const message = 'PINATA_JWT is required to publish the audit evidence to IPFS; set it, or pass --no-publish-ipfs to submit without publishing'
        if (!options.dryRun) throw new Error(message)
        console.warn(chalk.yellow(message))
      }

      const [window, network, approved, limits] = await Promise.all([
        verifierClient.currentEpochWindow(),
        verifierClient.provider.getNetwork(),
        verifierClient.approvedAuditor(address),
        verifierClient.creditLimits(),
      ])
      validateRunEpoch(manifest, window)
      const secondsLeftInEpoch = window.endsAt - await chainNow(verifierClient.provider)
      const epochState = await loadEpochState(evidenceDir, manifest.epoch)
      // Windows whose sellers are all finished (or that the end of the epoch closes) are submitted now.
      if (!options.dryRun) {
        // The same close as \`verifier run\`: a first look still to be recovered keeps its window open.
        for (const closed of await closeFinishedWindowsRecovering({
          evidenceDir, epoch: manifest.epoch, state: epochState, secondsLeftInEpoch,
        })) console.log(chalk.green(`${closed.model}: audit window closed (${closed.closeReason})`))
      }
      if (!options.dryRun && !approved) {
        throw new Error(
          `auditor wallet ${address} is not approved by the KBF audits contract ${getAddress(verifierClient.contractAddress)}`,
        )
      }
      const contract = getAddress(verifierClient.contractAddress)
      const ledgerPath = modelAuditLedgerPath(evidenceDir, manifest.runId, network.chainId, contract)
      const ledger = await readModelAuditLedger(ledgerPath, {
        runId: manifest.runId,
        epoch: manifest.epoch,
        auditor: address,
        chainId: network.chainId,
        contract,
      })

      // Only what changes this auditor's on-chain position is sent: results it already reported this
      // epoch are left out before the evidence is built (see `resultsAlreadyOnChain`).
      // Read at most once: the delta filter needs it only for results this auditor already reported.
      let auditorSetEventsRead: Promise<AuditorSetEvent[]> | null = null
      const auditorSetEvents = (): Promise<AuditorSetEvent[]> => (
        // Cached in the data dir (`auditor-set.ts`): only blocks no earlier read covered are scanned.
        auditorSetEventsRead ??= loadAuditorSetEvents(verifierClient, globalOptions.dataDir, (message) => console.log(chalk.dim(message)))
      )
      const readEpochEvents = () => loadEpochAuditEvents({
        reader: verifierClient, epochStartedAt: window.startedAt, deploymentBlock: verifierClient.deploymentBlock,
      })
      // The waiting DIFFs whose confirmer this auditor is right now, by the rotation (as `verifier run` plans
      // them). Only these are answered, whether or not the run flagged the result as a confirmation: an
      // owner whose stand-in reported first answers too, and a flagged result whose 12 hours are over does not.
      const myPendingConfirmations = async (events: readonly ServiceAuditedEvent[]): Promise<PendingConfirmation[]> => {
        const setEvents = await auditorSetEvents()
        const reports = epochReports(events)
        const blockTimestamps = await loadBlockTimestamps({ getBlock: (block) => verifierClient.provider.getBlock(block) }, waitingReportBlocks(reports))
        return pendingConfirmations({
          reports,
          epoch: window.epoch,
          blockTimestamps,
          revoked: revokedSinceEpochStart(setEvents, window.startedAt),
          now: await chainNow(verifierClient.provider),
          auditor: address,
          auditors: approvedAuditorsAt(setEvents, window.startedAt),
          auditedModels: configuredVerifierModels(config.verifier),
        }).filter((entry) => entry.mine)
      }
      const readMyConfirmations = async (events: readonly ServiceAuditedEvent[]): Promise<Set<string>> => (
        new Set((await myPendingConfirmations(events)).map((entry) => opinionKey(entry.agentId, entry.serviceHash, entry.modelHash)))
      )
      const epochEvents = await readEpochEvents()
      // Auditors revoked this epoch: their reports no longer count, so they are no opinion (`otherOpinions`).
      // Unreadable, every report counts, which holds back more, never less.
      const revoked = await auditorSetEvents()
        .then((events) => revokedSinceEpochStart(events, window.startedAt))
        .catch(() => new Set<string>())
      let myConfirmations = new Set<string>()
      try {
        myConfirmations = await readMyConfirmations(epochEvents)
      } catch (error) {
        console.warn(chalk.yellow(`Could not work out this auditor's confirmations: ${asError(error).message}; no confirmation is sent this time, the next submit tries again`))
      }
      // A model whose started confirmations wait to be audited again is held for them (`confirmationsHoldingSubmit`):
      // only for reports whose confirmer this auditor still is and that are not settled, as \`verifier run\` keeps them,
      // and never past the end-of-epoch cut-off. Unreadable, every waiting confirmation holds, so no question set it may
      // still need is published.
      let liveTurns: Set<string> | null = null
      try {
        const live = await dropSettledConfirmations(await myPendingConfirmations(epochEvents), verifierClient, BigInt(window.epoch))
        liveTurns = new Set(live.map((entry) => opinionKey(entry.agentId, entry.serviceHash, entry.modelHash)))
      } catch (error) {
        console.warn(chalk.yellow(`Could not read which confirmations are still this auditor's: ${asError(error).message}; every confirmation waiting to be audited again holds its model this time`))
      }
      const confirmationHolds = confirmationsHoldingSubmit({
        state: epochState,
        secondsLeftInEpoch,
        stillMine: liveTurns ? (cell) => liveTurns.has(confirmationTurnKey(cell) ?? '') : null,
      })
      /**
       * The third-opinion check again, on the events up to now, right before `audit` is sent. Between
       * the first read and the send come the evidence, IPFS and the duplicate checks, and another
       * auditor can report on the same seller meanwhile; or this auditor's confirmation turn can end.
       * The reason not to send it now, or null. A failed read is a reason too: the check must not fail open.
       */
      // Which check flagged in another auditor's waiting DIFF, read from its published evidence (same-check.ts).
      const flagReader = createPublishedFlagReader(
        verifierClient,
        (cidPath) => fetchIpfsText(cidPath, testPublication ? { ipfsGateway: testPublication.gatewayUrl } : {}),
      )
      // What this auditor already reported, on the events given: the preparation and the last read before a send use it.
      // The finish times of what this auditor sent from any run here, read once when an older vote needs them.
      let sentTimesRead: Promise<Map<string, Record<string, number>>> | null = null
      const sentTimes = () => (sentTimesRead ??= sentAuditTimes(evidenceDir, network.chainId, contract))
      const alreadyOnChainFilterFor = (events: readonly ServiceAuditedEvent[]) => alreadyOnChainFilter({
        events,
        auditor: address,
        epoch: window.epoch,
        reader: {
          reportRound: (agentId, service) => verifierClient.reportRound(agentId, service),
          serviceStatusByHash: (agentId, service) => verifierClient.serviceStatusByHash(agentId, service),
          blockTimestamp: flagReader.blockTimestamp,
        },
        auditorSetEvents,
        // When the audit behind this auditor's own report finished, by its transaction in this run's ledger or another
        // run's: the planner's ordering too.
        reportedAuditTime: async (own, candidate) => {
          if (!own.transactionHash) return null
          const key = resultTimeKey(candidate.agentId, candidate.serviceHash)
          const here = Object.values(ledger.models).find((value) => value.transactionHash && normalized(value.transactionHash) === normalized(own.transactionHash!))
          const valid = (time: unknown): time is number => typeof time === 'number' && Number.isFinite(time) && time > 0
          const local = here?.auditedAt?.[key]
          if (valid(local)) return local
          const other = (await sentTimes()).get(own.transactionHash.toLowerCase())?.[key]
          return valid(other) ? other : null
        },
      })
      const recheckBeforeSend = (audit: PreparedModelAudit): Promise<string | null> => recheckAuditBeforeSend({
        audit, auditor: address, readEvents: readEpochEvents, readMyConfirmations, revoked,
        sameCheck: (events) => sameCheckFilter({ events, auditor: address, revoked, reader: flagReader }),
        alreadyOnChain: (events) => alreadyOnChainFilterFor(events),
      })
      // A dry run marks its file as incomplete first, so a failure below never leaves an older one looking current.
      if (options.dryRun && !await markDryRunPreparing(evidenceDir, manifest.epoch, sourceRunIds).catch(() => false)) {
        console.warn(chalk.yellow(`An older ${dryRunPreparedPath(evidenceDir, manifest.epoch)} could not be marked or removed; it is not this dry run's.`))
      }
      const { audits: prepared, excluded, decisions, alreadyOnChain, heldBack } = await prepareModelAudits({
        evidenceDir,
        banksDir,
        manifest,
        auditor: address,
        resolveAgentOwner: (agentId) => verifierClient.agentOwner(agentId),
        config: config.verifier,
        auditWindow: (model) => readAuditWindow(evidenceDir, manifest.epoch, model),
        confirmationHold: (model) => confirmationHoldReason(confirmationHolds.get(model.trim().toLowerCase())),
        alreadyOnChain: alreadyOnChainFilterFor(epochEvents),
        // Never a third opinion: a seller judged by another auditor this epoch is not reported on again,
        // except to confirm a DIFF this auditor is the confirmer of (third-opinion.ts).
        thirdOpinion: thirdOpinionFilter({ events: epochEvents, auditor: address, myConfirmations, revoked }),
        // A seller whose DIFF was recorded in the last `verifier.diffHoldEpochs` epochs gets no result
        // that could clear it (diff-hold.ts); `verifier run` does not audit it either.
        diffHold: diffHolds({
          epoch: window.epoch,
          holdEpochs: config.verifier?.diffHoldEpochs ?? DIFF_HOLD_EPOCHS,
          reader: { serviceStatusByHash: (agentId, service) => verifierClient.serviceStatusByHash(agentId, service) },
        }).filter,
        // A DIFF that answers another auditor's waiting DIFF is sent as DIFF only when the same check
        // flagged in both audits; which one flagged there is read from its published evidence (same-check.ts).
        sameCheck: sameCheckFilter({ events: epochEvents, auditor: address, revoked, reader: flagReader }),
        ...(publishIpfs ? {} : {
          unpublishedDiffs: 'a DIFF is sent only with its evidence published: a confirmer reads which check flagged from it, '
            + 'so a DIFF sent with --no-publish-ipfs could never be confirmed',
        }),
      })
      const audits = await reuseLedgerEvidence(
        prepared.map((audit) => withLedgerKey(audit, ledger, evidenceDir, manifest.runId)), ledger,
      )
      // This epoch's first block, where the reads of this auditor's own submissions start (`ownEpochSubmissions`).
      const epochFirstBlock = await verifierClient.firstBlockAtOrAfter(window.startedAt, verifierClient.deploymentBlock ?? 0)
      const submittedEvidence = await submittedEvidenceHashes(verifierClient, address, epochFirstBlock, auditorSetEvents)
      const credited = await verifierClient.auditCredits(address, window.epoch)
      let auditorCreditsLeft = limits.perAuditor > credited.auditor ? limits.perAuditor - credited.auditor : 0n
      // Credited audits left per model (KBF's per-model cap counts audits), and what one audit earns.
      const modelAuditsLeft = new Map<string, bigint>()
      const creditsPerAudit = new Map<string, bigint>()
      const pending: PendingModelAudit[] = []
      for (const audit of audits) {
        const previous = ledger.models[audit.key] ?? null
        const onChain = submittedEvidence.get(normalized(audit.evidenceHash))
        const alreadySubmitted = onChain !== undefined
        if (onChain && previous && previous.status !== 'submitted') {
          // Sent by an earlier submit that did not see it mined (its wait ran out): record it now.
          ledger.models[audit.key] = {
            ...previous, status: 'submitted', error: null,
            transactionHash: onChain.transactionHash, blockNumber: onChain.blockNumber,
          }
          await writeModelAuditLedger(ledgerPath, ledger)
          console.log(chalk.dim(`${audit.key}: mined after an earlier submit gave up waiting; ledger updated`))
        }
        let expectsCredit = false
        if (!alreadySubmitted) {
          if (!modelAuditsLeft.has(audit.modelHash)) {
            const [used, perAudit] = await Promise.all([
              verifierClient.creditedAudits(window.epoch, address, audit.modelHash),
              verifierClient.creditsFor(audit.modelHash),
            ])
            modelAuditsLeft.set(audit.modelHash, limits.perModel > used ? limits.perModel - used : 0n)
            creditsPerAudit.set(audit.modelHash, perAudit)
          }
          const modelLeft = modelAuditsLeft.get(audit.modelHash)!
          expectsCredit = modelLeft > 0n && auditorCreditsLeft > 0n
          if (expectsCredit) {
            modelAuditsLeft.set(audit.modelHash, modelLeft - 1n)
            const earns = creditsPerAudit.get(audit.modelHash)!
            auditorCreditsLeft = auditorCreditsLeft > earns ? auditorCreditsLeft - earns : 0n
          }
        }
        pending.push({ audit, previous, alreadySubmitted, expectsCredit })
      }

      printPreview(pending, alreadyOnChain)
      for (const { model, count } of alreadyOnChain) {
        if (audits.some((audit) => normalized(audit.model) === normalized(model))) continue
        console.log(chalk.dim(`${model}: nothing new to submit (${count} already on-chain)`))
      }
      const disputed = await loadDisputedSellers({
        reader: verifierClient, epochStartedAt: window.startedAt, deploymentBlock: verifierClient.deploymentBlock,
      })
      const overviewPath = await writeEpochOverview(evidenceDir, manifest.epoch, undefined, disputed)
      if (overviewPath) console.log(chalk.cyan(`Epoch overview (all runs this epoch): ${overviewPath}`))
      for (const exclusion of excluded) {
        console.warn(chalk.yellow(
          `${exclusion.model} ${exclusion.service} (${exclusion.agentId ?? exclusion.peerId}): excluded: ${exclusion.reason}`,
        ))
      }
      console.log(chalk.dim(
        `Epoch ${window.epoch}: ${credited.auditor} credit(s) earned so far; limits ${limits.perModel} credited audit(s) per model, ${limits.perAuditor} credits per auditor. `
        + 'Credits also require at least one audited seller with staked pool power.',
      ))
      const toSubmit = pending.filter((entry) => !entry.alreadySubmitted)
      if (options.dryRun) {
        // What the preparation decided, row by row, for a dry-run report. Best effort: a failed write warns and the dry
        // run is otherwise unchanged.
        try {
          await writeDryRunPrepared(evidenceDir, manifest.epoch, { runIds: sourceRunIds, decisions, alreadyOnChain })
        } catch (error) {
          console.warn(chalk.yellow(`Could not write what this dry run prepared: ${asError(error).message}`))
        }
        console.log(chalk.dim('Dry run complete; nothing was published or sent.'))
        return
      }
      if (toSubmit.length === 0) {
        await recordSubmitOutcome(evidenceDir, manifest.epoch, sourceRunIds, [...heldBack, ...heldInEpoch])
        console.log(chalk.dim('Nothing to submit.'))
        return
      }
      if (publishIpfs) {
        console.warn(chalk.yellow('IPFS publication is public: complete audit evidence and signed exchanges will be pinned.'))
      }
      // Models not published because a `verifier run` of this data dir is going on (`publish`).
      let heldForRun = 0
      const readEpoch = async (): Promise<bigint> => (await verifierClient.currentEpochWindow()).epoch
      if (options.publishOnly) {
        let published = 0
        let failed = 0
        for (const { audit, previous } of toSubmit) {
          // An earlier attempt under this key that may have been sent keeps its entry: only a submit, which reads the
          // chain for it first (`earlierAttemptToCheck`), may replace it.
          if (earlierAttemptToCheck(previous, audit)) {
            console.warn(chalk.yellow(`${audit.key}: not published: an earlier attempt with other evidence may have been sent. `
              + 'Run `antseed verifier submit` first, which checks it on-chain; --publish-only skips this model until a submit has '
              + 'finished it and exited 0.'))
            continue
          }
          try {
            await writeModelAuditEvidence(audit)
            const publication = reusablePublication(previous, audit.evidenceHash)
              ?? await publish(evidenceDir, banksDir, manifest, audit, target, readEpoch)
            ledger.models[audit.key] = ledgerEntry(audit, publication.uri, publication)
            await writeModelAuditLedger(ledgerPath, ledger)
            published += 1
            console.log(chalk.green(`${audit.key}: ${publication.uri} (evidence ${audit.evidenceHash})`))
          } catch (error) {
            if (error instanceof RunInProgressError) {
              heldForRun += 1
              console.warn(chalk.yellow(`${audit.key}: ${error.message}`))
              continue
            }
            failed += 1
            console.warn(chalk.yellow(`${audit.key}: publication failed (continuing): ${asError(error).message}`))
          }
        }
        console.log(`Published: ${published}; failed: ${failed}${heldForRun > 0 ? `; held while a run is in progress: ${heldForRun}` : ''}; nothing was sent on-chain.`)
        console.log(chalk.dim(`Ledger: ${ledgerPath}`))
        if (failed > 0) process.exitCode = 1
        return
      }
      if (!wallet) throw new Error('a signer is required to submit')
      if (!options.yes) await confirmSubmission(toSubmit.length)

      // A transaction an earlier submit sent but did not see mined (its wait hit the deadline, or the
      // process was stopped) is not on-chain yet, so `findSubmission` cannot see it: sending now could
      // send the same audit twice. Wait for it instead; the next submit or watch tick checks again.
      const stillPending = await pendingTransactionCount(verifierClient, address)
      if (stillPending !== 0) {
        console.warn(chalk.yellow(stillPending === null
          ? `Could not read whether ${address} has a transaction still pending, so nothing is sent this time, `
            + 'to be sure no audit goes out twice. The next `antseed verifier submit` or watch tick tries again.'
          : `${stillPending} transaction(s) from ${address} are still pending, perhaps an earlier submit's. `
            + 'Nothing is sent until they are mined or dropped, so no audit goes out twice; the next `antseed verifier submit` or watch tick checks again. '
            + 'If one stays stuck, replace it: send 0 ETH to your own address on the same nonce (`cast nonce --block latest <address>`) with a higher fee, '
            + 'or wait until the RPC drops it. Results not sent by the end of the epoch are lost.'))
        process.exitCode = 1
        return
      }

      // What to run to send what this submit left: the same command, for the same run when one was named.
      const submitAgain = options.runId ? `antseed verifier submit --run-id ${options.runId}` : 'antseed verifier submit'
      const tally = await sendModelAudits(toSubmit, ledger, {
        findSubmission: (audit) => findSubmission(verifierClient, audit, address, epochFirstBlock, auditorSetEvents),
        writeEvidence: (audit) => writeModelAuditEvidence(audit),
        publish: publishIpfs ? (audit) => publish(evidenceDir, banksDir, manifest, audit, target, readEpoch) : null,
        writeLedger: (value) => writeModelAuditLedger(ledgerPath, value),
        recheckBeforeSend,
        submit: async (audit, evidenceUri) => {
          const transactionHash = await verifierClient.submitModelAudit(wallet, {
            expectedEpoch: audit.expectedEpoch,
            modelHash: audit.modelHash,
            evidenceHash: audit.evidenceHash,
            evidenceUri,
            results: audit.results,
          })
          const receipt = await verifierClient.provider.getTransactionReceipt(transactionHash)
          return { transactionHash, blockNumber: receipt?.blockNumber ?? null }
        },
        warn: (line) => console.warn(chalk.yellow(line)),
        log: (kind, line) => console.log(kind === 'recovered' ? chalk.dim(line) : chalk.green(line)),
        submitAgain,
      })
      const { submitted, recovered, rerun, failed, deferred, held, unsent } = tally
      heldForRun += tally.heldForRun
      if (deferred > 0) {
        console.warn(chalk.yellow(`${deferred} model(s) were not sent after the unmined transaction; the next submit or watch tick sends them.`))
      }
      await recordSubmitOutcome(evidenceDir, manifest.epoch, sourceRunIds, [...unsent, ...heldBack, ...heldInEpoch])

      await printConfirmations(verifierClient, window.startedAt, address, pending.map((entry) => entry.audit))
      const after = await verifierClient.auditCredits(address, window.epoch)
      console.log(chalk.bold('Model audit submission summary'))
      console.log(`  Auditor: ${address}`)
      console.log(`  Epoch: ${window.epoch}`)
      console.log(`  Submitted: ${submitted}; recovered: ${recovered}; already submitted: ${pending.length - toSubmit.length}; failed: ${failed}`
        + `${held > 0 ? `; held for a new check: ${held}` : ''}${heldForRun > 0 ? `; held while a run is in progress: ${heldForRun}` : ''}`)
      console.log(`  Seller results left out as already on-chain: ${alreadyOnChain.reduce((total, entry) => total + entry.count, 0)}`)
      console.log(`  Credits this epoch: ${after.auditor} of ${after.total} total`)
      console.log(chalk.dim(`Ledger: ${ledgerPath}`))
      if (rerun > 0) console.warn(chalk.yellow(`${rerun} model(s) have results left to send: run \`${submitAgain}\` again.`))
      if (failed > 0 || rerun > 0) process.exitCode = 1
    })
}

/**
 * The whole current epoch as one submission: for each model and seller, the latest result of any
 * run this epoch (see `writeEpochSubmissionManifest`).
 */
async function epochSubmissionManifest(
  evidenceDir: string, epoch: bigint,
): Promise<{ manifest: VerifierRunManifestV1; runIds: string[]; held: string[] } | null> {
  const state = await loadEpochState(evidenceDir, epoch.toString())
  if (state.manifests.length === 0) return null
  const manifest = await writeEpochSubmissionManifest(evidenceDir, state)
  console.log(chalk.dim(
    `Epoch ${epoch}: merging ${state.manifests.length} run(s) (${state.manifests.map((run) => run.runId.slice(0, 10)).join(', ')}); `
    + 'the latest result per model and seller is submitted.',
  ))
  // A DIFF confirmation that ended UNDETERMINED is held for its re-check (`heldForConfirmationRecheck`), not submitted yet.
  const held = [...state.cells.values()]
    .filter((cell) => heldForConfirmationRecheck(cell))
    .map((cell) => `${cell.model} ${cell.peerId.slice(0, 12)}: confirmation held for its re-check`)
  return { manifest, runIds: state.manifests.map((run) => run.runId), held }
}

/**
 * Why `audit` must not be sent now, or null: the third-opinion check of `prepareModelAudits` again, on
 * this epoch's reports read right before the send. Between the first read and the send come the
 * evidence, IPFS and the duplicate checks, minutes on a slow RPC, and meanwhile another auditor can
 * report on the same seller, or this auditor's confirmation turn can end. A read that fails is a reason
 * too, so the check never fails open.
 */
export async function recheckAuditBeforeSend(input: {
  audit: Pick<PreparedModelAudit, 'modelHash' | 'results'> & Partial<Pick<PreparedModelAudit, 'auditedAt'>> & { evidence: Pick<PreparedModelAudit['evidence'], 'results'> }
  auditor: string
  readEvents: () => Promise<readonly ServiceAuditedEvent[]>
  readMyConfirmations: (events: readonly ServiceAuditedEvent[]) => Promise<ReadonlySet<string>>
  revoked?: ReadonlySet<string>
  /** The same-check rule on fresh events (`sameCheckFilter`): every result is decided again, also one reused from the ledger. */
  sameCheck?: (events: readonly ServiceAuditedEvent[]) => ReturnType<typeof sameCheckFilter>
  /**
   * What this auditor already reported, on fresh events (`alreadyOnChainFilter`): a transaction of an earlier attempt
   * under another ledger key, mined since the preparation, is not sent a second time.
   */
  alreadyOnChain?: (events: readonly ServiceAuditedEvent[]) => ReturnType<typeof alreadyOnChainFilter>
}): Promise<string | null> {
  try {
    const events = await input.readEvents()
    const filter = thirdOpinionFilter({
      events, auditor: input.auditor, myConfirmations: await input.readMyConfirmations(events), revoked: input.revoked,
    })
    const reasons = await filter(input.audit.modelHash, input.audit.results.map((result) => ({ ...result, auditedAt: 0 })))
    const blocked = reasons.filter((reason): reason is string => reason !== null)
    // A row whose audit time is not known is never ordered as the oldest: it is prepared again, where its time is read.
    const timeOf = (result: { agentId: bigint; serviceHash: string }) => input.audit.auditedAt?.[resultTimeKey(result.agentId, result.serviceHash)]
    const untimed = input.audit.results.filter((result) => { const time = timeOf(result); return !(typeof time === 'number' && Number.isFinite(time) && time > 0) }).length
    if (blocked.length === 0 && untimed > 0 && input.alreadyOnChain) blocked.push(`${untimed} result(s) without a known audit time`)
    if (blocked.length === 0 && input.alreadyOnChain) {
      // Each row with its own audit time, as the preparation judged it: a repeated verdict is sent when its audit is
      // newer than this auditor's report (`submission-delta.ts`).
      const reported = await input.alreadyOnChain(events)(input.audit.modelHash, input.audit.results.map((result) => ({
        ...result, auditedAt: timeOf(result)!,
      })))
      const count = reported.filter((entry) => entry === true).length
      if (count > 0) blocked.push(`${count} result(s) this auditor has reported since it was prepared`)
      const superseded = reported.filter((entry) => entry === 'superseded').length
      if (superseded > 0) blocked.push(`${superseded} result(s) held: older than your own report with another verdict, which stands; a newer audit of this seller can change it`)
    }
    if (blocked.length === 0 && input.sameCheck) {
      const changed = await sameCheckChanged(input.audit.modelHash, input.audit.evidence.results, input.sameCheck(events))
      if (changed) blocked.push(changed)
    }
    if (blocked.length === 0) return null
    return `${blocked.length} of its ${input.audit.results.length} result(s) changed since it was prepared (${blocked[0]}${blocked.length > 1 ? ', …' : ''})`
  } catch (error) {
    return `could not re-read this epoch's reports right before sending (${asError(error).message})`
  }
}

/**
 * Decides the same-check rule again for the results of evidence about to be sent, and says what changed, or
 * null when every decision is the one the evidence stores. A result the rule would now leave out, or decide on
 * another first report, means the evidence must be built again: an old DIFF is never re-sent on an old decision.
 */
export async function sameCheckChanged(
  modelHash: string,
  results: readonly ModelAuditSellerResultV1[],
  filter: ReturnType<typeof sameCheckFilter>,
): Promise<string | null> {
  const decisions = await filter(modelHash, results.map((result) => ({
    agentId: BigInt(result.agentId),
    peerId: result.peerId,
    serviceHash: result.serviceHash,
    verdict: verifierVerdict(result.verdict),
    auditedAt: result.auditedAt ?? 0,
    flaggedBy: result.flaggedBy ?? [],
    passedBy: result.passedBy ?? [],
    ...(result.betweenBy ? { betweenBy: result.betweenBy } : {}),
    // The report the audit confirms, as prepared from its evidence: without it a confirmation of FLIPS would read as
    // a first look and be held.
    ...(result.confirming ? { confirming: result.confirming } : {}),
  })))
  for (const [index, decision] of decisions.entries()) {
    const result = results[index]!
    const stored = result.confirmation ?? null
    const now = decision?.kind === 'send' ? decision.confirmation : null
    if (decision && decision.kind !== 'send') return `agent ${result.agentId}: ${decision.reason}`
    if (canonicalJsonStringify(stored) !== canonicalJsonStringify(now)) {
      return `agent ${result.agentId}: the waiting DIFF it answers changed since its evidence was prepared`
    }
  }
  return null
}

/** `<evidence>/.submit.lock`, or null while another live submit holds it (a dead one's lock is taken over). */
export async function acquireSubmitLock(evidenceDir: string): Promise<FileLock | null> {
  try {
    return await acquirePidFileLock(join(evidenceDir, '.submit.lock'))
  } catch (error) {
    if (error instanceof LockHeldError) return null
    throw error
  }
}

/**
 * Says once, in the first submit of an epoch, when the previous epoch ended with runs no submit
 * covered: their results can no longer be sent (`epoch-submission-record.ts`). Never fails a submit.
 */
export async function warnUnsentPreviousEpoch(
  evidenceDir: string, currentEpoch: bigint, warn: (text: string) => void = (text) => console.warn(chalk.yellow(text)),
): Promise<void> {
  if (currentEpoch === 0n) return
  const previous = (currentEpoch - 1n).toString()
  try {
    const unsent = await unsentEpochRuns(evidenceDir, previous)
    if (!unsent) return
    warn(unsentEpochRunsMessage(unsent))
    await markUnsentReported(evidenceDir, previous)
  } catch {
    // Only a warning: an unreadable record must not stop this epoch's submit.
  }
}

/**
 * Transactions from `address` that the RPC knows of but that are not mined yet: the pending nonce
 * ahead of the latest one. Read twice a few seconds apart, so a load-balanced RPC whose nodes lag a
 * block behind each other does not report a just-mined transaction as pending. Null when unreadable:
 * the caller sends nothing then, as a guard that fails open is no guard.
 */
export async function pendingTransactionCount(
  client: Pick<VerifierClient, 'provider'>, address: string, settleMs = 3_000,
): Promise<number | null> {
  const read = async (): Promise<number> => {
    const [pending, latest] = await Promise.all([
      client.provider.getTransactionCount(address, 'pending'),
      client.provider.getTransactionCount(address, 'latest'),
    ])
    return Math.max(0, pending - latest)
  }
  try {
    if (await read() === 0) return 0
    await new Promise((resolve) => setTimeout(resolve, settleMs))
    return await read()
  } catch {
    return null
  }
}

/**
 * Which of this auditor's results this epoch reached the reports their verdict needs (one SAME, two
 * DIFFs by default), and which still wait for another auditor's confirmation.
 */
async function printConfirmations(
  client: VerifierClient, epochStartedAt: number, auditor: string, audits: readonly PreparedModelAudit[],
): Promise<void> {
  if (audits.length === 0) return
  try {
    const reports = await loadEpochReports({ reader: client, epochStartedAt, deploymentBlock: client.deploymentBlock })
    console.log(chalk.bold('Confirmations (distinct auditors reporting each result this epoch)'))
    for (const audit of audits) {
      const results = ownResultTallies({ reports, auditor, modelHash: audit.modelHash })
      const waiting = results.filter((result) => result.tally.reports < result.tally.required)
      console.log(`  ${audit.key}: ${results.length - waiting.length} recorded, ${waiting.length} waiting for another auditor`)
      for (const result of waiting) {
        console.log(chalk.dim(`    agent ${result.agentId}: ${result.tally.verdict} ${result.tally.reports}/${result.tally.required}`))
      }
    }
  } catch (error) {
    console.warn(chalk.yellow(`Could not read confirmations: ${asError(error).message}`))
  }
}

/** Evidence hashes this auditor has already submitted on-chain this epoch (`ownEpochSubmissions`). */
async function submittedEvidenceHashes(
  client: VerifierClient,
  auditor: string,
  epochFirstBlock: number,
  auditorSetEvents: () => Promise<readonly AuditorSetEvent[]>,
): Promise<Map<string, ModelAuditedEvent>> {
  const events = await ownEpochSubmissions({ reader: client, auditor, epochFirstBlock, auditorSetEvents })
  return new Map(events.map((event) => [normalized(event.evidenceHash), event]))
}

/**
 * This auditor's `ModelAudited` submissions of the current epoch that still stand (of one model when
 * given). Only blocks from the epoch's first one are read: `submit` sends only runs of the current
 * epoch, and the contract rejects an audit for any other (`EpochChanged`), so no older event can be a
 * submission of the evidence sent now. A submission before the latest auditor revocation does not
 * stand: the revocation started a new report round everywhere, so its reports no longer count, and
 * when the delta filter (`alreadyOnChainFilter`) selects the same results again, the identical
 * evidence has to be sent again to restore them.
 */
export async function ownEpochSubmissions(input: {
  reader: Pick<VerifierClient, 'queryModelAudits'>
  auditor: string
  model?: string
  /** The current epoch's first block (`firstBlockAtOrAfter` of its start). */
  epochFirstBlock: number
  auditorSetEvents: () => Promise<readonly AuditorSetEvent[]>
}): Promise<ModelAuditedEvent[]> {
  const filter = input.model === undefined ? { auditor: input.auditor } : { model: input.model, auditor: input.auditor }
  return standingSubmissions(await input.reader.queryModelAudits(filter, input.epochFirstBlock), await input.auditorSetEvents())
}

/** The submissions made after the latest auditor revocation (all of them when there was none). */
export function standingSubmissions<T extends { blockNumber: number; logIndex: number }>(
  submissions: readonly T[],
  auditorSetEvents: readonly AuditorSetEvent[],
): T[] {
  const last = revocationPositions(auditorSetEvents).at(-1)
  if (!last) return [...submissions]
  return submissions.filter((event) => (
    event.blockNumber > last.blockNumber || (event.blockNumber === last.blockNumber && event.logIndex > last.logIndex)
  ))
}

/**
 * The ledger key (and evidence path) a model audit is recorded under. Which results are sent depends
 * on the chain, so the same epoch submission can send a model more than once (e.g. after an auditor
 * revocation). A key whose audit is already submitted with other evidence is kept as it is, and the
 * next audit gets `<key>~2`, `<key>~3`, ...; an unfinished attempt keeps its key, so the retry
 * re-sends its evidence when it holds exactly the same seller results (`reuseLedgerEvidence`), and otherwise
 * checks whether it was mined before sending (`earlierAttemptToCheck`).
 */
export function withLedgerKey(
  audit: PreparedModelAudit,
  ledger: Pick<ModelAuditLedgerV1, 'models'>,
  evidenceDir: string,
  runId: string,
): PreparedModelAudit {
  let key = audit.key
  for (let attempt = 2; ; attempt += 1) {
    const previous = ledger.models[key]
    if (!previous || previous.status !== 'submitted' || normalized(previous.evidenceHash) === normalized(audit.evidenceHash)) break
    key = `${audit.key}~${attempt}`
  }
  if (key === audit.key) return audit
  return { ...audit, key, evidencePath: modelAuditEvidencePath(evidenceDir, runId, key) }
}

/**
 * Whether an earlier attempt's evidence holds exactly the seller results prepared now: the same sellers and services,
 * each result equal in every field (verdict, seller evidence, attribution, confirmation, time, extra sets). Only then
 * may it be sent in place of the fresh preparation, which may differ in what the question banks say since.
 */
export function sameSellerResults(
  earlier: readonly ModelAuditSellerResultV1[],
  fresh: readonly ModelAuditSellerResultV1[],
): boolean {
  if (earlier.length !== fresh.length) return false
  const key = (result: ModelAuditSellerResultV1) => `${result.agentId}:${normalized(result.serviceHash)}`
  const now = new Map(fresh.map((result) => [key(result), result]))
  if (now.size !== fresh.length || new Set(earlier.map(key)).size !== earlier.length) return false
  return earlier.every((result) => {
    const match = now.get(key(result))
    return match !== undefined && canonicalJsonStringify(match) === canonicalJsonStringify(result)
  })
}

/**
 * Keeps evidence an earlier attempt wrote when it holds exactly the seller results prepared now, so a retry submits
 * the same evidence hash: its upload may have reached IPFS, and its question set was retired with it. Any other
 * earlier evidence is left, and what was prepared now is sent (`earlierAttemptToCheck` reads the chain first).
 */
export async function reuseLedgerEvidence(
  prepared: PreparedModelAudit[],
  ledger: ModelAuditLedgerV1,
): Promise<PreparedModelAudit[]> {
  const audits: PreparedModelAudit[] = []
  for (const audit of prepared) {
    const previous = ledger.models[audit.key]
    if (!previous || normalized(previous.evidenceHash) === normalized(audit.evidenceHash)) {
      audits.push(audit)
      continue
    }
    // An earlier file that cannot be read, of another model or epoch, or whose reference files are gone, is not
    // reused, whatever its status: what was prepared now is sent, and `earlierAttemptToCheck` reads the chain for the
    // earlier hash first, which is the protection a refusal here stood for.
    try {
      const evidence = await readModelAuditEvidence(previous.evidencePath, previous.evidenceHash)
      const sameEnvelope = normalized(evidence.modelHash) === normalized(audit.modelHash) && evidence.epoch === audit.evidence.epoch
      if (!sameEnvelope || !sameSellerResults(evidence.results, audit.evidence.results)) {
        audits.push(audit)
        continue
      }
      // The reused document is uploaded with the reference files it names, read from beside it, each the reference it
      // is recorded as (its id and its question count).
      const references: PreparedModelAudit['references'] = []
      for (const entry of evidence.references) {
        if (entry.path === null) continue
        const path = resolve(dirname(previous.evidencePath), entry.path)
        // Validated as a reference is everywhere, its content id recomputed: a damaged file that keeps its id fails.
        const reference = validateKbfReferenceV1(JSON.parse(await readFile(path, 'utf8')), {
          minimumStatisticalPower: Number.EPSILON, minimumCalibrationPower: Number.EPSILON,
        })
        if (reference.referenceId !== entry.referenceId || reference.probes.length !== entry.probeCount) {
          throw new Error(`${entry.path} is not the reference the earlier document names`)
        }
        references.push({ path, reference })
      }
      const reused = preparedFromEvidence(audit.key, previous.evidencePath, evidence, audit.auditEvidencePaths)
      // The whole bundle, or no reuse: each raw reference exchange file read and hashed against the document, or its
      // packaging would fail on every retry, or publish bytes that disagree with the recorded hash.
      for (const entry of evidence.referenceEvidence ?? []) {
        const bytes = await readFile(resolve(dirname(previous.evidencePath), entry.path))
        if (entry.sha256 && `sha256:${createHash('sha256').update(bytes).digest('hex')}` !== entry.sha256) {
          throw new Error(`${entry.path} does not match its recorded sha256`)
        }
      }
      audits.push({
        ...reused, references,
        // The same results as prepared now, so the same audit times.
        ...(audit.auditedAt ? { auditedAt: audit.auditedAt } : {}),
      })
    } catch {
      audits.push(audit)
    }
  }
  return audits
}

/**
 * The evidence hash of an earlier attempt under this audit's key that may have been sent and is not this evidence,
 * or null. A submit that stopped after sending, or whose wait for the receipt ran out or failed, leaves its entry
 * pending or failed, and its transaction may have been mined since. Before the fresh audit is sent, a chain read
 * must show that hash is not there (`findSubmission`). The earlier evidence is sent in place of what was prepared now
 * only when its seller results are the same (`sameSellerResults`): otherwise it may lack a seller found since.
 */
export function earlierAttemptToCheck(
  previous: Pick<ModelAuditLedgerEntryV1, 'status' | 'evidenceHash'> | null,
  audit: Pick<PreparedModelAudit, 'evidenceHash'>,
): string | null {
  if (!previous || previous.status === 'submitted') return null
  return normalized(previous.evidenceHash) === normalized(audit.evidenceHash) ? null : previous.evidenceHash
}

function ledgerEntry(
  audit: PreparedModelAudit,
  evidenceUri: string,
  publication: AuditPublicationV1 | undefined,
): ModelAuditLedgerEntryV1 {
  return {
    key: audit.key,
    model: audit.model,
    modelHash: audit.modelHash,
    evidenceHash: audit.evidenceHash,
    evidencePath: audit.evidencePath,
    resultCount: audit.results.length,
    evidenceUri,
    ...(publication ? { publication } : {}),
    // Each row's audit time: a later submit compares a newer vote with the audit behind this one.
    ...(audit.auditedAt ? { auditedAt: audit.auditedAt } : {}),
    status: 'pending',
    transactionHash: null,
    blockNumber: null,
    error: null,
    lastAttemptAt: new Date().toISOString(),
  }
}

/** A standing submission of this exact evidence (see `submittedEvidenceHashes`), e.g. one a crashed attempt sent. */
async function findSubmission(
  client: VerifierClient,
  audit: Pick<PreparedModelAudit, 'modelHash' | 'evidenceHash'>,
  auditor: string,
  epochFirstBlock: number,
  auditorSetEvents: () => Promise<readonly AuditorSetEvent[]>,
) {
  // A read that fails is an error, not "not found": sending after a failed check could send twice.
  let events
  try {
    events = await ownEpochSubmissions({ reader: client, auditor, model: audit.modelHash, epochFirstBlock, auditorSetEvents })
  } catch (error) {
    throw new Error(`could not check whether this audit is already on-chain, so it is not sent (${asError(error).message})`)
  }
  return events.find((event) => normalized(event.evidenceHash) === normalized(audit.evidenceHash)) ?? null
}

async function publish(
  evidenceDir: string,
  banksDir: string,
  manifest: Pick<VerifierRunManifestV1, 'runId' | 'epoch'>,
  audit: PreparedModelAudit,
  target: PublicationTarget,
  /** The chain's current epoch, read again right before the retire. */
  readEpoch: () => Promise<bigint>,
): Promise<AuditPublicationV1> {
  // No upload while a `verifier run` of this data dir is going on: its audits may still be asking this
  // epoch's questions and its builds adding to them. The run lock is held from the retire until the
  // upload has returned, so no run starts in between either.
  let runLock: FileLock
  try {
    runLock = await acquirePidFileLock(join(evidenceDir, '.run.lock'), {
      heldMessage: 'a `verifier submit` is publishing audit evidence; run again when it has finished',
    })
  } catch (error) {
    if (error instanceof LockHeldError) throw new RunInProgressError(audit.model)
    throw error
  }
  try {
    // Once the chain is in the next epoch this audit's transaction can't land, and the upload could carry
    // that epoch's new questions, which the retire below (of this epoch's set) would not take out of use.
    let chainEpoch: bigint
    try {
      chainEpoch = await readEpoch()
    } catch (error) {
      throw new Error(`could not read the chain's epoch right before the upload (${asError(error).message}), so nothing of ${audit.model} is published`)
    }
    if (chainEpoch !== BigInt(manifest.epoch)) {
      throw new Error(`the chain is in epoch ${chainEpoch} now, so nothing of ${audit.model} from epoch ${manifest.epoch} is published: its audit could no longer be recorded`)
    }
    const packaged = await prepareAuditPublication({
      evidenceDir,
      runId: manifest.runId,
      model: audit.key,
      evidenceHash: audit.evidenceHash,
      evidencePath: audit.evidencePath,
      evidenceBytes: canonicalEvidenceBytes(audit.evidence),
      referencePaths: audit.references.map((reference) => reference.path),
      auditEvidencePaths: audit.auditEvidencePaths,
      referenceEvidencePaths: audit.referenceEvidence.map((entry) => entry.path),
      upstreams: modelAuditUpstreams(audit),
    })
    // The upload makes its references and the bank exchange files it lists public: the questions and
    // answers of this epoch's set and pool when they are in it, so those are retired first. An upload
    // that then fails costs a rebuild, never a public set still in use.
    const { retired } = await retireEpochQuestionSet({
      banksDir, model: audit.model, epoch: manifest.epoch, runId: manifest.runId,
      published: {
        referenceIds: audit.evidence.references.map((reference) => reference.referenceId),
        exchanges: (audit.evidence.referenceEvidence ?? []).map(({ referenceId, sha256 }) => ({ referenceId, sha256 })),
      },
    })
    if (retired) {
      console.log(chalk.dim(`${audit.key}: its epoch ${manifest.epoch} questions are published with it; a later audit of ${audit.model} this epoch gets new ones`))
    }
    const published = target.kind === 'local-test'
      ? await publishVerificationToDirectory(packaged, target.directory)
      : await publishVerificationToPinata(packaged, target.jwt)
    return {
      provider: published.provider,
      evidenceHash: published.evidenceHash,
      cid: published.cid,
      uri: published.uri,
      pinSize: published.pinSize,
      totalBytes: packaged.totalBytes,
      fileCount: published.fileCount,
      publishedAt: published.publishedAt,
    }
  } finally {
    await runLock.release()
  }
}

/** Why `publish` sent nothing: a `verifier run` holds the data dir's run lock. */
class RunInProgressError extends Error {
  constructor(model: string) {
    super(`a \`verifier run\` is in progress, so nothing of ${model} is published now; submit again when it has finished`)
    this.name = 'RunInProgressError'
  }
}

function reusablePublication(previous: ModelAuditLedgerEntryV1 | null, evidenceHash: string): AuditPublicationV1 | undefined {
  const publication = previous?.publication
  if (!publication || normalized(publication.evidenceHash) !== normalized(evidenceHash)) return undefined
  if (!publication.cid || publication.uri !== `ipfs://${publication.cid}`) return undefined
  return publication
}

function printPreview(pending: readonly PendingModelAudit[], alreadyOnChain: ReadonlyArray<{ model: string; count: number }>): void {
  if (pending.length === 0) return
  const table = new Table({ head: ['Model', 'Sellers', 'SAME', 'DIFF', 'UNDETERMINED', 'On-chain', 'Credit', 'Status'] })
  for (const { audit, alreadySubmitted, expectsCredit } of pending) {
    const count = (verdict: string) => audit.evidence.results.filter((result) => result.verdict === verdict).length
    const onChain = alreadyOnChain.find((entry) => normalized(entry.model) === normalized(audit.model))?.count ?? 0
    table.push([
      audit.key,
      String(audit.results.length),
      String(count('SAME')),
      String(count('DIFF')),
      String(count('UNDETERMINED')),
      // Results of this model left out because they are already on-chain (counted once, on the first part).
      audit.evidence.part === 1 ? String(onChain) : '',
      alreadySubmitted ? '-' : expectsCredit ? 'expected' : 'cap reached',
      alreadySubmitted ? 'already submitted' : 'ready',
    ])
  }
  console.log(table.toString())
}

async function confirmSubmission(count: number): Promise<void> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('refusing non-interactive on-chain submission without --yes')
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await prompt.question(`Submit ${count} model audit transaction(s)? [y/N] `)
    if (!['y', 'yes'].includes(answer.trim().toLowerCase())) throw new Error('submission cancelled')
  } finally {
    prompt.close()
  }
}

/** What one submit's send loop needs from outside: the chain, the files and the publisher, so it can be tested apart. */
export interface SendLoopDeps {
  /** The auditor's `ModelAudited` event for this evidence, if any (`findSubmission`). */
  findSubmission: (audit: { modelHash: string; evidenceHash: string }) => Promise<{ transactionHash: string; blockNumber: number; evidenceUri?: string } | null>
  writeEvidence: (audit: PreparedModelAudit) => Promise<void>
  /** Publishes the evidence (IPFS); null when publication is off. */
  publish: ((audit: PreparedModelAudit) => Promise<AuditPublicationV1>) | null
  writeLedger: (ledger: ModelAuditLedgerV1) => Promise<void>
  /** The last read before a send (`recheckAuditBeforeSend`): a reason not to send now, or null. */
  recheckBeforeSend: (audit: PreparedModelAudit) => Promise<string | null>
  /** Sends the audit and reads its receipt. */
  submit: (audit: PreparedModelAudit, evidenceUri: string) => Promise<{ transactionHash: string; blockNumber: number | null }>
  warn: (line: string) => void
  /** What the loop did for one audit: found it already on chain (`recovered`), or sent it (`submitted`). */
  log: (kind: 'recovered' | 'submitted', line: string) => void
  /** The command to run to send what this submit left. */
  submitAgain: string
}

/** What a send loop did, for the summary and the record the next epoch reads. */
export interface SendLoopTally {
  submitted: number
  recovered: number
  /** Models whose remaining results go out only with another submit. */
  rerun: number
  failed: number
  notMined: number
  deferred: number
  held: number
  heldForRun: number
  /** What this submit did not send (`recordSubmitOutcome`). */
  unsent: string[]
}

/**
 * Sends each prepared model audit in turn, keeping the ledger: an earlier attempt that may have been sent is looked up
 * on chain first, a DIFF goes out only with its publication, an audit already recorded is not sent again, and the last
 * read before a send can hold it. After an unmined transaction nothing more is sent. Never throws for one model.
 */
export async function sendModelAudits(
  items: ReadonlyArray<{ audit: PreparedModelAudit; previous: ModelAuditLedgerEntryV1 | null }>,
  ledger: ModelAuditLedgerV1,
  deps: SendLoopDeps,
): Promise<SendLoopTally> {
  const tally: SendLoopTally = { submitted: 0, recovered: 0, rerun: 0, failed: 0, notMined: 0, deferred: 0, held: 0, heldForRun: 0, unsent: [] }
  for (const { audit, previous } of items) {
    if (tally.notMined > 0) {
      // The nonce after an unmined transaction would not mine before it either.
      tally.deferred += 1
      tally.failed += 1
      tally.unsent.push(`${audit.key}: not sent after an unmined transaction`)
      continue
    }
    let publication = reusablePublication(previous, audit.evidenceHash)
    try {
      const earlier = earlierAttemptToCheck(previous, audit)
      if (earlier) {
        // An earlier attempt under this key sent other evidence, or may have: no transaction is pending now
        // (`pendingTransactionCount`), so it is either mined or gone. Mined, its results are on-chain and this
        // preparation may repeat them: record it, and the next submit prepares the model again without them.
        const sent = await deps.findSubmission({ modelHash: audit.modelHash, evidenceHash: earlier })
        if (sent && previous) {
          ledger.models[audit.key] = {
            ...previous, status: 'submitted', error: null,
            transactionHash: sent.transactionHash, blockNumber: sent.blockNumber,
          }
          await deps.writeLedger(ledger)
          tally.recovered += 1
          tally.rerun += 1
          tally.unsent.push(`${audit.key}: not sent: an earlier attempt's evidence is on-chain; the next submit prepares it again`)
          // Its other results are not lost, but they go out only with the next submit: say so, and exit 1, so a
          // submit run by hand is run again (on the last submit of an epoch they are otherwise lost).
          deps.warn((`${audit.key}: an earlier attempt's evidence is on-chain and the ledger is updated; `
            + `the results it did not hold are not sent yet. Run \`${deps.submitAgain}\` again to send them.`))
          continue
        }
      }
      await deps.writeEvidence(audit)
      if (deps.publish && !publication) publication = await deps.publish(audit)
      // Only a URI of exactly this evidence: an earlier attempt's names other evidence when its hash differs.
      const evidenceUri = publication?.uri
        ?? (previous && normalized(previous.evidenceHash) === normalized(audit.evidenceHash) ? previous.evidenceUri : '')
      // A DIFF is sent only with a publication of exactly this evidence: a confirmer reads which check flagged from
      // it (same-check.ts).
      if (audit.results.some((result) => result.verdict === verifierVerdict('DIFF')) && !publication) {
        // Its ledger entry goes, so the next submit prepares the model again and its other results are not stuck.
        delete ledger.models[audit.key]
        await deps.writeLedger(ledger)
        tally.held += 1
        tally.unsent.push(`${audit.key}: not sent: its DIFF has no publication of this evidence`)
        deps.warn((`${audit.key}: not sent: a DIFF goes out only with its evidence published to IPFS, and this evidence is not. `
          + 'Submit again with publication on; the DIFF is otherwise lost this epoch.'))
        continue
      }
      const entry = ledgerEntry(audit, evidenceUri, publication)
      ledger.models[audit.key] = entry
      await deps.writeLedger(ledger)

      const event = await deps.findSubmission(audit)
      if (event) {
        ledger.models[audit.key] = {
          ...entry,
          status: 'submitted',
          transactionHash: event.transactionHash,
          blockNumber: event.blockNumber,
          evidenceUri: event.evidenceUri || evidenceUri,
        }
        await deps.writeLedger(ledger)
        tally.recovered += 1
        deps.log('recovered', `${audit.key}: already recorded on-chain; ledger updated`)
        continue
      }

      const changed = await deps.recheckBeforeSend(audit)
      if (changed) {
        // Its ledger entry goes, so the next submit builds the audit again from the results that may
        // still be sent.
        delete ledger.models[audit.key]
        await deps.writeLedger(ledger)
        tally.held += 1
        // Its other rows are still unsent: say what to run, and exit non-zero so a submit run by hand is run again.
        tally.rerun += 1
        tally.unsent.push(`${audit.key}: held for a new check (${changed})`)
        deps.warn((`${audit.key}: not sent: ${changed}. Its other results are prepared again by \`${deps.submitAgain}\` `
          + '(or the next watch tick).'))
        continue
      }

      const { transactionHash, blockNumber } = await deps.submit(audit, evidenceUri)
      ledger.models[audit.key] = {
        ...entry,
        status: 'submitted',
        transactionHash,
        blockNumber,
        lastAttemptAt: new Date().toISOString(),
      }
      await deps.writeLedger(ledger)
      tally.submitted += 1
      deps.log('submitted', `${audit.key}: submitted ${audit.results.length} seller result(s) (${transactionHash})`)
    } catch (error) {
      if (error instanceof RunInProgressError) {
        // Held, not failed: nothing was published or sent, and the ledger is as it was.
        tally.heldForRun += 1
        tally.unsent.push(`${audit.key}: held while a verifier run is in progress`)
        deps.warn((`${audit.key}: ${error.message}`))
        continue
      }
      const message = asError(error).message
      const unmined = error instanceof ReceiptWaitTimeoutError ? error : null
      ledger.models[audit.key] = {
        ...(ledger.models[audit.key] ?? ledgerEntry(audit, publication?.uri ?? '', publication)),
        status: 'failed',
        error: message,
        ...(unmined ? { transactionHash: unmined.hashes.at(-1) ?? null } : {}),
        lastAttemptAt: new Date().toISOString(),
      }
      await deps.writeLedger(ledger)
      tally.failed += 1
      if (unmined) tally.notMined += 1
      tally.unsent.push(`${audit.key}: ${unmined ? 'sent but not mined' : `failed (${message.slice(0, 160)})`}`)
      deps.warn((`${audit.key}: ${describeSubmissionFailure(error)}`))
    }
  }
  return tally
}
