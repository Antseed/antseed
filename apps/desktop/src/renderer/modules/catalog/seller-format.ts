/** Shared formatting for the Figma "sellers list" rows (model page, prefs). */

import type { DiscoverRow, TrustBreakdown } from '../../core/state';
import { formatUsdShort } from '../../core/format';
import { isNativeVideoProtocol } from './model-capabilities';
import { freeTierHeadline } from './free-tier';

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
 * `Trust 7.0/10 = power 4.0 + usage 1.0 + identity 1.5 GitHub + free models 0.5. Not flagged for wash trading.`
 * Flagged sellers read `Trust 0/10: flagged as a proven wash trader by the on-chain registry.`
 */
export function sellerReputationExplanation(route: DiscoverRow): string {
  const base = sellerTrustExplanation(route);
  if (!route.verification) return base;
  const sentence = base.endsWith('.') ? base : `${base}.`;
  if (route.verification === 'same') {
    return `${sentence} Model verification: SAME. An on-chain audit found this service answers like the genuine model.`;
  }
  return `${sentence} Model verification: DIFF. An on-chain audit suspects this service is not the model it claims, so its reputation is cut to 10% (${sellerReputationLabel(route)}/10).`;
}

function sellerTrustExplanation(route: DiscoverRow): string {
  const trust = route.trust;
  if (!trust) return `Trust: ${sellerReputationLabel(route)}/10`;
  if (trust.washFlagged) return 'Trust 0/10: flagged as a proven wash trader by the on-chain registry.';
  const usage = trust.usage ? `usage ${reputationScaleLabel(trust.usage.score)}` : 'usage n/a';
  const power = trust.power ? `power ${reputationScaleLabel(trust.power.score)}` : 'power n/a';
  const identity = trust.identity
    ? `identity ${reputationScaleLabel(trust.identity.score)} ${IDENTITY_KIND_LABELS[trust.identity.kind]}`
    : 'identity none';
  const free = trust.freeModels ? ` + free models ${reputationScaleLabel(trust.freeModels.score)}` : '';
  const v = trust.verification;
  const counts = v
    ? [v.sameCount > 0 ? `${v.sameCount} verified` : null, v.diffCount > 0 ? `${v.diffCount} DIFF` : null].filter(Boolean).join(', ')
    : '';
  const checks = v
    ? ` ${v.change < 0 ? '−' : '+'} model checks ${reputationScaleLabel(Math.abs(v.change))} (${counts}: earns ${Math.round(v.multiplierBps / 100)}% of normal points)`
    : '';
  const wash = trust.washFlagged === false ? ' Not flagged for wash trading.' : ' Wash-trading registry unavailable.';
  return `Trust ${reputationScaleLabel(trust.score)}/10 = ${power} + ${usage} + ${identity}${free}${checks}.${wash}`;
}

/** 0-100 score → "9.8" (10-point scale). */
export function reputationScaleLabel(score: number): string {
  return (Math.min(score, 100) / 10).toFixed(1);
}

/** "$0.60" → "$0.6" — the seller meta line uses trimmed amounts (Figma). */
function trimmedUsd(value: number): string {
  return formatUsdShort(value).replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
}

function usdRange(min: number | null, max: number | null): string | null {
  if (min === null) return null;
  return max !== null && max !== min ? `${trimmedUsd(min)}-${trimmedUsd(max)}` : trimmedUsd(min);
}

export function isFreeRoute(route: DiscoverRow): boolean {
  if (isNativeVideoProtocol(route.protocol)) {
    const prices = [route.maxVideoUsdPerSecond, route.maxVideoUsdPerVideo];
    return prices.some((price) => price !== null) && prices.every((price) => price === null || price <= 0);
  }
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
    parts.push(route.freeTier ? freeTierHeadline(route.freeTier, false) : 'Free');
  } else if (isNativeVideoProtocol(route.protocol)) {
    const perSecond = usdRange(route.minVideoUsdPerSecond, route.maxVideoUsdPerSecond);
    const perVideo = usdRange(route.minVideoUsdPerVideo, route.maxVideoUsdPerVideo);
    if (perVideo) parts.push(`${perVideo}/video`);
    if (perSecond) parts.push(`${perSecond}/sec`);
    if (!perVideo && !perSecond) parts.push('Price unknown');
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
  // A priced route's own free allowance, before its price applies.
  if (!isFreeRoute(route) && route.freeTier) parts.push(freeTierHeadline(route.freeTier, true));
  return parts.join(' · ');
}
