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

/**
 * dstack 0.6.1 production OS (https://github.com/Dstack-TEE/dstack/releases/tag/mkosi-os-v0.6.1,
 * os_image_hash ec43cb8c5e04b6bb6c53b33b16076a01d83d01f7f4b703f2f78a0d947d6247e6) on Phala Cloud's
 * CPU instance types. Computed with `dstack-mr measure -c <vcpus> -m <memory>G --qemu-version 8.2.2
 * --hotplug-off false` (dstack v0.6.1) from the release's measurement bundle; Phala Cloud's hosts run
 * that QEMU with hotplug on. MRTD, RTMR1 and RTMR2 are the same for every shape.
 */
const DSTACK_0_6_1 = {
  mrtd: '2a674327c50218dba880066b349b8d559d749ed68dce33fd651c184a877d084b07a9e583767a7ad5da13ed91deec2b70',
  rtmr1: '89ef86c5125b986c325f0a94acfa87718a4ef3a4d4f237dbb72dda3cf777fd2c054555fb4407eb53338d7d67329a7333',
  rtmr2: 'e9000e338f33233e8f51b7fd031e1c158bdcf8572eab041c0bc8eb7fef48b23259a6a556e6c8e2af99999fc39c793179',
}
const DSTACK_0_6_1_RTMR0: [shape: string, vcpus: number, memoryGiB: number, rtmr0: string][] = [
  ['tdx.small', 1, 2, '68102e7b524af310f7b7d426ce75481e36c40f5d513a9009c046e9d37e31551f0134d954b496a3357fd61d03f07ffe96'],
  ['tdx.medium', 2, 4, '027b610ab0555482f8a3868524093bdf3cdbe2539f81dfeeb886864654cb2fe3422f7fc36d4bab6fa46683aad11d1ba7'],
  ['tdx.large', 4, 8, 'fb14dc139f33d6fcf474bc8332cac001259fb31cfbcb6b34d4ceeb552a2c4466884a0cbde45ad98a05c5c060c23ad65a'],
  ['tdx.xlarge', 8, 16, 'ec216f1d1d591468ff4741b9b192f016b26d3f90303bfa9dbb97557273853183981f21a4bcb3ae908247538d371ad072'],
  ['tdx.2xlarge', 16, 32, 'd6118f0eeb30e9d9178d2b9106dddd002d979b6fa79bdec415051afae2021384c29a32d2f6454fa369617598378ffb5e'],
  ['tdx.4xlarge', 32, 64, '55b9b0d73279fd2079274371e639b70161a69447b6b07f7b5266f0b8a47fd1e527fca30338879b47ac18d9bf66022e5c'],
  ['tdx.8xlarge', 64, 128, 'de03721065571be16e3ccbb76dacdc86a6dfb35255480dfc97932995c5d0973b6f0b6b7b9f8e88b838d72bc75e8a287c'],
]

/** dstack production OS images, one entry per release and VM shape. */
export const APPROVED_DSTACK_OS: readonly ApprovedDstackOs[] = DSTACK_0_6_1_RTMR0.map(([shape, vcpus, memoryGiB, rtmr0]) => ({
  name: `dstack 0.6.1 (${shape}, ${vcpus} vCPU, ${memoryGiB} GiB)`,
  ...DSTACK_0_6_1,
  rtmr0,
}))

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
