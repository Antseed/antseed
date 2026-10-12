import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import chalk from 'chalk'
import Table from 'cli-table3'
import type { Command } from 'commander'
import { getAddress } from 'ethers'
import { loadConfig } from '../../../config/loader.js'
import {
  agentSubmissionPath,
  canonicalEvidenceBytes,
  prepareAgentAudits,
  readAgentAuditSubmission,
  writeAgentAuditEvidence,
  writeAgentAuditSubmission,
  type AgentAuditSubmissionV1,
  type AuditPublicationV1,
  type PreparedAgentAudit,
} from '../../../verifier/agent-audit.js'
import { readVerifierRunManifest } from '../../../verifier/audit-artifacts.js'
import { prepareAuditPublication, publishVerificationToPinata } from '../../../verifier/ipfs-publication.js'
import { asError, normalized } from '../../../verifier/utils.js'
import { createVerifierClient, loadCryptoContext } from '../../payment-utils.js'
import { getGlobalOptions } from '../types.js'

interface SubmitOptions {
  runId: string
  publishIpfs?: boolean
  dryRun?: boolean
  yes?: boolean
  rpcUrl?: string
}

export function registerVerifierSubmitCommand(verifierCmd: Command): void {
  verifierCmd
    .command('submit')
    .description('Submit one audit per seller agent from a completed verifier run (approved auditors only)')
    .requiredOption('--run-id <run-id>', 'completed verifier run ID')
    .option('--publish-ipfs', 'publish each agent\'s public evidence to Pinata and record its ipfs:// URI')
    .option('--dry-run', 'preview the audits without publishing or broadcasting')
    .option('--yes', 'submit without an interactive confirmation prompt')
    .option('--rpc-url <url>', 'Base JSON-RPC URL override')
    .action(async (options: SubmitOptions, command: Command) => {
      const globalOptions = getGlobalOptions(command)
      const config = await loadConfig(globalOptions.config)
      const evidenceDir = config.verifier?.evidenceDir ?? join(globalOptions.dataDir, 'verifier', 'evidence')
      const banksDir = config.verifier?.banksDir ?? join(globalOptions.dataDir, 'verifier', 'banks')
      const manifest = await readVerifierRunManifest(evidenceDir, options.runId)
      const verifierClient = createVerifierClient(config, options.rpcUrl ? { rpcUrl: String(options.rpcUrl) } : {})
      const { wallet, address } = await loadCryptoContext(globalOptions.dataDir)
      const pinataJwt = options.publishIpfs ? process.env['PINATA_JWT']?.trim() : undefined
      if (options.publishIpfs && !pinataJwt) throw new Error('PINATA_JWT is required with --publish-ipfs')
      if (!options.dryRun && !(await verifierClient.approvedAuditor(address))) {
        throw new Error(`auditor wallet ${address} is not approved by the verification contract`)
      }

      const { audits, excluded } = await prepareAgentAudits({
        evidenceDir,
        banksDir,
        manifest,
        auditor: address,
        resolveAgentOwner: (agentId) => verifierClient.agentOwner(agentId),
        config: config.verifier,
      })
      const pending: Array<{ audit: PreparedAgentAudit; path: string; previous: AgentAuditSubmissionV1 | null }> = []
      for (const audit of audits) {
        const path = agentSubmissionPath(evidenceDir, manifest.runId, audit.agentId)
        const previous = await readAgentAuditSubmission(path)
        const alreadySubmitted = Boolean(previous?.transactionHash)
          && normalized(previous!.evidenceHash) === normalized(audit.evidenceHash)
        if (!alreadySubmitted) pending.push({ audit, path, previous })
      }

      printPreview(audits, pending.map(({ audit }) => audit))
      for (const exclusion of excluded) {
        console.warn(chalk.yellow(
          `${exclusion.model} ${exclusion.service} (${exclusion.agentId ?? exclusion.peerId}): excluded: ${exclusion.reason}`,
        ))
      }
      if (options.dryRun) {
        console.log(chalk.dim('Dry run complete; nothing was published or sent.'))
        return
      }
      if (pending.length === 0) {
        console.log(chalk.dim('Nothing to submit.'))
        return
      }
      if (options.publishIpfs) {
        console.warn(chalk.yellow('IPFS publication is public: complete audit evidence and signed exchanges will be pinned.'))
      }
      if (!options.yes) await confirmSubmission(pending.length)

      const network = await verifierClient.provider.getNetwork()
      let submitted = 0
      let failed = 0
      for (const { audit, path, previous } of pending) {
        try {
          await writeAgentAuditEvidence(audit)
          let publication = reusablePublication(previous, audit.evidenceHash)
          if (options.publishIpfs && !publication) publication = await publish(evidenceDir, manifest.runId, audit, pinataJwt!)
          const record: AgentAuditSubmissionV1 = {
            version: 1,
            kind: 'antseed-verifier-agent-audit-submission',
            runId: manifest.runId,
            agentId: audit.agentId.toString(),
            auditor: address,
            chainId: network.chainId.toString(),
            contract: getAddress(verifierClient.contractAddress),
            evidenceHash: audit.evidenceHash,
            evidenceUri: publication?.uri ?? '',
            ...(publication ? { publication } : {}),
            transactionHash: null,
            submittedAt: null,
          }
          await writeAgentAuditSubmission(path, record)
          const transactionHash = await verifierClient.submitAudit(wallet, {
            agentId: audit.agentId,
            results: audit.results,
            evidenceHash: audit.evidenceHash,
            evidenceUri: record.evidenceUri,
          })
          await writeAgentAuditSubmission(path, { ...record, transactionHash, submittedAt: new Date().toISOString() })
          submitted += 1
          console.log(chalk.green(`agent ${audit.agentId}: submitted ${audit.results.length} service result(s) (${transactionHash})`))
        } catch (error) {
          failed += 1
          console.warn(chalk.yellow(`agent ${audit.agentId}: submission failed (continuing): ${asError(error).message}`))
        }
      }

      console.log(chalk.bold('Audit submission summary'))
      console.log(`  Auditor: ${address}`)
      console.log(`  Submitted: ${submitted}; already submitted: ${audits.length - pending.length}; failed: ${failed}`)
      if (failed > 0) process.exitCode = 1
    })
}

