import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ModelAuditSummaryV1, VerifierRunManifestV1 } from './audit-artifacts.js'
import type { ModelVerificationTargetResult } from './model-run.js'
import { verifyProxyAuditEvidenceFile } from './proxy-evidence.js'
import { extensionSets, stageOneVerdict } from './close-call.js'

/** A close call from an earlier run this epoch, waiting for its extra questions. */
export interface PendingExtension {
  model: string
  runId: string
  result: ModelVerificationTargetResult
  /** The reference its first audit was asked, from that audit's evidence. */
  firstReferenceId: string
}

export function pendingExtensionKey(model: string, peerId: string): string {
  return `${model.trim().toLowerCase()}\u0000${peerId.trim().replace(/^0x/i, '').toLowerCase()}`
}

/**
 * Close calls from this epoch's earlier runs whose extra questions could not be asked and that no
 * later run has settled. Runs are replayed oldest first and the latest result per (model, seller)
 * wins. The first check's evidence (and any extra set's) must still verify against its hash.
 */
export async function loadPendingExtensions(
  evidenceDir: string,
  epoch: string,
  models: readonly string[],
): Promise<Map<string, PendingExtension>> {
  const wanted = new Set(models.map((model) => model.toLowerCase()))
  const latest = new Map<string, Omit<PendingExtension, 'firstReferenceId'>>()
  for (const manifest of await epochRunManifests(evidenceDir, epoch)) {
    for (const entry of manifest.models) {
      if (!wanted.has(entry.model.toLowerCase())) continue
      let summary: ModelAuditSummaryV1
      try {
        summary = JSON.parse(await readFile(entry.summaryPath, 'utf8')) as ModelAuditSummaryV1
      } catch {
        continue
      }
      if (summary.runId !== manifest.runId || summary.epoch !== epoch) continue
      for (const result of summary.results ?? []) {
        latest.set(pendingExtensionKey(entry.model, result.peerId), { model: entry.model, runId: manifest.runId, result })
      }
    }
  }
  const pending = new Map<string, PendingExtension>()
  for (const [key, entry] of latest) {
    if (stageOneVerdict(entry.result) !== null || !entry.result.extensionPending) continue
    let firstReferenceId: string
    try {
      firstReferenceId = (await verifyProxyAuditEvidenceFile(entry.result.evidencePath, entry.result.evidenceHash)).reference.referenceId
      for (const set of extensionSets(entry.result)) {
        await verifyProxyAuditEvidenceFile(set.evidencePath, set.evidenceHash)
      }
    } catch {
      continue
    }
    pending.set(key, { ...entry, firstReferenceId })
  }
  return pending
}

async function epochRunManifests(evidenceDir: string, epoch: string): Promise<VerifierRunManifestV1[]> {
  const runsDir = join(evidenceDir, 'runs')
  let names: string[]
  try {
    names = await readdir(runsDir)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  const manifests: VerifierRunManifestV1[] = []
  for (const name of names) {
    if (!name.endsWith('.json') || name.endsWith('.summary.json')) continue
    try {
      const parsed = JSON.parse(await readFile(join(runsDir, name), 'utf8')) as VerifierRunManifestV1
      if (parsed.kind === 'antseed-verifier-run-manifest' && parsed.epoch === epoch) manifests.push(parsed)
    } catch {
      // A manifest being written or a foreign file.
    }
  }
  return manifests.sort((left, right) => left.completedAt.localeCompare(right.completedAt))
}
