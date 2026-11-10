import { join } from 'node:path'
import { acquirePidFileLock, type FileLock } from '../../../verifier/atomic-files.js'
import { createInterface } from 'node:readline/promises'
import chalk from 'chalk'
import pkg from '../../../../package.json' with { type: 'json' }
import { closeFinishedAuditWindows, readAuditWindow } from '../../../verifier/audit-window.js'
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
  preparedFromEvidence,
  readModelAuditEvidence,
  readModelAuditLedger,
  modelAuditUpstreams,
  writeModelAuditEvidence,
  writeModelAuditLedger,
  type AuditPublicationV1,
  type ModelAuditLedgerEntryV1,
  type ModelAuditLedgerV1,
  type PreparedModelAudit,
} from '../../../verifier/model-audit.js'
import { readVerifierRunManifest, type VerifierRunManifestV1 } from '../../../verifier/audit-artifacts.js'
import { prepareAuditPublication, publishVerificationToPinata } from '../../../verifier/ipfs-publication.js'
import { asError, normalized } from '../../../verifier/utils.js'
import { createVerifierClient, useVerifierEventCache } from '../../payment-utils.js'
import { resolveAuditorAddress, resolveAuditorSigner } from './auditor-identity.js'
import { writeEpochOverview } from '../../../verifier/epoch-overview.js'
import { heldForConfirmationRecheck, loadEpochState, writeEpochSubmissionManifest } from '../../../verifier/epoch-plan.js'
import { getGlobalOptions } from '../types.js'
import {
  epochReports, loadBlockTimestamps, loadDisputedSellers, loadEpochAuditEvents, loadEpochReports, ownResultTallies, pendingConfirmations, waitingReportBlocks,
} from '../../../verifier/pending-confirmations.js'
import { alreadyOnChainFilter, revocationPositions } from '../../../verifier/submission-delta.js'
import { opinionKey, thirdOpinionFilter } from '../../../verifier/third-opinion.js'
import { approvedAuditorsAt, loadAuditorSetEvents, revokedSinceEpochStart } from '../../../verifier/auditor-set.js'
import { configuredVerifierModels } from '../../../verifier/model-config.js'
import {
  markUnsentReported, recordSubmitOutcome, unsentEpochRuns, unsentEpochRunsMessage,
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
    .option('--auditor <address>', 'with --publish-only: auditor address the evidence is written for, so no signer is needed')
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
      if (options.auditor && !options.publishOnly) throw new Error('--auditor is only valid with --publish-only')
      const { wallet, address } = options.auditor
        ? { wallet: null, address: getAddress(options.auditor) }
        : options.publishOnly
          ? { wallet: null, ...await resolveAuditorAddress({ config: config.verifier, dataDir: globalOptions.dataDir }) }
          : await resolveAuditorSigner({
            config: config.verifier, dataDir: globalOptions.dataDir, keystoreFlag: options.keystore,
          })
      const publishIpfs = options.publishIpfs !== false
      const pinataJwt = publishIpfs ? process.env['PINATA_JWT']?.trim() : undefined
      if (publishIpfs && !pinataJwt) {
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
      // Windows whose sellers are all finished (or that the end of the epoch closes) are submitted now.
      if (!options.dryRun) {
        for (const closed of await closeFinishedAuditWindows({
          evidenceDir, epoch: manifest.epoch, state: await loadEpochState(evidenceDir, manifest.epoch),
          secondsLeftInEpoch: window.endsAt - await chainNow(verifierClient.provider),
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
      const readMyConfirmations = async (events: readonly ServiceAuditedEvent[]): Promise<Set<string>> => {
        const mine = new Set<string>()
        const setEvents = await auditorSetEvents()
        const reports = epochReports(events)
        const blockTimestamps = await loadBlockTimestamps({ getBlock: (block) => verifierClient.provider.getBlock(block) }, waitingReportBlocks(reports))
        for (const entry of pendingConfirmations({
          reports,
          epoch: window.epoch,
          blockTimestamps,
          revoked: revokedSinceEpochStart(setEvents, window.startedAt),
          now: await chainNow(verifierClient.provider),
          auditor: address,
          auditors: approvedAuditorsAt(setEvents, window.startedAt),
          auditedModels: configuredVerifierModels(config.verifier),
        })) if (entry.mine) mine.add(opinionKey(entry.agentId, entry.serviceHash, entry.modelHash))
        return mine
      }
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
      /**
       * The third-opinion check again, on the events up to now, right before `audit` is sent. Between
       * the first read and the send come the evidence, IPFS and the duplicate checks, and another
       * auditor can report on the same seller meanwhile; or this auditor's confirmation turn can end.
       * The reason not to send it now, or null. A failed read is a reason too: the check must not fail open.
       */
      const recheckBeforeSend = (audit: PreparedModelAudit): Promise<string | null> => recheckAuditBeforeSend({
        audit, auditor: address, readEvents: readEpochEvents, readMyConfirmations, revoked,
      })
      const { audits: prepared, excluded, alreadyOnChain, heldBack } = await prepareModelAudits({
        evidenceDir,
        banksDir,
        manifest,
        auditor: address,
        resolveAgentOwner: (agentId) => verifierClient.agentOwner(agentId),
        config: config.verifier,
        auditWindow: (model) => readAuditWindow(evidenceDir, manifest.epoch, model),
        alreadyOnChain: alreadyOnChainFilter({
          events: epochEvents,
          auditor: address,
          epoch: window.epoch,
          reader: {
            reportRound: (agentId, service) => verifierClient.reportRound(agentId, service),
            serviceStatusByHash: (agentId, service) => verifierClient.serviceStatusByHash(agentId, service),
            blockTimestamp: async (blockNumber) => {
              const block = await verifierClient.provider.getBlock(blockNumber)
              if (!block) throw new Error(`block ${blockNumber} is unavailable`)
              return block.timestamp
            },
          },
          auditorSetEvents,
        }),
        // Never a third opinion: a seller judged by another auditor this epoch is not reported on again,
        // except to confirm a DIFF this auditor is the confirmer of (third-opinion.ts).
        thirdOpinion: thirdOpinionFilter({ events: epochEvents, auditor: address, myConfirmations, revoked }),
      })
      const audits = await reuseLedgerEvidence(
        prepared.map((audit) => withLedgerKey(audit, ledger, evidenceDir, manifest.runId)), ledger,
      )
      const submittedEvidence = await submittedEvidenceHashes(verifierClient, address, auditorSetEvents)
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
      if (options.publishOnly) {
        let published = 0
        let failed = 0
        for (const { audit, previous } of toSubmit) {
          try {
            await writeModelAuditEvidence(audit)
            const publication = reusablePublication(previous, audit.evidenceHash)
              ?? await publish(evidenceDir, manifest.runId, audit, pinataJwt!)
            ledger.models[audit.key] = ledgerEntry(audit, publication.uri, publication)
            await writeModelAuditLedger(ledgerPath, ledger)
            published += 1
            console.log(chalk.green(`${audit.key}: ${publication.uri} (evidence ${audit.evidenceHash})`))
          } catch (error) {
            failed += 1
            console.warn(chalk.yellow(`${audit.key}: publication failed (continuing): ${asError(error).message}`))
          }
        }
        console.log(`Published: ${published}; failed: ${failed}; nothing was sent on-chain.`)
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

      let submitted = 0
      let recovered = 0
      let failed = 0
      let notMined = 0
      let deferred = 0
      let held = 0
      /** What this submit did not send, for the record the next epoch reads (`recordSubmitOutcome`). */
      const unsent: string[] = []
      for (const { audit, previous } of toSubmit) {
        if (notMined > 0) {
          // The nonce after an unmined transaction would not mine before it either.
          deferred += 1
          failed += 1
          unsent.push(`${audit.key}: not sent after an unmined transaction`)
          continue
        }
        let publication = reusablePublication(previous, audit.evidenceHash)
        try {
          await writeModelAuditEvidence(audit)
          if (publishIpfs && !publication) publication = await publish(evidenceDir, manifest.runId, audit, pinataJwt!)
          const evidenceUri = publication?.uri ?? previous?.evidenceUri ?? ''
          const entry = ledgerEntry(audit, evidenceUri, publication)
          ledger.models[audit.key] = entry
          await writeModelAuditLedger(ledgerPath, ledger)

          const event = await findSubmission(verifierClient, audit, address, auditorSetEvents)
          if (event) {
            ledger.models[audit.key] = {
              ...entry,
              status: 'submitted',
              transactionHash: event.transactionHash,
              blockNumber: event.blockNumber,
              evidenceUri: event.evidenceUri || evidenceUri,
            }
            await writeModelAuditLedger(ledgerPath, ledger)
            recovered += 1
            console.log(chalk.dim(`${audit.key}: already recorded on-chain; ledger updated`))
            continue
          }

          const changed = await recheckBeforeSend(audit)
          if (changed) {
            // Its ledger entry goes, so the next submit builds the audit again from the results that may
            // still be sent instead of re-sending this evidence (`reuseLedgerEvidence`).
            delete ledger.models[audit.key]
            await writeModelAuditLedger(ledgerPath, ledger)
            held += 1
            unsent.push(`${audit.key}: held for a new check (${changed})`)
            console.warn(chalk.yellow(`${audit.key}: not sent: ${changed}. The next submit or watch tick prepares it again.`))
            continue
          }

          const transactionHash = await verifierClient.submitModelAudit(wallet, {
            expectedEpoch: audit.expectedEpoch,
            modelHash: audit.modelHash,
            evidenceHash: audit.evidenceHash,
            evidenceUri,
            results: audit.results,
          })
          const receipt = await verifierClient.provider.getTransactionReceipt(transactionHash)
          ledger.models[audit.key] = {
            ...entry,
            status: 'submitted',
            transactionHash,
            blockNumber: receipt?.blockNumber ?? null,
            lastAttemptAt: new Date().toISOString(),
          }
          await writeModelAuditLedger(ledgerPath, ledger)
          submitted += 1
          console.log(chalk.green(`${audit.key}: submitted ${audit.results.length} seller result(s) (${transactionHash})`))
        } catch (error) {
          const message = asError(error).message
          const unmined = error instanceof ReceiptWaitTimeoutError ? error : null
          ledger.models[audit.key] = {
            ...(ledger.models[audit.key] ?? ledgerEntry(audit, publication?.uri ?? '', publication)),
            status: 'failed',
            error: message,
            ...(unmined ? { transactionHash: unmined.hashes.at(-1) ?? null } : {}),
            lastAttemptAt: new Date().toISOString(),
          }
          await writeModelAuditLedger(ledgerPath, ledger)
          failed += 1
          if (unmined) notMined += 1
          unsent.push(`${audit.key}: ${unmined ? 'sent but not mined' : `failed (${message.slice(0, 160)})`}`)
          console.warn(chalk.yellow(`${audit.key}: ${describeSubmissionFailure(error)}`))
        }
      }
      if (deferred > 0) {
        console.warn(chalk.yellow(`${deferred} model(s) were not sent after the unmined transaction; the next submit or watch tick sends them.`))
      }
      await recordSubmitOutcome(evidenceDir, manifest.epoch, sourceRunIds, [...unsent, ...heldBack, ...heldInEpoch])

      await printConfirmations(verifierClient, window.startedAt, address, pending.map((entry) => entry.audit))
      const after = await verifierClient.auditCredits(address, window.epoch)
      console.log(chalk.bold('Model audit submission summary'))
      console.log(`  Auditor: ${address}`)
      console.log(`  Epoch: ${window.epoch}`)
      console.log(`  Submitted: ${submitted}; recovered: ${recovered}; already submitted: ${pending.length - toSubmit.length}; failed: ${failed}${held > 0 ? `; held for a new check: ${held}` : ''}`)
      console.log(`  Seller results left out as already on-chain: ${alreadyOnChain.reduce((total, entry) => total + entry.count, 0)}`)
      console.log(`  Credits this epoch: ${after.auditor} of ${after.total} total`)
      console.log(chalk.dim(`Ledger: ${ledgerPath}`))
      if (failed > 0) process.exitCode = 1
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
  audit: Pick<PreparedModelAudit, 'modelHash' | 'results'>
  auditor: string
  readEvents: () => Promise<readonly ServiceAuditedEvent[]>
  readMyConfirmations: (events: readonly ServiceAuditedEvent[]) => Promise<ReadonlySet<string>>
  revoked?: ReadonlySet<string>
}): Promise<string | null> {
  try {
    const events = await input.readEvents()
    const filter = thirdOpinionFilter({
      events, auditor: input.auditor, myConfirmations: await input.readMyConfirmations(events), revoked: input.revoked,
    })
    const reasons = await filter(input.audit.modelHash, input.audit.results.map((result) => ({ ...result, auditedAt: 0 })))
    const blocked = reasons.filter((reason): reason is string => reason !== null)
    if (blocked.length === 0) return null
    return `${blocked.length} of its ${input.audit.results.length} result(s) changed since it was prepared (${blocked[0]}${blocked.length > 1 ? ', …' : ''})`
  } catch (error) {
    return `could not re-read this epoch's reports right before sending (${asError(error).message})`
  }
}

/** `<evidence>/.submit.lock`, or null while another live submit holds it (a dead one's lock is taken over). */
export async function acquireSubmitLock(evidenceDir: string): Promise<FileLock | null> {
  try {
    return await acquirePidFileLock(join(evidenceDir, '.submit.lock'))
  } catch (error) {
    if (/already active/.test(asError(error).message)) return null
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

/** Evidence hashes this auditor has already submitted on-chain, read from its `ModelAudited` events. */
/**
 * Evidence this auditor has on-chain that still stands. A submission before the latest auditor
 * revocation does not: the revocation started a new report round everywhere, so its reports no
 * longer count, and when the delta filter (`alreadyOnChainFilter`) selects the same results again,
 * the identical evidence has to be sent again to restore them.
 */
async function submittedEvidenceHashes(
  client: VerifierClient,
  auditor: string,
  auditorSetEvents: () => Promise<readonly AuditorSetEvent[]>,
): Promise<Map<string, ModelAuditedEvent>> {
  const events = standingSubmissions(await client.queryModelAudits({ auditor }), await auditorSetEvents())
  return new Map(events.map((event) => [normalized(event.evidenceHash), event]))
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
 * re-sends its evidence (`reuseLedgerEvidence`).
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

/** Keeps evidence an earlier attempt wrote, so a retry submits the same evidence hash. */
async function reuseLedgerEvidence(
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
    try {
      const evidence = await readModelAuditEvidence(previous.evidencePath, previous.evidenceHash)
      audits.push(preparedFromEvidence(audit.key, previous.evidencePath, evidence, audit.auditEvidencePaths))
    } catch (error) {
      if (previous.status !== 'failed') {
        throw new Error(`${audit.key}: earlier evidence ${previous.evidencePath} is unreadable: ${asError(error).message}`)
      }
      audits.push(audit)
    }
  }
  return audits
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
  audit: PreparedModelAudit,
  auditor: string,
  auditorSetEvents: () => Promise<readonly AuditorSetEvent[]>,
) {
  // A read that fails is an error, not "not found": sending after a failed check could send twice.
  let events
  try {
    events = standingSubmissions(await client.queryModelAudits({ model: audit.modelHash, auditor }), await auditorSetEvents())
  } catch (error) {
    throw new Error(`could not check whether this audit is already on-chain, so it is not sent (${asError(error).message})`)
  }
  return events.find((event) => normalized(event.evidenceHash) === normalized(audit.evidenceHash)) ?? null
}

async function publish(
  evidenceDir: string,
  runId: string,
  audit: PreparedModelAudit,
  pinataJwt: string,
): Promise<AuditPublicationV1> {
  const packaged = await prepareAuditPublication({
    evidenceDir,
    runId,
    model: audit.key,
    evidenceHash: audit.evidenceHash,
    evidencePath: audit.evidencePath,
    evidenceBytes: canonicalEvidenceBytes(audit.evidence),
    referencePaths: audit.references.map((reference) => reference.path),
    auditEvidencePaths: audit.auditEvidencePaths,
    referenceEvidencePaths: audit.referenceEvidence.map((entry) => entry.path),
    upstreams: modelAuditUpstreams(audit),
  })
  const published = await publishVerificationToPinata(packaged, pinataJwt)
  return {
    provider: 'pinata',
    evidenceHash: published.evidenceHash,
    cid: published.cid,
    uri: published.uri,
    pinSize: published.pinSize,
    totalBytes: packaged.totalBytes,
    fileCount: published.fileCount,
    publishedAt: published.publishedAt,
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
