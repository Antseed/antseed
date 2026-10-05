/** Shared formatting for the Figma "sellers list" rows (model page, prefs). */

import type { DiscoverRow, TrustBreakdown } from '../../core/state';
import { formatUsdShort } from '../../core/format';

/** Effective model reputation is 0-100; the UI shows it on a 10-point scale. */
export function sellerReputationLabel(route: DiscoverRow): string {
  const score = route.effectiveReputationScore ?? route.onChainReputationScore;
  if (score === null) return '-';
  return reputationScaleLabel(score);
}

const IDENTITY_KIND_LABELS: Record<NonNullable<TrustBreakdown['identity']>['kind'], string> = {
  github: 'GitHub',
  domain: 'domain',
};

/**
 * Tooltip spelling out the trust formula for one seller, e.g.
 * `Trust 6.5/10 = history 3.0 + usage 1.0 + power 0.5 + identity 2.0 GitHub. Not flagged for wash trading.`
 * Flagged sellers read `Trust 0/10: flagged as a proven wash trader by the on-chain registry.`
 */
export function sellerReputationExplanation(route: DiscoverRow): string {
  const trust = route.trust;
  if (!trust) return `Trust: ${sellerReputationLabel(route)}/10`;
  if (trust.washFlagged) return 'Trust 0/10: flagged as a proven wash trader by the on-chain registry.';
  const history = trust.history ? `history ${reputationScaleLabel(trust.history.score)}` : 'history n/a';
  const usage = trust.usage ? `usage ${reputationScaleLabel(trust.usage.score)}` : 'usage n/a';
  const power = trust.power ? `power ${reputationScaleLabel(trust.power.score)}` : 'power n/a';
  const identity = trust.identity
    ? `identity ${reputationScaleLabel(trust.identity.score)} ${IDENTITY_KIND_LABELS[trust.identity.kind]}`
    : 'identity none';
  const wash = trust.washFlagged === false ? ' Not flagged for wash trading.' : ' Wash-trading registry unavailable.';
  return `Trust ${reputationScaleLabel(trust.score)}/10 = ${history} + ${usage} + ${power} + ${identity}.${wash}`;
}

/** 0-100 score → "9.8" (10-point scale). */
export function reputationScaleLabel(score: number): string {
  return (Math.min(score, 100) / 10).toFixed(1);
}

/** "$0.60" → "$0.6" — the seller meta line uses trimmed amounts (Figma). */
function trimmedUsd(value: number): string {
  return formatUsdShort(value).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

export function isFreeRoute(route: DiscoverRow): boolean {
  if (route.protocol === 'openai-images') {
    return route.maxImageUsdPerImage !== null && route.maxImageUsdPerImage <= 0;
  }
  const { inputUsdPerMillion: input, outputUsdPerMillion: output } = route;
  return input !== null && output !== null && input <= 0 && output <= 0;
}

/** "May 20, 2026 · $0.6/m input · $1.8/m output" (Figma sellers list row). */
export function sellerMetaLabel(route: DiscoverRow): string {
  const parts: string[] = [];
  if (isFreeRoute(route)) {
    parts.push('Free');
  } else if (route.protocol === 'openai-images' && route.minImageUsdPerImage !== null) {
    const min = trimmedUsd(route.minImageUsdPerImage);
    const max = route.maxImageUsdPerImage;
    parts.push(max !== null && max !== route.minImageUsdPerImage
      ? `${min}-${trimmedUsd(max)}/image`
      : `${min}/image`);
  } else if (route.inputUsdPerMillion !== null) {
    parts.push(`${trimmedUsd(route.inputUsdPerMillion)}/m input`);
    if (route.outputUsdPerMillion !== null) {
      parts.push(`${trimmedUsd(route.outputUsdPerMillion)}/m output`);
    }
  } else {
    parts.push('Price unknown');
  }
  return parts.join(' · ');
}
