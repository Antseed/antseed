import { join } from 'node:path'
import { readJsonIfExists, writeJsonAtomic } from './atomic-files.js'
import { normalized } from './utils.js'

export type ReportSubmissionStatus = 'pending' | 'submitted' | 'failed'

export interface ReportSubmissionLedgerEntryV1 {
  digest: string
  agentId: string
  auditor: string
  reportPath: string
  evidenceHash: string
  resultsHash: string
  evidenceUri: string
  status: ReportSubmissionStatus
  transactionHash: string | null
  blockNumber: number | null
  error: string | null
  lastAttemptAt: string
}

/** Per chain + contract record of the reports this verifier submitted, keyed by EIP-712 report digest. */
export interface ReportSubmissionLedgerV1 {
  version: 1
  kind: 'antseed-verifier-report-submission-ledger'
  chainId: string
  contractAddress: string
  createdAt: string
  updatedAt: string
  reports: Record<string, ReportSubmissionLedgerEntryV1>
}

export function submissionLedgerPath(
  evidenceDir: string,
  chainId: bigint | string,
  contractAddress: string,
): string {
  return join(evidenceDir, 'submissions', String(chainId), contractAddress.toLowerCase(), 'reports.json')
}

export function newSubmissionLedger(chainId: bigint | string, contractAddress: string): ReportSubmissionLedgerV1 {
  const now = new Date().toISOString()
  return {
    version: 1,
    kind: 'antseed-verifier-report-submission-ledger',
    chainId: String(chainId),
    contractAddress,
    createdAt: now,
    updatedAt: now,
    reports: {},
  }
}

export async function readSubmissionLedger(
  path: string,
  chainId: bigint | string,
  contractAddress: string,
): Promise<ReportSubmissionLedgerV1> {
  const parsed = await readJsonIfExists<ReportSubmissionLedgerV1>(path)
  if (!parsed) return newSubmissionLedger(chainId, contractAddress)
  if (parsed.version !== 1 || parsed.kind !== 'antseed-verifier-report-submission-ledger') {
    throw new Error(`unsupported submission ledger: ${path}`)
  }
  if (parsed.chainId !== String(chainId) || normalized(parsed.contractAddress) !== normalized(contractAddress)) {
    throw new Error(`submission ledger ${path} belongs to another chain or contract`)
  }
  return parsed
}

export async function writeSubmissionLedger(path: string, ledger: ReportSubmissionLedgerV1): Promise<void> {
  ledger.updatedAt = new Date().toISOString()
  await writeJsonAtomic(path, ledger)
}
