import { createInterface } from 'node:readline/promises'
import { join } from 'node:path'
import chalk from 'chalk'
import Table from 'cli-table3'
import type { Command } from 'commander'
import { loadConfig } from '../../../config/loader.js'
import { readVerifierRunManifest } from '../../../verifier/audit-artifacts.js'
import {
  listClaimableReferenceCosts,
  markReferenceCostsClaimed,
  reserveReferenceCosts,
} from '../../../verifier/probe-bank.js'
import { openResponseAuthReader } from '../../../verifier/response-auth-reader.js'
import {
  prepareVerificationPublication,
  publishVerificationToPinata,
  type PreparedVerificationPublication,
} from '../../../verifier/ipfs-publication.js'
import { asError, normalized } from '../../../verifier/utils.js'
import {
  prepareModelVerificationBundle,
  readPreparedModelVerificationBundle,
  writeModelVerificationBundleEvidence,
  type PreparedModelVerificationBundle,
} from '../../../verifier/submission-bundles.js'
import {
  readSubmissionLedger,
  submissionLedgerPath,
  writeSubmissionLedger,
  type ModelSubmissionLedgerEntryV1,
  type ModelSubmissionPublicationV1,
  type ModelSubmissionStatus,
  type SubmissionLedgerV1,
} from '../../../verifier/submission-ledger.js'
import { createVerifierClient, loadCryptoContext } from '../../payment-utils.js'
import { getGlobalOptions } from '../types.js'

interface SubmitOptions {
  runId: string
  dryRun?: boolean
  yes?: boolean
  rpcUrl?: string
  publishIpfs?: boolean
}

interface PreparedSubmission {
  bundle: PreparedModelVerificationBundle
  modelSummaryPath: string
  alreadySubmitted: boolean
  publication: PreparedVerificationPublication | null
}

interface PreparationFailure {
  model: string
  error: Error
}

export interface SubmissionCostSummaryItem {
  totalAuditCostUsdMicros: bigint
  status: ModelSubmissionStatus
}

export interface SubmissionCostSummary {
  totalAuditCostUsdMicros: bigint
  submittedAuditCostUsdMicros: bigint
  failedAuditCostUsdMicros: bigint
}

export function summarizeSubmissionCosts(items: SubmissionCostSummaryItem[]): SubmissionCostSummary {
  return items.reduce<SubmissionCostSummary>((summary, item) => {
    summary.totalAuditCostUsdMicros += item.totalAuditCostUsdMicros
    if (item.status === 'submitted' || item.status === 'skipped') {
      summary.submittedAuditCostUsdMicros += item.totalAuditCostUsdMicros
    } else {
      summary.failedAuditCostUsdMicros += item.totalAuditCostUsdMicros
    }
    return summary
  }, {
    totalAuditCostUsdMicros: 0n,
    submittedAuditCostUsdMicros: 0n,
    failedAuditCostUsdMicros: 0n,
  })
}

