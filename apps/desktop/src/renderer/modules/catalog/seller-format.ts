/** Shared formatting for the Figma "sellers list" rows (model page, prefs). */

import type { DiscoverRow, TrustBreakdown } from '../../core/state';
import { formatUsdShort } from '../../core/format';
import { isNativeVideoProtocol } from './model-capabilities';
import { freeTierHeadline } from './free-tier';

/** Below this a seller earns its buyers no ANTS to speak of (the Points site's "0× earns nothing"). */
export const BOOST_EARNING_MIN = 0.01;

/** Antseed Points boost, as the Points site shows it: "7.2×", "16×", "<0.1×", "0×"; "—" when unknown. */
export function formatBoost(boost: number | null | undefined): string {
  if (boost === null || boost === undefined || Number.isNaN(boost)) return '—';
  if (boost === 0) return '0×';
  if (boost < 0.1) return '<0.1×';
  return `${boost.toFixed(boost < 10 ? 1 : 0)}×`;
}

/**
 * The seller row's boost badge text: "No points" for a free route (points are
 * paid $ × boost, so free usage earns none whatever the pool), otherwise the
 * boost; null when the boost is unknown (Antscan unreachable).
 */
export function sellerBoostLabel(route: DiscoverRow): string | null {
  const boost = route.boost;
  if (boost === null || boost === undefined) return null;
  if (isFreeRoute(route)) return 'No points';
  return boost < BOOST_EARNING_MIN ? '0× earns nothing' : formatBoost(boost);
}

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
 * `Trust 7.0/10 = history 3.0 + usage 1.0 + power 0.5 + identity 2.0 GitHub + free models 0.5. Not flagged for wash trading.`
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
  const free = trust.freeModels ? ` + free models ${reputationScaleLabel(trust.freeModels.score)}` : '';
  const wash = trust.washFlagged === false ? ' Not flagged for wash trading.' : ' Wash-trading registry unavailable.';
  return `Trust ${reputationScaleLabel(trust.score)}/10 = ${history} + ${usage} + ${power} + ${identity}${free}.${wash}`;
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
