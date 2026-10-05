/**
 * KBF (Knowledge Boundary Fingerprinting) verifier — spec 07 F1.
 * Reference-based verification: the reference model's own self-test bounds
 * the honest error rate; the target's mismatch count is binomial-tested
 * against that bound.
 */

import {
  FINGERPRINTS_PACKAGE_NAME,
  FINGERPRINTS_PACKAGE_VERSION,
  isMatchVector,
  type FingerprintEvaluation,
  type FingerprintObservation,
  type FingerprintStats,
  type FingerprintReference,
  type MatchVector,
} from '../../types.js';
import { canonicalHash } from '../../canonical-json.js';
import { computeMatchVector } from './scoring.js';
import { computeKbfVerdict } from './verdict.js';
import { subsetReferenceSelfTest, type KbfReferenceV1 } from './reference.js';

export * from './prompts.js';
export * from './parser.js';
export * from './scoring.js';
export * from './stats.js';
export * from './verdict.js';
export * from './reference.js';

export const KBF_KIND = 'kbf';

export interface VerifyKbfOptions {
  minCoverage?: number;
  cpConfidence?: number;
  alpha?: number;
}

export function verifyKbf(
  reference: FingerprintReference,
  observation: FingerprintObservation,
  options: VerifyKbfOptions = {},
): FingerprintEvaluation {
    const base = {
      verifier: {
        kind: KBF_KIND,
        package: FINGERPRINTS_PACKAGE_NAME,
        version: FINGERPRINTS_PACKAGE_VERSION,
      },
      referenceId: reference.referenceId,
      referenceModel: reference.referenceModel,
      probeCount: reference.probes.length,
    };

    const unknown = (reason: string): FingerprintEvaluation => ({
      ...base,
      parsedProbeCount: 0,
      matchVector: [],
      matchVectorHash: canonicalHash([]),
      stats: emptyStats(reference),
      verdict: 'UNKNOWN',
      verdictReason: reason,
    });

    if (reference.kind !== KBF_KIND) {
      return unknown(`reference kind "${reference.kind}" is not "${KBF_KIND}"`);
    }

    let matchVector: MatchVector;
    if (observation.matchVector) {
      if (observation.matchVector.length !== reference.probes.length) {
        return unknown(
          `match vector length ${observation.matchVector.length} !== probe count ${reference.probes.length}`,
        );
      }
      // Caller-supplied vector: runtime-validate so arbitrary truthy entries
      // cannot pass as matches.
      if (!isMatchVector(observation.matchVector)) {
        return unknown('match vector entries must be exactly 0, 1, or null');
      }
      matchVector = observation.matchVector;
    } else {
      if (observation.answers.length !== reference.probes.length) {
        return unknown(
          `answers length ${observation.answers.length} !== probe count ${reference.probes.length}`,
        );
      }
      matchVector = computeMatchVector(observation.answers, reference.probes);
    }

    let selectedSelfTest;
    try {
      selectedSelfTest = subsetReferenceSelfTest(
        reference as KbfReferenceV1,
        reference.probes.map((probe) => probe.id),
      );
    } catch (error) {
      return unknown(`invalid reference self-test: ${error instanceof Error ? error.message : String(error)}`);
    }
    const { verdict, verdictReason, stats } = computeKbfVerdict({
      selfHamming: selectedSelfTest.hamming,
      selfTotal: selectedSelfTest.total,
      targetMatchVector: matchVector,
      minCoverage: options.minCoverage,
      cpConfidence: options.cpConfidence,
      alpha: options.alpha,
    });

    const parsedProbeCount = matchVector.filter((entry) => entry !== null).length;

    const fingerprintStats: FingerprintStats = {
      selfHamming: stats.selfHamming,
      selfTotal: stats.selfTotal,
      targetHamming: stats.targetHamming,
      targetTotal: stats.targetTotal,
      selfCoverage: selectedSelfTest.coverage,
      targetCoverage: stats.targetCoverage,
      p0Cp99: stats.p0Cp99,
      pValueBinomial: stats.pValueBinomial,
    };

    return {
      ...base,
      parsedProbeCount,
      matchVector,
      matchVectorHash: canonicalHash(matchVector),
      stats: fingerprintStats,
      verdict,
      verdictReason,
    };
}

function emptyStats(reference: FingerprintReference): FingerprintStats {
  return {
    selfHamming: reference.selfTest.hamming,
    selfTotal: reference.selfTest.total,
    targetHamming: null,
    targetTotal: null,
    selfCoverage: reference.selfTest.coverage,
    targetCoverage: null,
    p0Cp99: null,
    pValueBinomial: null,
  };
}