export function registerVerifierSubmitCommand(verifierCmd: Command): void {
  verifierCmd
    .command('submit')
    .description('Submit one on-chain verification bundle per audited model')
    .requiredOption('--run-id <run-id>', 'completed verifier run ID')
    .option('--dry-run', 'validate and preview bundles without reserving costs or broadcasting')
    .option('--yes', 'submit without an interactive confirmation prompt')
    .option('--rpc-url <url>', 'Base JSON-RPC URL override')
    .option('--publish-ipfs', 'publish complete public evidence to Pinata before on-chain submission')
    .action(async (options: SubmitOptions, command: Command) => {
      const globalOptions = getGlobalOptions(command)
      const config = await loadConfig(globalOptions.config)
      const evidenceDir = config.verifier?.evidenceDir ?? join(globalOptions.dataDir, 'verifier', 'evidence')
      const banksDir = config.verifier?.banksDir ?? join(globalOptions.dataDir, 'verifier', 'banks')
      const manifest = await readVerifierRunManifest(evidenceDir, options.runId)
      const rpcOverrides = options.rpcUrl ? { rpcUrl: String(options.rpcUrl) } : {}
      const verifierClient = createVerifierClient(config, rpcOverrides)
      const { identity, address } = await loadCryptoContext(globalOptions.dataDir)
      const [network, approved] = await Promise.all([
        verifierClient.provider.getNetwork(),
        verifierClient.approvedVerifier(address),
      ])
      if (!approved) throw new Error(`verifier wallet ${address} is not approved by the verification contract`)

      const ledgerPath = submissionLedgerPath(
        evidenceDir,
        network.chainId,
        verifierClient.contractAddress,
        manifest.runId,
      )
      const ledger = await readSubmissionLedger(ledgerPath) ?? newLedger({
        runId: manifest.runId,
        chainId: network.chainId,
        contractAddress: verifierClient.contractAddress,
        expectedEpoch: manifest.epoch,
      })
      validateLedger(ledger, manifest.runId, network.chainId, verifierClient.contractAddress, manifest.epoch)

      const responseAuthReader = await openResponseAuthReader({ dataDir: globalOptions.dataDir })
      try {
        const prepared: PreparedSubmission[] = []
        const preparationFailures: PreparationFailure[] = []
        for (const model of manifest.modelOrder) {
          const modelManifest = manifest.models.find((entry) => normalized(entry.model) === normalized(model))
          if (!modelManifest) {
            preparationFailures.push({ model, error: new Error('run manifest is missing the model summary') })
            continue
          }
          try {
            const existing = ledger.models[model]
            const bundle = existing
              ? await readPreparedModelVerificationBundle({
                evidencePath: existing.evidencePath,
                evidenceHash: existing.evidenceHash,
              })
              : await prepareModelVerificationBundle({
                evidenceDir,
                manifest,
                model,
                modelSummaryPath: modelManifest.summaryPath,
                verifierAddress: address,
                requestCostLookup: responseAuthReader,
                referenceCosts: await listClaimableReferenceCosts(banksDir, model),
                resolveAgentOwner: (agentId) => verifierClient.agentOwner(agentId),
              })
            if (bundle.results.length === 0) throw new Error('no valid seller results remain after preflight validation')
            const alreadySubmitted = await verifierClient.isVerificationSubmitted(bundle.evidenceHash)
            const publication = options.publishIpfs
              ? await prepareVerificationPublication({
                evidenceDir,
                manifest,
                modelSummaryPath: modelManifest.summaryPath,
                bundle,
              })
              : null
            prepared.push({
              bundle,
              modelSummaryPath: modelManifest.summaryPath,
              alreadySubmitted,
              publication,
            })
          } catch (error) {
            preparationFailures.push({ model, error: asError(error) })
          }
        }

        printPreview(prepared, preparationFailures)
        console.log(chalk.dim('Shadow mode: bundles are registered without verifier reward accounting.'))
        if (options.dryRun) {
          console.log(chalk.dim(
            'Dry run complete; no IPFS uploads, reference-cost reservations, or transactions were performed.',
          ))
          if (preparationFailures.length > 0) process.exitCode = 1
          return
        }
        if (prepared.length === 0) {
          throw new Error('no model bundles are eligible for submission')
        }
        const pinataJwt = options.publishIpfs ? process.env['PINATA_JWT']?.trim() : undefined
        if (options.publishIpfs && !pinataJwt) throw new Error('PINATA_JWT is required with --publish-ipfs')
        if (options.publishIpfs) {
          console.warn(chalk.yellow('IPFS publication is public: complete verifier evidence and signed exchanges will be pinned.'))
        }
        if (!options.yes) await confirmSubmission(prepared.filter((entry) => !entry.alreadySubmitted).length)

        let successfulBundles = 0
        let failedBundles = preparationFailures.length
        let skippedBundles = 0
        let submittedSellerResults = 0
        const publishedUris: Array<{ model: string; uri: string }> = []

        for (const item of prepared) {
          const { bundle } = item
          const now = new Date().toISOString()
          let publication = ledger.models[bundle.model]?.publication
          try {
            if (item.alreadySubmitted) {
              const event = await requireBundleEvent(verifierClient, bundle.evidenceHash)
              if (options.publishIpfs) {
                if (!event.evidenceUri) {
                  throw new Error('bundle was already submitted without an IPFS URI and cannot be retroactively anchored')
                }
                publication = publicationFromEvent(item.publication!, event.evidenceUri, publication)
                publishedUris.push({ model: bundle.model, uri: event.evidenceUri })
              }
              await markReferenceCostsClaimed({
                banksDir,
                model: bundle.model,
                evidenceHash: bundle.evidenceHash,
                transactionHash: event.transactionHash,
              })
              ledger.models[bundle.model] = ledgerEntry(bundle, {
                status: 'skipped',
                transactionHash: event.transactionHash,
                blockNumber: event.blockNumber,
                error: null,
                lastAttemptAt: now,
              }, publication)
              await writeSubmissionLedger(ledgerPath, ledger)
              skippedBundles += 1
              submittedSellerResults += bundle.results.length
              console.log(chalk.dim(`${bundle.model}: bundle already submitted; skipping broadcast`))
              continue
            }

            await writeModelVerificationBundleEvidence(bundle)
            const verifiedBundle = await readPreparedModelVerificationBundle({
              evidencePath: bundle.evidencePath,
              evidenceHash: bundle.evidenceHash,
            })
            let evidenceUri = ''
            if (options.publishIpfs) {
              const preparedPublication = await prepareVerificationPublication({
                evidenceDir,
                manifest,
                modelSummaryPath: item.modelSummaryPath,
                bundle: verifiedBundle,
              })
              if (isReusablePublication(publication, bundle.evidenceHash)) {
                evidenceUri = publication.uri!
              } else {
                try {
                  const published = await publishVerificationToPinata(preparedPublication, pinataJwt!)
                  publication = {
                    provider: 'pinata',
                    status: 'published',
                    evidenceHash: published.evidenceHash,
                    cid: published.cid,
                    uri: published.uri,
                    pinSize: published.pinSize,
                    totalBytes: preparedPublication.totalBytes,
                    fileCount: published.fileCount,
                    publishedAt: published.publishedAt,
                    lastAttemptAt: new Date().toISOString(),
                    error: null,
                  }
                  evidenceUri = published.uri
                } catch (error) {
                  publication = failedPublication(preparedPublication, asError(error))
                  throw error
                }
              }
              publishedUris.push({ model: bundle.model, uri: evidenceUri })
            }
            ledger.models[bundle.model] = ledgerEntry(bundle, {
              status: 'pending',
              transactionHash: null,
              blockNumber: null,
              error: null,
              lastAttemptAt: now,
            }, publication)
            await writeSubmissionLedger(ledgerPath, ledger)
            await reserveReferenceCosts({
              banksDir,
              model: bundle.model,
              evidenceHash: bundle.evidenceHash,
              costIds: bundle.referenceCostIds,
            })

            const transactionHash = await verifierClient.submitVerificationBundle(identity.wallet, {
              evidenceHash: bundle.evidenceHash,
              evidenceUri,
              results: bundle.results,
            })
            const event = await requireBundleEvent(verifierClient, bundle.evidenceHash)
            if (event.evidenceUri !== evidenceUri) {
              throw new Error(`submitted bundle event URI mismatch: expected ${evidenceUri || '(empty)'}`)
            }
            await markReferenceCostsClaimed({
              banksDir,
              model: bundle.model,
              evidenceHash: bundle.evidenceHash,
              transactionHash,
            })
            ledger.models[bundle.model] = ledgerEntry(bundle, {
              status: 'submitted',
              transactionHash,
              blockNumber: event.blockNumber,
              error: null,
              lastAttemptAt: new Date().toISOString(),
            }, publication)
            await writeSubmissionLedger(ledgerPath, ledger)
            successfulBundles += 1
            submittedSellerResults += bundle.results.length
            console.log(chalk.green(
              `${bundle.model}: registered ${bundle.results.length} seller result(s) (${transactionHash})`,
            ))
          } catch (error) {
            const failure = asError(error)
            ledger.models[bundle.model] = ledgerEntry(bundle, {
              status: 'failed',
              transactionHash: ledger.models[bundle.model]?.transactionHash ?? null,
              blockNumber: null,
              error: failure.message,
              lastAttemptAt: new Date().toISOString(),
            }, publication)
            await writeSubmissionLedger(ledgerPath, ledger)
            failedBundles += 1
            console.warn(chalk.yellow(`${bundle.model}: submission failed (continuing): ${failure.message}`))
          }
        }

        for (const failure of preparationFailures) {
          console.warn(chalk.yellow(`${failure.model}: preflight failed: ${failure.error.message}`))
        }
        const costSummary = summarizeSubmissionCosts(prepared.map((item) => {
          const entry = ledger.models[item.bundle.model]
          return {
            totalAuditCostUsdMicros: item.bundle.totalAuditCostUsdMicros,
            status: entry?.status ?? 'failed',
          }
        }))
        console.log(chalk.bold('Verification bundle submission summary'))
        console.log(`  Model bundles: ${prepared.length + preparationFailures.length}`)
        console.log(`  Submitted: ${successfulBundles}; skipped: ${skippedBundles}; failed: ${failedBundles}`)
        console.log(`  Seller results submitted: ${submittedSellerResults}`)
        console.log(`  Total audit cost recorded: ${formatUsdMicros(costSummary.totalAuditCostUsdMicros)}`)
        console.log(`  Submitted audit cost: ${formatUsdMicros(costSummary.submittedAuditCostUsdMicros)}`)
        console.log(`  Failed bundle audit cost: ${formatUsdMicros(costSummary.failedAuditCostUsdMicros)}`)
        for (const publication of publishedUris) console.log(`  IPFS (${publication.model}): ${publication.uri}`)
        console.log(chalk.dim(`Submission ledger: ${ledgerPath}`))
        if (failedBundles > 0) process.exitCode = 1
      } finally {
        responseAuthReader.close()
      }
    })
}

