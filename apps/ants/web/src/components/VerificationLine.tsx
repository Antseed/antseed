import type { PoolVerification } from '../../../src/api-types';
import { formatInt } from '../format';
import { InfoHelp } from './EarlyExitHelp';

/** "108%" for 10,800 bps; one decimal only when the multiplier is not a whole percent. */
export function formatPointsMultiplier(bps: number): string {
  return `${bps % 100 === 0 ? bps / 100 : (bps / 100).toFixed(1)}%`;
}

/** "6 verified, 1 DIFF · points 108%"; counts that are zero are left out. */
export function verificationSummary(verification: PoolVerification): string {
  const counts = [
    verification.sameCount > 0 ? `${formatInt(verification.sameCount)} verified` : null,
    verification.diffCount > 0 ? `${formatInt(verification.diffCount)} DIFF` : null,
  ].filter(Boolean).join(', ');
  return verification.pointsMultiplierBps === null ? counts : `${counts} · points ${formatPointsMultiplier(verification.pointsMultiplierBps)}`;
}

/** Whether there is a verdict worth showing. */
export function hasVerdicts(verification: PoolVerification | undefined): verification is PoolVerification {
  return !!verification && (verification.sameCount > 0 || verification.diffCount > 0);
}

const EXPLANATION = 'Auditors check that this seller serves the models it lists. Verified models add to the points its sales earn; a DIFF (the served model didn’t match) takes points away. The pool’s rewards follow those points, so these results move its APR.';

/**
 * The seller's model checks for a pool: a dot (amber with a DIFF, green when every check passed), one line and, in full form,
 * links to each DIFF service's audit on Antscan. Renders nothing without a SAME or DIFF verdict.
 */
export function VerificationLine({ verification, compact = false }: { verification: PoolVerification | undefined; compact?: boolean }) {
  if (!hasVerdicts(verification)) return null;
  const tone = verification.diffCount > 0 ? 'amber' : 'green';
  const summary = verificationSummary(verification);
  if (compact) {
    return <span className={`verification-line verification-line--compact verification-line--${tone}`} title={`Model checks: ${summary}. ${EXPLANATION}`}>
      <i className="verification-line__dot" aria-hidden="true" />{summary}
    </span>;
  }
  return <p className={`verification-line verification-line--${tone}`}>
    <i className="verification-line__dot" aria-hidden="true" />
    <span>Model checks: {summary}</span>
    <InfoHelp label="About model checks" symbol="i">
      {EXPLANATION}
      {verification.sameServices.length ? ` Verified: ${verification.sameServices.map(service => service.service).join(', ')}.` : ''}
    </InfoHelp>
    {verification.diffServices.map(service => (
      <span key={service.url} className="verification-line__diff">
        · {service.service} <a href={service.url} target="_blank" rel="noreferrer" aria-label={`View audit for ${service.service} on Antscan`}>View audit ↗</a>
      </span>
    ))}
  </p>;
}
