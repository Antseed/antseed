import { join } from 'node:path'
import chalk from 'chalk'
import Table from 'cli-table3'
import type { Command } from 'commander'
import { loadConfig } from '../../../config/loader.js'
import { readJsonIfExists } from '../../../verifier/atomic-files.js'
import { readVerifierRunManifest } from '../../../verifier/audit-artifacts.js'
import {
  auditReportPath,
  canonicalEvidenceBytes,
  formatServiceFlags,
  prepareAgentAuditReports,
  signAgentAuditReport,
  writeAgentAuditEvidence,
  writeAuditReportFile,
  type AuditReportFileV1,
  type PreparedAgentAuditReport,
  type ReportPublicationV1,
} from '../../../verifier/audit-report.js'
import {
  prepareReportPublication,
  publishVerificationToPinata,
} from '../../../verifier/ipfs-publication.js'
import { openResponseAuthReader } from '../../../verifier/response-auth-reader.js'
import { normalized } from '../../../verifier/utils.js'
import { createVerifierClient, loadCryptoContext } from '../../payment-utils.js'
import { getGlobalOptions } from '../types.js'

interface ReportOptions {
  runId: string
  rpcUrl?: string
  publishIpfs?: boolean
}

export function registerVerifierReportCommand(verifierCmd: Command): void {
  verifierCmd
    .command('report')
    .description('Sign one audit report per seller agent from a completed verifier run (auditor role)')
    .requiredOption('--run-id <run-id>', 'completed verifier run ID')
    .option('--rpc-url <url>', 'Base JSON-RPC URL override')
    .option('--publish-ipfs', 'publish each report\'s public evidence to Pinata and record its ipfs:// URI')
    .action(async (options: ReportOptions, command: Command) => {
      const globalOptions = getGlobalOptions(command)
      const config = await loadConfig(globalOptions.config)
      const evidenceDir = config.verifier?.evidenceDir ?? join(globalOptions.dataDir, 'verifier', 'evidence')
      const banksDir = config.verifier?.banksDir ?? join(globalOptions.dataDir, 'verifier', 'banks')
      const manifest = await readVerifierRunManifest(evidenceDir, options.runId)
      const verifierClient = createVerifierClient(config, options.rpcUrl ? { rpcUrl: String(options.rpcUrl) } : {})
      const { wallet, address } = await loadCryptoContext(globalOptions.dataDir)
      const domain = await verifierClient.reportDomain()
      const pinataJwt = options.publishIpfs ? process.env['PINATA_JWT']?.trim() : undefined
      if (options.publishIpfs && !pinataJwt) throw new Error('PINATA_JWT is required with --publish-ipfs')

      const requestCosts = await openResponseAuthReader({ dataDir: globalOptions.dataDir })
      let prepared: Awaited<ReturnType<typeof prepareAgentAuditReports>>
      try {
        prepared = await prepareAgentAuditReports({
          evidenceDir,
          banksDir,
          manifest,
          auditor: address,
          requestCostLookup: requestCosts,
          resolveAgentOwner: (agentId) => verifierClient.agentOwner(agentId),
          config: config.verifier,
        })
      } finally {
        requestCosts.close()
      }
      if (options.publishIpfs && prepared.reports.length > 0) {
        console.warn(chalk.yellow('IPFS publication is public: complete audit evidence and signed exchanges will be pinned.'))
      }

      const written: Array<{ prepared: PreparedAgentAuditReport; path: string; file: AuditReportFileV1 }> = []
      for (const report of prepared.reports) {
        await writeAgentAuditEvidence(report)
        const path = auditReportPath(evidenceDir, manifest.runId, report.agentId)
        let publication: ReportPublicationV1 | undefined
        if (options.publishIpfs) {
          publication = reusablePublication(await readJsonIfExists<AuditReportFileV1>(path), report.evidenceHash)
          if (!publication) {
            const packaged = await prepareReportPublication({
              evidenceDir,
              runId: manifest.runId,
              agentId: report.agentId.toString(),
              evidenceHash: report.evidenceHash,
              evidencePath: report.evidencePath,
              evidenceBytes: canonicalEvidenceBytes(report.evidence),
              referencePaths: report.references.map((reference) => reference.path),
              auditEvidencePaths: report.auditEvidencePaths,
            })
            const published = await publishVerificationToPinata(packaged, pinataJwt!)
            publication = {
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
        }
        const file = await signAgentAuditReport({
          prepared: report,
          signer: wallet,
          domain,
          runId: manifest.runId,
          auditedAt: BigInt(Math.floor(Date.now() / 1_000)),
          reportPath: path,
          evidenceUri: publication?.uri,
          publication,
        })
        await writeAuditReportFile(path, file)
        written.push({ prepared: report, path, file })
      }

      const table = new Table({ head: ['Agent', 'Services', 'Flags', 'Verdicts', 'Price', 'IPFS'] })
      for (const { prepared: report, file } of written) {
        const services = report.evidence.services
        table.push([
          report.agentId.toString(),
          services.map((service) => service.service).join('\n'),
          services.map((service) => formatServiceFlags(service.flags)).join('\n'),
          services.map((service) => service.verdict).join('\n'),
          services.map((service) => service.priceCheck.passed ? 'ok' : service.priceCheck.reason ?? 'failed').join('\n'),
          file.evidenceUri || 'off',
        ])
      }
      if (written.length > 0) console.log(table.toString())
      for (const exclusion of prepared.excluded) {
        console.warn(chalk.yellow(
          `${exclusion.model} ${exclusion.service} (${exclusion.agentId ?? exclusion.peerId}): excluded: ${exclusion.reason}`,
        ))
      }
      console.log(chalk.bold('Audit report summary'))
      console.log(`  Auditor: ${address}`)
      console.log(`  Chain: ${String(domain.chainId)}; contract: ${String(domain.verifyingContract)}`)
      console.log(`  Reports signed: ${written.length}; excluded audits: ${prepared.excluded.length}`)
      for (const { path } of written) console.log(chalk.dim(`  ${path}`))
      if (written.length === 0) process.exitCode = 1
    })
}

function reusablePublication(
  existing: AuditReportFileV1 | null,
  evidenceHash: string,
): ReportPublicationV1 | undefined {
  const publication = existing?.publication
  if (!publication || normalized(publication.evidenceHash) !== normalized(evidenceHash)) return undefined
  if (!publication.cid || publication.uri !== `ipfs://${publication.cid}`) return undefined
  return publication
}