function printPreview(prepared: PreparedSubmission[], failures: PreparationFailure[]): void {
  const table = new Table({
    head: ['Model', 'Results', 'SAME', 'DIFF', 'UNDET', 'Inference', 'Reference', 'Audit Cost', 'IPFS', 'Status'],
  })
  for (const item of prepared) {
    const verdictCounts = item.bundle.evidence.results.reduce((counts, result) => {
      counts[result.verdict] += 1
      return counts
    }, { SAME: 0, DIFF: 0, UNDETERMINED: 0 })
    table.push([
      item.bundle.model,
      item.bundle.results.length,
      verdictCounts.SAME,
      verdictCounts.DIFF,
      verdictCounts.UNDETERMINED,
      formatUsdMicros(BigInt(item.bundle.evidence.inferenceCostUsdMicros)),
      formatUsdMicros(BigInt(item.bundle.evidence.referenceCostUsdMicros)),
      formatUsdMicros(item.bundle.totalAuditCostUsdMicros),
      item.publication ? `${item.publication.fileCount} files / ${formatBytes(item.publication.totalBytes)}` : 'off',
      item.alreadySubmitted ? 'already submitted' : 'ready',
    ])
  }
  for (const failure of failures) {
    table.push([failure.model, 'BLOCKED', '—', '—', '—', '—', '—', '—', '—', failure.error.message])
  }
  console.log(table.toString())
}

