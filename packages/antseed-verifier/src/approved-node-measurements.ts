import { readFileSync } from 'node:fs'

/**
 * Seller node builds approved for the seller-node-tee-genuine claim. A node quote passes only
 * when its TD measurement matches one entry, so the buyer knows which reviewed software handles
 * its prompts, not just that the hardware is genuine:
 *   - MRTD and RTMR0-2 (firmware, VM shape, kernel, boot config and root filesystem) always;
 *   - the workload as either RTMR3 itself, or, on dstack (Phala) CVMs where RTMR3 differs per
 *     instance, the app compose hash replayed from the event log.
 *
 * An entry is added for a reproducible seller build that, once reviewed, gives its operator no
 * way to read prompts: no shell, SSH, exec or debug access, no prompt logging, and upstream
 * URLs, proxy settings and CA roots fixed in the measured image.
 */
export interface ApprovedNodeMeasurement {
  /** Who runs the build and which version; shown in claim details. */
  name: string
  mrtd: string
  rtmr0: string
  rtmr1: string
  rtmr2: string
  /** Exactly one of rtmr3 and composeHash. */
  rtmr3?: string
  /** dstack: SHA-256 of app-compose.json (64 hex). */
  composeHash?: string
}

export const APPROVED_NODE_MEASUREMENTS: readonly ApprovedNodeMeasurement[] = []

const MEASUREMENT_FIELDS = ['mrtd', 'rtmr0', 'rtmr1', 'rtmr2'] as const
const isMeasurement = (v: unknown): boolean => typeof v === 'string' && /^[0-9a-fA-F]{96}$/.test(v)

function isApprovedNodeMeasurement(m: unknown): m is ApprovedNodeMeasurement {
  if (!m || typeof m !== 'object') return false
  const e = m as Record<string, unknown>
  const workload = e['rtmr3'] !== undefined
    ? isMeasurement(e['rtmr3']) && e['composeHash'] === undefined
    : typeof e['composeHash'] === 'string' && /^[0-9a-fA-F]{64}$/.test(e['composeHash'])
  return typeof e['name'] === 'string' && MEASUREMENT_FIELDS.every((f) => isMeasurement(e[f])) && workload
}

/**
 * The approved list plus a buyer's own additions from ANTSEED_VERIFIER_NODE_MEASUREMENTS (a JSON
 * array of entries, inline or "@/path/to/file.json"). Additions only widen what this buyer
 * accepts; malformed entries are ignored.
 */
export function readApprovedNodeMeasurements(): ApprovedNodeMeasurement[] {
  const raw = process.env['ANTSEED_VERIFIER_NODE_MEASUREMENTS']?.trim()
  if (!raw) return [...APPROVED_NODE_MEASUREMENTS]
  try {
    const parsed: unknown = JSON.parse(raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw)
    const extra = Array.isArray(parsed) ? parsed.filter(isApprovedNodeMeasurement) : []
    return [...APPROVED_NODE_MEASUREMENTS, ...extra]
  } catch (err) {
    process.stderr.write(`[verifier] ignoring ANTSEED_VERIFIER_NODE_MEASUREMENTS: ${err instanceof Error ? err.message : String(err)}\n`)
    return [...APPROVED_NODE_MEASUREMENTS]
  }
}
