import { readFileSync } from 'node:fs'
import { APPROVED_SELLER_IMAGES, type ApprovedSellerImage } from './approved-seller-images.js'

export type { ApprovedSellerImage } from './approved-seller-images.js'

/**
 * What a seller node quote must match for the seller-node-tee-genuine claim, so the buyer knows
 * which reviewed software handles its prompts, not just that the hardware is genuine. A seller
 * node runs Antseed's TEE seller image (deploy/tee-seller) as a dstack (Phala) app:
 *   - the CVM's OS (MRTD and RTMR0-2: firmware, VM shape, kernel, boot config, root filesystem)
 *     is a released dstack production image listed in `os`;
 *   - the app compose (measured into RTMR3 as its hash) runs one of the `images` and passes the
 *     compose rules in dstack-app-compose.ts, which keep every setting that decides where
 *     prompts go readable by the buyer.
 */
export interface ApprovedDstackOs {
  /** dstack release and VM shape (RTMR0 depends on the vCPU and memory size); shown in claim details. */
  name: string
  mrtd: string
  rtmr0: string
  rtmr1: string
  rtmr2: string
}

export interface ApprovedNodeBuilds {
  os: readonly ApprovedDstackOs[]
  images: readonly ApprovedSellerImage[]
}

/** dstack production OS images, one entry per release and VM shape. */
export const APPROVED_DSTACK_OS: readonly ApprovedDstackOs[] = []

const MEASUREMENT_FIELDS = ['mrtd', 'rtmr0', 'rtmr1', 'rtmr2'] as const
const isMeasurement = (v: unknown): boolean => typeof v === 'string' && /^[0-9a-fA-F]{96}$/.test(v)

function isApprovedDstackOs(m: unknown): m is ApprovedDstackOs {
  if (!m || typeof m !== 'object') return false
  const e = m as Record<string, unknown>
  return typeof e['name'] === 'string' && MEASUREMENT_FIELDS.every((f) => isMeasurement(e[f]))
}

function isApprovedSellerImage(m: unknown): m is ApprovedSellerImage {
  if (!m || typeof m !== 'object') return false
  const e = m as Record<string, unknown>
  return typeof e['version'] === 'string' && typeof e['digest'] === 'string' && /^sha256:[0-9a-f]{64}$/.test(e['digest'])
}

/**
 * The approved builds plus a buyer's own additions from ANTSEED_VERIFIER_NODE_BUILDS: JSON
 * `{ "os": [...], "images": [...] }`, inline or "@/path/to/file.json". Additions only widen what
 * this buyer accepts; malformed entries are ignored.
 */
export function readApprovedNodeBuilds(): ApprovedNodeBuilds {
  const builds = { os: [...APPROVED_DSTACK_OS], images: [...APPROVED_SELLER_IMAGES] }
  const raw = process.env['ANTSEED_VERIFIER_NODE_BUILDS']?.trim()
  if (!raw) return builds
  try {
    const parsed = JSON.parse(raw.startsWith('@') ? readFileSync(raw.slice(1), 'utf8') : raw) as Record<string, unknown> | null
    const list = (key: string): unknown[] => (Array.isArray(parsed?.[key]) ? parsed[key] as unknown[] : [])
    return {
      os: [...builds.os, ...list('os').filter(isApprovedDstackOs)],
      images: [...builds.images, ...list('images').filter(isApprovedSellerImage)],
    }
  } catch (err) {
    process.stderr.write(`[verifier] ignoring ANTSEED_VERIFIER_NODE_BUILDS: ${err instanceof Error ? err.message : String(err)}\n`)
    return builds
  }
}
