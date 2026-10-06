import { readdir, stat } from 'node:fs/promises'
import { createInterface } from 'node:readline/promises'
import { join, resolve } from 'node:path'
import chalk from 'chalk'
import Table from 'cli-table3'
import type { Command } from 'commander'
import { loadConfig } from '../../../config/loader.js'
import { auditReportInput, formatServiceFlags } from '../../../verifier/audit-report.js'
import {
  REPORT_CHECK_ORDER,
  finalizeVerifiedReport,
  verifyAuditReportFile,
  type VerifiedAuditReport,
} from '../../../verifier/report-verification.js'
import {
  readSubmissionLedger,
  submissionLedgerPath,
  writeSubmissionLedger,
  type ReportSubmissionLedgerEntryV1,
} from '../../../verifier/submission-ledger.js'
import { asError, normalized } from '../../../verifier/utils.js'
import { createVerifierClient, loadCryptoContext } from '../../payment-utils.js'
import { getGlobalOptions } from '../types.js'

interface SubmitOptions {
  report: string
  dryRun?: boolean
  yes?: boolean
  rpcUrl?: string
}

interface CheckedReport {
  verified: VerifiedAuditReport
  alreadySubmitted: boolean
}

export function registerVerifierSubmitCommand(verifierCmd: Command): void {
  verifierCmd
    .command('submit')
    .description('Independently verify auditor-signed reports and submit the valid ones on-chain (verifier role)')
    .requiredOption('--report <path>', 'audit report file, or a directory of *.report.json files')
    .option('--dry-run', 'verify and preview reports without broadcasting')
    .option('--yes', 'submit without an interactive confirmation prompt')
    .option('--rpc-url <url>', 'Base JSON-RPC URL override')
    .action(async (options: SubmitOptions, command: Command) => {
      const globalOptions = getGlobalOptions(command)
      const config = await loadConfig(globalOptions.config)
      const evidenceDir = config.verifier?.evidenceDir ?? join(globalOptions.dataDir, 'verifier', 'evidence')
      const banksDir = config.verifier?.banksDir ?? join(globalOptions.dataDir, 'verifier', 'banks')
      const verifierClient = createVerifierClient(config, options.rpcUrl ? { rpcUrl: String(options.rpcUrl) } : {})
      const { wallet, address } = await loadCryptoContext(globalOptions.dataDir)
      const [domain, approved] = await Promise.all([
        verifierClient.reportDomain(),
        verifierClient.approvedVerifier(address),
      ])
      if (!approved) throw new Error(`verifier wallet ${address} is not approved by the verification contract`)
      const chainId = BigInt(domain.chainId!)
      const ledgerPath = submissionLedgerPath(evidenceDir, chainId, verifierClient.contractAddress)
      const ledger = await readSubmissionLedger(ledgerPath, chainId, verifierClient.contractAddress)

      const reportPaths = await collectReportPaths(options.report)
      if (reportPaths.length === 0) throw new Error(`no *.report.json files found at ${options.report}`)
      const latestBlock = await verifierClient.provider.getBlock('latest')
      const nowSeconds = Math.max(Math.floor(Date.now() / 1_000), Number(latestBlock?.timestamp ?? 0))

      const checked: CheckedReport[] = []
      for (const path of reportPaths) {
        const verified = await verifyAuditReportFile({
          path,
          domain,
          nowSeconds,
          banksDir,
          config: config.verifier,
        })
        let alreadySubmitted = false
        if (verified.file && verified.digest) {
          try {
            const file = verified.file
            const digest = verified.digest
            const owner = await verifierClient.agentOwner(BigInt(file.report.agentId))
            if (normalized(owner) === normalized(file.auditor)) {
              throw new Error(`auditor ${file.auditor} owns agent ${file.report.agentId}`)
            }
            if (normalized(owner) === normalized(address)) {
              throw new Error(`this verifier ${address} owns agent ${file.report.agentId}`)
            }
            if (await verifierClient.reportUsed(digest)) {
              if (ledger.reports[digest]?.status !== 'submitted') throw new Error('report digest is already used on-chain')
              alreadySubmitted = true
            }
            verified.checks.ownership = {
              ok: true,
              detail: alreadySubmitted ? 'already submitted by this verifier' : `agent owner ${owner}`,
            }
          } catch (error) {
            verified.checks.ownership = { ok: false, detail: asError(error).message }
          }
        } else {
          verified.checks.ownership = { ok: false, detail: 'not evaluated: report signature is invalid' }
        }
        finalizeVerifiedReport(verified)
        checked.push({ verified, alreadySubmitted })
      }

      printPreview(checked)
      const refused = checked.filter((item) => !item.verified.ok)
      for (const item of refused) {
        const failed = REPORT_CHECK_ORDER
          .filter((name) => item.verified.checks[name]?.ok === false)
          .map((name) => `${name}: ${item.verified.checks[name]!.detail}`)
        console.warn(chalk.yellow(`Refusing ${item.verified.path}:\n  ${failed.join('\n  ')}`))
      }
      const eligible = checked.filter((item) => item.verified.ok && !item.alreadySubmitted)
      if (options.dryRun) {
        console.log(chalk.dim('Dry run complete; no transactions were sent.'))
        if (refused.length > 0) process.exitCode = 1
        return
      }
      if (!options.yes) await confirmSubmission(eligible.length)

      let submitted = 0
      let failed = 0
      for (const { verified } of eligible) {
        const file = verified.file!
        const digest = verified.digest!
        const entry: ReportSubmissionLedgerEntryV1 = {
          digest,
          agentId: file.report.agentId,
          auditor: file.auditor,
          reportPath: resolve(verified.path),
          evidenceHash: file.report.evidenceHash,
          resultsHash: file.report.resultsHash,
          evidenceUri: file.evidenceUri,
          status: 'pending',
          transactionHash: null,
          blockNumber: null,
          error: null,
          lastAttemptAt: new Date().toISOString(),
        }
        ledger.reports[digest] = entry
        await writeSubmissionLedger(ledgerPath, ledger)
        try {
          const transactionHash = await verifierClient.submitReport(wallet, {
            report: auditReportInput(file),
            results: file.results,
            evidenceUri: file.evidenceUri,
            auditorSignature: file.signature,
          })
          const receipt = await verifierClient.provider.getTransactionReceipt(transactionHash)
          ledger.reports[digest] = {
            ...entry,
            status: 'submitted',
            transactionHash,
            blockNumber: receipt?.blockNumber ?? null,
            lastAttemptAt: new Date().toISOString(),
          }
          submitted += 1
          console.log(chalk.green(
            `agent ${file.report.agentId}: submitted ${file.results.length} service result(s) from ${file.auditor} (${transactionHash})`,
          ))
        } catch (error) {
          ledger.reports[digest] = {
            ...entry,
            status: 'failed',
            error: asError(error).message,
            lastAttemptAt: new Date().toISOString(),
          }
          failed += 1
          console.warn(chalk.yellow(`agent ${file.report.agentId}: submission failed (continuing): ${asError(error).message}`))
        }
        await writeSubmissionLedger(ledgerPath, ledger)
      }

      const skipped = checked.filter((item) => item.verified.ok && item.alreadySubmitted).length
      console.log(chalk.bold('Audit report submission summary'))
      console.log(`  Reports: ${checked.length}`)
      console.log(`  Submitted: ${submitted}; skipped: ${skipped}; refused: ${refused.length}; failed: ${failed}`)
      console.log(chalk.dim(`Submission ledger: ${ledgerPath}`))
      if (refused.length > 0 || failed > 0) process.exitCode = 1
    })
}

