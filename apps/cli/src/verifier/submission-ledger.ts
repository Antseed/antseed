import { join } from 'node:path'
import { readJsonIfExists, writeJsonAtomic } from './atomic-files.js'

export type ModelSubmissionStatus = 'pending' | 'submitted' | 'failed' | 'skipped'

export interface ModelSubmissionPublicationV1 {
  provider: 'pinata'
  status: 'published' | 'failed'
  evidenceHash: string
  cid: string | null
  uri: string | null
  pinSize: number | null
  totalBytes?: number
  fileCount: number
  publishedAt: string | null
  lastAttemptAt: string
  error: string | null
}

export interface ModelSubmissionLedgerEntryV1 {
  model: string
  evidenceHash: string
  serviceHashes: string[]
  evidencePath: string
  resultCount: number
  inferenceCostUsdMicros: string
  referenceCostUsdMicros: string
  totalAuditCostUsdMicros: string
  status: ModelSubmissionStatus
  transactionHash: string | null
  blockNumber: number | null
  error: string | null
  lastAttemptAt: string
  referenceCostIds: string[]
  publication?: ModelSubmissionPublicationV1
}

export interface SubmissionLedgerV1 {
  version: 1
  kind: 'antseed-verifier-submission-ledger'
  runId: string
  chainId: string
  contractAddress: string
  expectedEpoch: string
  createdAt: string
  updatedAt: string
  models: Record<string, ModelSubmissionLedgerEntryV1>
}

export function submissionLedgerPath(
  evidenceDir: string,
  chainId: bigint | string,
  contractAddress: string,
  runId: string,
): string {
  return join(
    evidenceDir,
    'submissions',
    String(chainId),
    contractAddress.toLowerCase(),
    `${runId}.json`,
  )
}

export async function readSubmissionLedger(path: string): Promise<SubmissionLedgerV1 | null> {
  const parsed = await readJsonIfExists<SubmissionLedgerV1>(path)
  if (parsed && (parsed.version !== 1 || parsed.kind !== 'antseed-verifier-submission-ledger')) {
    throw new Error(`unsupported submission ledger: ${path}`)
  }
  return parsed
}

export async function writeSubmissionLedger(path: string, ledger: SubmissionLedgerV1): Promise<void> {
  ledger.updatedAt = new Date().toISOString()
  await writeJsonAtomic(path, ledger)
}
