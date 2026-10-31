import type { KbfProbe, KbfReferenceV1 } from '@antseed/fingerprints'

/**
 * Files of one distributed KBF round. Everything is canonical JSON; on-chain hashes are
 * keccak256 over the exact published bytes.
 */

/** One audited (seller, service). Targets are ordered by (agentId, serviceHash). */
export interface RoundTargetV1 {
  agentId: string
  /** Seller peer id (EVM address, lowercase, no 0x). */
  peerId: string
  /** Service name as the seller advertises it. */
  service: string
  serviceHash: string
  /** Audited model id from the on-chain list, e.g. "claude-opus-5.5". */
  model: string
  modelHash: string
}

/** Sealed bank plaintext: one KBF reference per audited model, built fresh for the epoch. */
export interface EpochBankV1 {
  kind: 'antseed-kbf-epoch-bank'
  version: 1
  epoch: string
  /** Keyed by audited model id. */
  models: Record<string, KbfReferenceV1>
}

/** One request to a seller: up to 10 probes in one prompt variant. */
export interface PlannedBatchV1 {
  batchIndex: number
  probeIds: string[]
  promptVariantId: string
}

export interface PlannedSliceV1 {
  targetKey: string
  sliceIndex: number
  batches: PlannedBatchV1[]
  /** First and second collector in the slice's seeded ranking (lowercase addresses). */
  owner: string
  backup: string
}

export interface RoundPlanV1 {
  epoch: string
  seed: string
  targets: RoundTargetV1[]
  /** Probe ids asked of each target, in batch order, keyed by `targetKey`. */
  targetProbes: Record<string, string[]>
  slices: PlannedSliceV1[]
}

/** What one collector needs to buy one slice, without the bank's answers. */
export interface EnvelopeSliceV1 {
  target: RoundTargetV1
  sliceIndex: number
  batches: Array<PlannedBatchV1 & { probes: KbfProbe[] }>
  /** Request settings from the model's reference (thinking suppression, max tokens). */
  request: {
    maxTokens: number
    thinkingOverrides: Record<string, unknown>
    assistantPrefill: string | null
  }
}

export interface EnvelopeContentV1 {
  kind: 'antseed-kbf-envelope'
  version: 1
  epoch: string
  collector: string
  backup: boolean
  slices: EnvelopeSliceV1[]
}

/** X25519 + HKDF-SHA256 + AES-256-GCM, all fields base64. */
export interface SealedEnvelopeV1 {
  ephemeralPublicKey: string
  iv: string
  tag: string
  ciphertext: string
}

/** Published by the publisher after the seed; its keccak256 is the on-chain plan hash. */
export interface PlanFileV1 {
  kind: 'antseed-kbf-plan'
  version: 1
  epoch: string
  seed: string
  backup: boolean
  targets: RoundTargetV1[]
  /** Keyed by lowercase collector address. */
  envelopes: Record<string, SealedEnvelopeV1>
}

/** One seller response, with everything a third party needs to check its signature. */
export interface SliceExchangeV1 {
  batchIndex: number
  requestId: string
  /** The seller's ResponseAuth record (all signed fields plus the signature). */
  responseAuth: {
    version: 1
    requestId: string
    channelId?: string
    buyerPeerId: string
    sellerPeerId: string
    advertisedService: string
    provider: string
    statusCode: number
    requestHash: string
    responseHash: string
    responseStartedAt: number
    responseCompletedAt: number
    signature: string
  }
  /** Exact P2P request and response bytes (antseed-http-codec-v1) the signature covers. */
  requestBase64: string
  responseBase64: string
}

export interface CollectedSliceV1 {
  targetKey: string
  sliceIndex: number
  exchanges: SliceExchangeV1[]
}

/** Published by a collector; its keccak256 is the committed slices root. */
export interface SliceManifestV1 {
  kind: 'antseed-kbf-slices'
  version: 1
  epoch: string
  collector: string
  backup: boolean
  slices: CollectedSliceV1[]
}

export type RoundVerdict = 'SAME' | 'DIFF' | 'UNDETERMINED'

export interface TargetResultV1 {
  targetKey: string
  target: RoundTargetV1
  verdict: RoundVerdict
  reason: string
  answeredProbes: number
  totalProbes: number
  /** Collector and commit of every batch used, in batch order. */
  sources: Array<{ batchIndex: number; collector: string; manifestUri: string }>
}

export interface CollectorCreditV1 {
  collector: string
  slices: number
}

/** A verifier's scoring of the whole epoch; the results root is computed from it. */
export interface RoundResultsV1 {
  kind: 'antseed-kbf-results'
  version: 1
  epoch: string
  seed: string
  results: TargetResultV1[]
  credits: CollectorCreditV1[]
  totalSlices: number
  root: string
}

export function targetKey(target: Pick<RoundTargetV1, 'agentId' | 'serviceHash'>): string {
  return `${target.agentId}:${target.serviceHash.toLowerCase()}`
}