async function collectReportPaths(target: string): Promise<string[]> {
  const path = resolve(target)
  if (!(await stat(path)).isDirectory()) return [path]
  const names = await readdir(path)
  return names.filter((name) => name.endsWith('.report.json')).sort().map((name) => join(path, name))
}

function printPreview(checked: CheckedReport[]): void {
  const table = new Table({
    head: ['Agent', 'Services', 'Flags', 'Auditor', ...REPORT_CHECK_ORDER.map(checkLabel), 'Status'],
  })
  for (const { verified, alreadySubmitted } of checked) {
    const file = verified.file
    const services = verified.evidence?.services
    table.push([
      file?.report.agentId ?? '—',
      services ? services.map((service) => service.service).join('\n') : String(file?.results.length ?? '—'),
      file ? file.results.map((result) => formatServiceFlags(result.flags)).join('\n') : '—',
      file?.auditor ?? '—',
      ...REPORT_CHECK_ORDER.map((name) => {
        const check = verified.checks[name]
        return check ? (check.ok ? 'ok' : 'FAIL') : '—'
      }),
      !verified.ok ? 'refused' : alreadySubmitted ? 'already submitted' : 'ready',
    ])
  }
  console.log(table.toString())
}

function checkLabel(name: string): string {
  return name === 'responseAuth' ? 'ResponseAuth' : name[0]!.toUpperCase() + name.slice(1)
}

async function confirmSubmission(reportCount: number): Promise<void> {
  if (reportCount === 0) return
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('refusing non-interactive on-chain submission without --yes')
  }
  const prompt = createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await prompt.question(`Submit ${reportCount} audit report transaction(s)? [y/N] `)
    if (!['y', 'yes'].includes(answer.trim().toLowerCase())) throw new Error('submission cancelled')
  } finally {
    prompt.close()
  }
}
