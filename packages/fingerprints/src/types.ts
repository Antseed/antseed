/**
 * Shared schema types for the Antseed fingerprint verifier suite.
 * See docs/protocol/spec/07-model-verification.md.
 */

import { canonicalHash } from './canonical-json.js';

export const FINGERPRINTS_PACKAGE_NAME = '@antseed/fingerprints';
export const FINGERPRINTS_PACKAGE_VERSION = '0.1.0';

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

export type FingerprintVerdict = 'SAME' | 'DIFF' | 'UNDETERMINED' | 'UNKNOWN';

// ---------------------------------------------------------------------------
// Probes
// ---------------------------------------------------------------------------

export type ToleranceMode = 'absolute' | 'relative';

export interface ProbeTolerance {
  mode: ToleranceMode;
  value: number;
}

/**
 * A single KBF numeric cloze probe. `consensus` is the expected answer;
 * during candidate generation it is advisory until the reference is certified.
 * Unknown extension fields (e.g. `contrast`, `consensusRaw`) are preserved.
 */
export interface KbfProbe {
  id: string;
  name: string;
  domain: string;
  /** Cloze template containing `___` (and optionally `{name}`). */
  template: string;
  consensus: number;
  range: [number, number];
  tolerance: ProbeTolerance;
  /** Optional contrast-model metadata, preserved verbatim. */
  contrast?: Record<string, unknown>;
  [extension: string]: unknown;
}

// ---------------------------------------------------------------------------
// Fingerprint reference envelope
// ---------------------------------------------------------------------------

export interface ReferenceGenerator {
  name: string;
  version: string;
  verifierKind: string;
  params: Record<string, unknown>;
  [extension: string]: unknown;
}

export interface ReferenceProvenance {
  license?: string;
  url?: string;
  commit?: string;
  [extension: string]: unknown;
}

export interface ReferenceSelfTest {
  /** Mismatch count of the reference model against its own probe set. */
  hamming: number;
  total: number;
  coverage: number;
  errorRate: number;
  [extension: string]: unknown;
}

/**
 * Common reference envelope shared by all verifier kinds
 * (spec 07 "Reference Schema"). Unknown extension fields are preserved.
 */
export interface FingerprintReference {
  version: number;
  kind: string;
  referenceId: string;
  referenceModel: string;
  serviceAliases: string[];
  createdAt: string;
  source: 'public' | 'generated' | 'imported';
  generator: ReferenceGenerator;
  provenance?: ReferenceProvenance;
  selfTest: ReferenceSelfTest;
  probes: KbfProbe[];
  [extension: string]: unknown;
}

/**
 * Content-addressed reference id: canonical hash over the reference minus
 * `referenceId` itself and any caller-declared local-only fields
 * (e.g. local filesystem paths, which MUST NOT be hashed).
 */
export function computeReferenceId(
  reference: FingerprintReference | Record<string, unknown>,
  localOnlyFields: string[] = [],
): string {
  const copy: Record<string, unknown> = { ...(reference as Record<string, unknown>) };
  delete copy['referenceId'];
  for (const field of localOnlyFields) {
    delete copy[field];
  }
  return canonicalHash(copy);
}

// ---------------------------------------------------------------------------
// Match vectors and observations
// ---------------------------------------------------------------------------

/** Per-probe outcome: 1 match, 0 discrepancy, null unscored (no usable answer, or not attempted). */
export type MatchEntry = 1 | 0 | null;
export type MatchVector = MatchEntry[];

/** Runtime guard: exactly 1, 0, or null — arbitrary truthy values are NOT matches. */
export function isMatchEntry(value: unknown): value is MatchEntry {
  return value === 1 || value === 0 || value === null;
}

/**
 * Runtime guard for match vectors crossing the public API boundary
 * (e.g. `FingerprintObservation.matchVector` supplied by a caller rather than
 * derived via `computeMatchVector`).
 */
export function isMatchVector(value: unknown): value is MatchVector {
  return Array.isArray(value) && value.every(isMatchEntry);
}

/** Parsed answers or a precomputed match vector for one evaluation. */
export interface FingerprintObservation {
  /** Parsed numeric answers, position-aligned with the probe set. */
  answers: Array<number | null>;
  /** Optional precomputed match vector (otherwise derived from answers). */
  matchVector?: MatchVector;
}

// ---------------------------------------------------------------------------
// Evaluation result
// ---------------------------------------------------------------------------

export interface FingerprintVerifierInfo {
  kind: string;
  package: string;
  version: string;
}

export interface FingerprintStats {
  selfHamming: number;
  selfTotal: number;
  targetHamming: number | null;
  targetTotal: number | null;
  selfCoverage: number;
  targetCoverage: number | null;
  p0Cp99: number | null;
  pValueBinomial: number | null;
}

export interface FingerprintEvaluation {
  verifier: FingerprintVerifierInfo;
  referenceId: string;
  referenceModel: string;
  probeCount: number;
  parsedProbeCount: number;
  matchVector: MatchVector;
  matchVectorHash: string;
  stats: FingerprintStats;
  verdict: FingerprintVerdict;
  verdictReason: string | null;
}
