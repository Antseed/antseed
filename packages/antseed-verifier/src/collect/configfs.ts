import { mkdirSync, writeFileSync, readFileSync, rmdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

/**
 * Self-hosted TDX collector: it mints a quote locally via the Linux configfs-TSM report
 * interface (kernel >= 6.7). The interface is present inside a real Intel TDX guest (e.g. a
 * GCP confidential VM) and absent elsewhere, so this throws off-TEE. The prover uses that to
 * detect it cannot offer the tee-tdx capability via this source.
 */
const TSM_REPORT_DIR = '/sys/kernel/config/tsm/report'

/**
 * Generate a raw Intel TDX quote bound to `reportData` (64 bytes) via configfs-tsm: mkdir a
 * report entry, write REPORTDATA to `inblob`, read the assembled quote from `outblob`, rmdir.
 */
export function generateTdxQuote(reportData: Uint8Array): Uint8Array {
  if (reportData.length !== 64) {
    throw new Error(`reportData must be 64 bytes, got ${reportData.length}`)
  }
  const entry = join(TSM_REPORT_DIR, `antseed-${randomBytes(8).toString('hex')}`)
  mkdirSync(entry)
  try {
    writeFileSync(join(entry, 'inblob'), Buffer.from(reportData))
    const quote = readFileSync(join(entry, 'outblob'))
    if (quote.length === 0) {
      throw new Error('configfs-tsm outblob was empty (quote generation produced no bytes)')
    }
    return new Uint8Array(quote)
  } finally {
    try {
      rmdirSync(entry)
    } catch {
      // best-effort cleanup; the entry is a one-shot configfs dir
    }
  }
}
