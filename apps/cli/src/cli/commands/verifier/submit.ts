import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import chalk from 'chalk'
import Table from 'cli-table3'
import type { Command } from 'commander'
import { getAddress } from 'ethers'
import type { VerifierClient } from '@antseed/node/payments'
import { loadConfig } from '../../../config/loader.js'
import {
  canonicalEvidenceBytes,
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
import { createVerifierClient } from '../../payment-utils.js'
import { resolveAuditorAddress, resolveAuditorSigner } from './auditor-identity.js'
import { writeEpochOverview } from '../../../verifier/epoch-overview.js'
import { getGlobalOptions } from '../types.js'

interface SubmitOptions {
  runId: string
  publishIpfs?: boolean
  dryRun?: boolean
  publishOnly?: boolean
  auditor?: string
  yes?: boolean
  rpcUrl?: string
  keystore?: string
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
    .description('Submit one audit per model from a completed verifier run (approved auditors only)')
    .requiredOption('--run-id <run-id>', 'completed verifier run ID')
    .option('--publish-ipfs', 'publish each model audit\'s public evidence to Pinata and record its ipfs:// URI')
    .option('--dry-run', 'preview the audits without publishing or broadcasting')
    .option('--publish-only', 'with --publish-ipfs: write and publish each model audit\'s evidence and record it in the ledger, without sending transactions')
    .option('--auditor <address>', 'with --publish-only: auditor address the evidence is written for, so no signer is needed')
    .option('--yes', 'submit without an interactive confirmation prompt')
    .option('--rpc-url <url>', 'Base JSON-RPC URL override')
    .option('--keystore <path>', 'sign with this encrypted JSON keystore (e.g. a Foundry keystore) instead of verifier.keystore or the data-dir identity; the password is asked on the terminal')
    .action(async (options: SubmitOptions, command: Command) => {
      const globalOptions = getGlobalOptions(command)
      const config = await loadConfig(globalOptions.config)
      const evidenceDir = config.verifier?.evidenceDir ?? join(globalOptions.dataDir, 'verifier', 'evidence')
      const banksDir = config.verifier?.banksDir ?? join(globalOptions.dataDir, 'verifier', 'banks')
      const manifest = await readVerifierRunManifest(evidenceDir, options.runId)
      const verifierClient = createVerifierClient(config, options.rpcUrl ? { rpcUrl: String(options.rpcUrl) } : {})
      if (options.publishOnly && !options.publishIpfs) throw new Error('--publish-only requires --publish-ipfs')
      if (options.auditor && !options.publishOnly) throw new Error('--auditor is only valid with --publish-only')
      const { wallet, address } = options.auditor
        ? { wallet: null, address: getAddress(options.auditor) }
        : options.publishOnly
          ? { wallet: null, ...await resolveAuditorAddress({ config: config.verifier, dataDir: globalOptions.dataDir }) }
          : await resolveAuditorSigner({
            config: config.verifier, dataDir: globalOptions.dataDir, keystoreFlag: options.keystore,
          })
      const pinataJwt = options.publishIpfs ? process.env['PINATA_JWT']?.trim() : undefined
      if (options.publishIpfs && !pinataJwt) throw new Error('PINATA_JWT is required with --publish-ipfs')

      const [window, network, approved, limits] = await Promise.all([
        verifierClient.currentEpochWindow(),
        verifierClient.provider.getNetwork(),
        verifierClient.approvedAuditor(address),
        verifierClient.creditLimits(),
      ])
      validateRunEpoch(manifest, window)
      if (!options.dryRun && !approved) {
        throw new Error(`auditor wallet ${address} is not approved by the verification contract`)
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

      const { audits: prepared, excluded } = await prepareModelAudits({
        evidenceDir,
        banksDir,
        manifest,
        auditor: address,
        resolveAgentOwner: (agentId) => verifierClient.agentOwner(agentId),
        config: config.verifier,
      })
      const audits = await reuseLedgerEvidence(prepared, ledger)
      const submittedEvidence = await submittedEvidenceHashes(verifierClient, address)
      const credited = await verifierClient.auditCredits(address, window.epoch)
      let auditorCreditsLeft = limits.perAuditor > credited.auditor ? limits.perAuditor - credited.auditor : 0n
      const modelCreditsLeft = new Map<string, bigint>()
      const pending: PendingModelAudit[] = []
      for (const audit of audits) {
        const previous = ledger.models[audit.key] ?? null
        const alreadySubmitted = submittedEvidence.has(normalized(audit.evidenceHash))
        let expectsCredit = false
        if (!alreadySubmitted) {
          if (!modelCreditsLeft.has(audit.modelHash)) {
            const used = await verifierClient.modelCredits(window.epoch, address, audit.modelHash)
            modelCreditsLeft.set(audit.modelHash, limits.perModel > used ? limits.perModel - used : 0n)
          }
          const modelLeft = modelCreditsLeft.get(audit.modelHash)!
          expectsCredit = modelLeft > 0n && auditorCreditsLeft > 0n
          if (expectsCredit) {
            modelCreditsLeft.set(audit.modelHash, modelLeft - 1n)
            auditorCreditsLeft -= 1n
          }
        }
        pending.push({ audit, previous, alreadySubmitted, expectsCredit })
      }

      printPreview(pending)
      const overviewPath = await writeEpochOverview(evidenceDir, manifest.epoch)
      if (overviewPath) console.log(chalk.cyan(`Epoch overview (all runs this epoch): ${overviewPath}`))
      for (const exclusion of excluded) {
        console.warn(chalk.yellow(
          `${exclusion.model} ${exclusion.service} (${exclusion.agentId ?? exclusion.peerId}): excluded: ${exclusion.reason}`,
        ))
      }
      console.log(chalk.dim(
        `Epoch ${window.epoch}: ${credited.auditor} credit(s) earned so far; limits ${limits.perModel} per model, ${limits.perAuditor} per auditor. `
        + 'Credits also require at least one audited seller with staked pool power.',
      ))
      const toSubmit = pending.filter((entry) => !entry.alreadySubmitted)
      if (options.dryRun) {
        console.log(chalk.dim('Dry run complete; nothing was published or sent.'))
        return
      }
      if (toSubmit.length === 0) {
        console.log(chalk.dim('Nothing to submit.'))
        return
      }
      if (options.publishIpfs) {
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

      let submitted = 0
      let recovered = 0
      let failed = 0
      for (const { audit, previous } of toSubmit) {
        let publication = reusablePublication(previous, audit.evidenceHash)
        try {
          await writeModelAuditEvidence(audit)
          if (options.publishIpfs && !publication) publication = await publish(evidenceDir, manifest.runId, audit, pinataJwt!)
          const evidenceUri = publication?.uri ?? previous?.evidenceUri ?? ''
          const entry = ledgerEntry(audit, evidenceUri, publication)
          ledger.models[audit.key] = entry
          await writeModelAuditLedger(ledgerPath, ledger)

          const event = await findSubmission(verifierClient, audit, address)
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
          ledger.models[audit.key] = {
            ...(ledger.models[audit.key] ?? ledgerEntry(audit, publication?.uri ?? '', publication)),
            status: 'failed',
            error: message,
            lastAttemptAt: new Date().toISOString(),
          }
          await writeModelAuditLedger(ledgerPath, ledger)
          failed += 1
          console.warn(chalk.yellow(`${audit.key}: submission failed (continuing): ${message}`))
        }
      }

      const after = await verifierClient.auditCredits(address, window.epoch)
      console.log(chalk.bold('Model audit submission summary'))
      console.log(`  Auditor: ${address}`)
      console.log(`  Epoch: ${window.epoch}`)
      console.log(`  Submitted: ${submitted}; recovered: ${recovered}; already submitted: ${pending.length - toSubmit.length}; failed: ${failed}`)
      console.log(`  Credits this epoch: ${after.auditor} of ${after.total} total`)
      console.log(chalk.dim(`Ledger: ${ledgerPath}`))
      if (failed > 0) process.exitCode = 1
    })
}

/** Evidence hashes this auditor has already submitted on-chain, read from its `ModelAudited` events. */
async function submittedEvidenceHashes(client: VerifierClient, auditor: string): Promise<Set<string>> {
  const events = await client.queryModelAudits({ auditor })
  return new Set(events.map((event) => normalized(event.evidenceHash)))
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

async function findSubmission(client: VerifierClient, audit: PreparedModelAudit, auditor: string) {
  try {
    const events = await client.queryModelAudits({ model: audit.modelHash, auditor })
    return events.find((event) => normalized(event.evidenceHash) === normalized(audit.evidenceHash)) ?? null
  } catch {
    return null
  }
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

function printPreview(pending: readonly PendingModelAudit[]): void {
  if (pending.length === 0) return
  const table = new Table({ head: ['Model', 'Sellers', 'SAME', 'DIFF', 'UNDETERMINED', 'Rechecked', 'Credit', 'Status'] })
  for (const { audit, alreadySubmitted, expectsCredit } of pending) {
    const count = (verdict: string) => audit.evidence.results.filter((result) => result.verdict === verdict).length
    const rechecked = audit.evidence.results.filter((result) => result.confirmation)
    const confirmed = rechecked.filter((result) => result.verdict === 'DIFF').length
    table.push([
      audit.key,
      String(audit.results.length),
      String(count('SAME')),
      String(count('DIFF')),
      String(count('UNDETERMINED')),
      rechecked.length === 0 ? '-' : `${rechecked.length} (${confirmed} DIFF confirmed)`,
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