async function confirmSubmission(bundleCount: number): Promise<void> {
  if (bundleCount === 0) return
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('refusing non-interactive on-chain submission without --yes')
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await prompt.question(`Submit ${bundleCount} model bundle transaction(s)? [y/N] `)
    if (!['y', 'yes'].includes(answer.trim().toLowerCase())) throw new Error('submission cancelled')
  } finally {
    prompt.close()
  }
}

async function requireBundleEvent(
  verifierClient: ReturnType<typeof createVerifierClient>,
  evidenceHash: string,
) {
  const events = await verifierClient.queryBundles(evidenceHash)
  const event = events.at(-1)
  if (!event) throw new Error(`submitted bundle event not found for ${evidenceHash}`)
  return event
}

function ledgerEntry(
  bundle: PreparedModelVerificationBundle,
  state: Pick<ModelSubmissionLedgerEntryV1,
    'status' | 'transactionHash' | 'blockNumber' | 'error' | 'lastAttemptAt'>,
  publication?: ModelSubmissionPublicationV1,
): ModelSubmissionLedgerEntryV1 {
  return {
    model: bundle.model,
    serviceHashes: bundle.results.map((result) => result.serviceHash),
    evidenceHash: bundle.evidenceHash,
    evidencePath: bundle.evidencePath,
    resultCount: bundle.results.length,
    inferenceCostUsdMicros: bundle.evidence.inferenceCostUsdMicros,
    referenceCostUsdMicros: bundle.evidence.referenceCostUsdMicros,
    totalAuditCostUsdMicros: bundle.totalAuditCostUsdMicros.toString(),
    referenceCostIds: bundle.referenceCostIds,
    ...(publication ? { publication } : {}),
    ...state,
  }
}