async function publish(
  evidenceDir: string,
  runId: string,
  audit: PreparedAgentAudit,
  pinataJwt: string,
): Promise<AuditPublicationV1> {
  const packaged = await prepareAuditPublication({
    evidenceDir,
    runId,
    agentId: audit.agentId.toString(),
    evidenceHash: audit.evidenceHash,
    evidencePath: audit.evidencePath,
    evidenceBytes: canonicalEvidenceBytes(audit.evidence),
    referencePaths: audit.references.map((reference) => reference.path),
    auditEvidencePaths: audit.auditEvidencePaths,
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

function reusablePublication(previous: AgentAuditSubmissionV1 | null, evidenceHash: string): AuditPublicationV1 | undefined {
  const publication = previous?.publication
  if (!publication || normalized(publication.evidenceHash) !== normalized(evidenceHash)) return undefined
  if (!publication.cid || publication.uri !== `ipfs://${publication.cid}`) return undefined
  return publication
}

function printPreview(audits: readonly PreparedAgentAudit[], pending: readonly PreparedAgentAudit[]): void {
  if (audits.length === 0) return
  const table = new Table({ head: ['Agent', 'Services', 'Verdicts', 'Result', 'Status'] })
  for (const audit of audits) {
    const services = audit.evidence.services
    table.push([
      audit.agentId.toString(),
      services.map((service) => service.service).join('\n'),
      services.map((service) => service.verdict).join('\n'),
      services.every((service) => service.passed) ? 'verified' : 'failed',
      pending.includes(audit) ? 'ready' : 'already submitted',
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
    const answer = await prompt.question(`Submit ${count} audit transaction(s)? [y/N] `)
    if (!['y', 'yes'].includes(answer.trim().toLowerCase())) throw new Error('submission cancelled')
  } finally {
    prompt.close()
  }
}
