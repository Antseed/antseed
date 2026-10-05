import type { VerifierCLIConfig } from '../config/types.js'

export const DEFAULT_REFERENCE_MINIMUM_PROBE_COUNT = 100
export const DEFAULT_REFERENCE_MAXIMUM_PROBE_COUNT = 500
export const DEFAULT_REFERENCE_PROBE_STEP = 10
export const DEFAULT_REFERENCE_MINIMUM_STATISTICAL_POWER = 0.9
export const REFERENCE_MINIMUM_MISMATCH_DELTA = 0.1
export const REFERENCE_POWER_ALPHA = 0.05
export const REFERENCE_POWER_CONFIDENCE = 0.99

export interface ReferenceSizingPolicy {
  minimumProbeCount: number
  maximumProbeCount: number
  probeStep: number
  minimumStatisticalPower: number
}

export function resolveReferenceSizingPolicy(config: VerifierCLIConfig | undefined): ReferenceSizingPolicy {
  return {
    minimumProbeCount: config?.referenceMinimumProbeCount ?? DEFAULT_REFERENCE_MINIMUM_PROBE_COUNT,
    maximumProbeCount: config?.referenceMaximumProbeCount ?? DEFAULT_REFERENCE_MAXIMUM_PROBE_COUNT,
    probeStep: config?.referenceProbeStep ?? DEFAULT_REFERENCE_PROBE_STEP,
    minimumStatisticalPower: config?.referenceMinimumStatisticalPower
      ?? DEFAULT_REFERENCE_MINIMUM_STATISTICAL_POWER,
  }
}

export function isReferenceProbeCountAllowed(count: number, policy: ReferenceSizingPolicy): boolean {
  return Number.isInteger(count)
    && count >= policy.minimumProbeCount
    && count <= policy.maximumProbeCount
    && (count - policy.minimumProbeCount) % policy.probeStep === 0
}