function isReusablePublication(
  publication: ModelSubmissionPublicationV1 | undefined,
  evidenceHash: string,
): publication is ModelSubmissionPublicationV1 & { cid: string; uri: string } {
  return publication?.status === 'published'
    && normalized(publication.evidenceHash) === normalized(evidenceHash)
    && typeof publication.cid === 'string'
    && publication.cid.length > 0
    && publication.uri === `ipfs://${publication.cid}`
}

function failedPublication(
  prepared: PreparedVerificationPublication,
  error: Error,
): ModelSubmissionPublicationV1 {
  return {
    provider: 'pinata',
    status: 'failed',
    evidenceHash: prepared.evidenceHash,
    cid: null,
    uri: null,
    pinSize: null,
    totalBytes: prepared.totalBytes,
    fileCount: prepared.fileCount,
    publishedAt: null,
    lastAttemptAt: new Date().toISOString(),
    error: error.message,
  }
}

function publicationFromEvent(
  prepared: PreparedVerificationPublication,
  evidenceUri: string,
  existing?: ModelSubmissionPublicationV1,
): ModelSubmissionPublicationV1 {
  if (!evidenceUri.startsWith('ipfs://') || evidenceUri.length <= 'ipfs://'.length) {
    throw new Error(`submitted bundle has an invalid IPFS URI: ${evidenceUri}`)
  }
  if (isReusablePublication(existing, prepared.evidenceHash) && existing.uri !== evidenceUri) {
    throw new Error(`local publication URI ${existing.uri} does not match on-chain URI ${evidenceUri}`)
  }
  return {
    provider: 'pinata',
    status: 'published',
    evidenceHash: prepared.evidenceHash,
    cid: evidenceUri.slice('ipfs://'.length),
    uri: evidenceUri,
    pinSize: existing?.pinSize ?? prepared.totalBytes,
    totalBytes: existing?.totalBytes ?? prepared.totalBytes,
    fileCount: existing?.fileCount ?? prepared.fileCount,
    publishedAt: existing?.publishedAt ?? new Date().toISOString(),
    lastAttemptAt: new Date().toISOString(),
    error: null,
  }
}

function newLedger(input: {
  runId: string
  chainId: bigint
  contractAddress: string
  expectedEpoch: string
}): SubmissionLedgerV1 {
  const now = new Date().toISOString()
  return {
    version: 1,
    kind: 'antseed-verifier-submission-ledger',
    runId: input.runId,
    chainId: input.chainId.toString(),
    contractAddress: input.contractAddress,
    expectedEpoch: input.expectedEpoch,
    createdAt: now,
    updatedAt: now,
    models: {},
  }
}

function validateLedger(
  ledger: SubmissionLedgerV1,
  runId: string,
  chainId: bigint,
  contractAddress: string,
  expectedEpoch: string,
): void {
  if (ledger.runId !== runId
    || ledger.chainId !== chainId.toString()
    || normalized(ledger.contractAddress) !== normalized(contractAddress)
    || ledger.expectedEpoch !== expectedEpoch) {
    throw new Error('submission ledger does not match the selected run, chain, contract, and epoch')
  }
}

function formatUsdMicros(value: bigint): string {
  const whole = value / 1_000_000n
  const fraction = (value % 1_000_000n).toString().padStart(6, '0')
  return `$${whole}.${fraction}`
}

function formatBytes(value: number): string {
  if (value < 1_024) return `${value} B`
  if (value < 1_048_576) return `${(value / 1_024).toFixed(1)} KiB`
  return `${(value / 1_048_576).toFixed(1)} MiB`
}
