import { normalizedModelReputationScore } from '../reputation/model-reputation.js';

export type ModelRoutingPreferences = {
  preferFreePeers: boolean;
  maxInputUsdPerMillion: number;
  minTrustScore: number;
  allowedPeerIds: string[];
  blockedPeerIds: string[];
};

export const DEFAULT_MODEL_ROUTING_PREFERENCES: ModelRoutingPreferences = {
  preferFreePeers: false,
  maxInputUsdPerMillion: 25,
  minTrustScore: 60,
  allowedPeerIds: [],
  blockedPeerIds: [],
};

export type ModelRouteCandidate = {
  peerId: string;
  effectiveReputationScore?: number | null;
  onChainReputationScore?: number | null;
  reputationScore?: number | null;
  inputUsdPerMillion?: number | null;
  outputUsdPerMillion?: number | null;
  minImageUsdPerImage?: number | null;
  /** Speech routes: USD per `input` character; 0 when free, null when not advertised. */
  speechUsdPerCharacter?: number | null;
  peerCooldownUntil?: number | null;
  peerFailureStreak?: number | null;
};

export type ScoredModelRoute<T extends ModelRouteCandidate> = {
  route: T;
  score: number;
  reasons: string[];
};

const UNKNOWN_PRICE_PENALTY = 10;
const COOLING_DOWN_PENALTY = 1000;
const FAILURE_STREAK_PENALTY = 3;
const MAX_COOLDOWN_MS = 8 * 60_000;

function normalizedPeerId(peerId: string): string {
  return peerId.trim().toLowerCase().replace(/^0x/, '');
}

function peerIdSet(values: string[]): Set<string> {
  return new Set(values.map(normalizedPeerId).filter((value) => value.length > 0));
}

export function modelRouteReputationScore(route: ModelRouteCandidate): number | null {
  const effective = route.effectiveReputationScore;
  if (typeof effective === 'number' && Number.isFinite(effective)) return effective;
  return normalizedModelReputationScore(route);
}

export function modelRouteTotalPrice(route: ModelRouteCandidate): number | null {
  const characterPrice = route.speechUsdPerCharacter;
  if (typeof characterPrice === 'number' && Number.isFinite(characterPrice) && characterPrice >= 0) {
    return characterPrice;
  }
  const imagePrice = route.minImageUsdPerImage;
  if (typeof imagePrice === 'number' && Number.isFinite(imagePrice) && imagePrice >= 0) {
    return imagePrice;
  }
  const input = route.inputUsdPerMillion;
  const output = route.outputUsdPerMillion;
  if (
    typeof input !== 'number'
    || !Number.isFinite(input)
    || input < 0
    || typeof output !== 'number'
    || !Number.isFinite(output)
    || output < 0
  ) {
    return null;
  }
  return input + output;
}

export function isModelRouteCoolingDown(
  route: ModelRouteCandidate,
  now: number = Date.now(),
): boolean {
  const until = route.peerCooldownUntil;
  if (typeof until !== 'number' || !Number.isFinite(until) || until <= now) return false;
  return until - now <= MAX_COOLDOWN_MS;
}

export function isModelRoutePeerAllowed(
  peerId: string,
  preferences: ModelRoutingPreferences,
): boolean {
  const normalized = normalizedPeerId(peerId);
  const blocked = peerIdSet(preferences.blockedPeerIds);
  if (blocked.has(normalized)) return false;
  const allowed = peerIdSet(preferences.allowedPeerIds);
  return allowed.size === 0 || allowed.has(normalized);
}

export function isModelRouteEligible(
  route: ModelRouteCandidate,
  preferences: ModelRoutingPreferences,
): boolean {
  if (!isModelRoutePeerAllowed(route.peerId, preferences)) return false;
  if (preferences.minTrustScore <= 0) return true;
  const reputation = modelRouteReputationScore(route);
  return reputation !== null && reputation >= preferences.minTrustScore;
}

export function scoreModelRoute<T extends ModelRouteCandidate>(
  route: T,
  preferences: ModelRoutingPreferences,
  now: number = Date.now(),
): ScoredModelRoute<T> {
  const reasons: string[] = [];
  let score = 100;

  if (isModelRouteCoolingDown(route, now)) {
    score -= COOLING_DOWN_PENALTY;
    reasons.push('peer cooling down');
  } else {
    const failureStreak = typeof route.peerFailureStreak === 'number' && Number.isFinite(route.peerFailureStreak)
      ? Math.max(0, Math.trunc(route.peerFailureStreak))
      : 0;
    if (failureStreak > 0) {
      score -= FAILURE_STREAK_PENALTY * failureStreak;
      reasons.push('recent peer failures');
    }
  }

  const totalPrice = modelRouteTotalPrice(route);
  if (preferences.preferFreePeers && totalPrice === 0) {
    score += 25;
    reasons.push('free peer preferred');
  }

  const inputPrice = route.inputUsdPerMillion;
  if (
    typeof inputPrice === 'number'
    && Number.isFinite(inputPrice)
    && inputPrice > preferences.maxInputUsdPerMillion
  ) {
    score -= 50;
    reasons.push('input price exceeds maximum');
  }

  const reputation = modelRouteReputationScore(route);
  if (reputation !== null && reputation < preferences.minTrustScore) {
    score -= 50;
    reasons.push('trust score below minimum');
  }
  score += Math.min(reputation ?? 0, 100) / 5;

  if (totalPrice === null) {
    score -= UNKNOWN_PRICE_PENALTY;
    reasons.push('price unknown');
  } else {
    score -= totalPrice;
  }

  return { route, score, reasons };
}

function compareModelRouteRank<T extends ModelRouteCandidate>(
  a: ScoredModelRoute<T>,
  b: ScoredModelRoute<T>,
  preferences: ModelRoutingPreferences,
  now: number,
): number {
  const aEligible = isModelRouteEligible(a.route, preferences);
  const bEligible = isModelRouteEligible(b.route, preferences);
  if (aEligible !== bEligible) return aEligible ? -1 : 1;

  const aCooling = isModelRouteCoolingDown(a.route, now);
  const bCooling = isModelRouteCoolingDown(b.route, now);
  if (aCooling !== bCooling) return aCooling ? 1 : -1;

  const aPrice = modelRouteTotalPrice(a.route);
  const bPrice = modelRouteTotalPrice(b.route);
  const aKnown = aPrice !== null;
  const bKnown = bPrice !== null;
  if (aKnown !== bKnown) return aKnown ? -1 : 1;

  // Trust is a gate, not a rank: among eligible, ready peers the cheapest
  // total price wins, and the blended score (reputation, failure streaks,
  // preference bonuses) only breaks price ties. Reputation ordering above
  // the eligibility threshold would re-apply the trust filter as a soft
  // rank and let a well-rated seller beat a free one on 2 display points.
  if (aPrice !== bPrice) {
    return (aPrice ?? Number.POSITIVE_INFINITY) - (bPrice ?? Number.POSITIVE_INFINITY);
  }
  return b.score - a.score;
}

function compareScoredModelRoutes<T extends ModelRouteCandidate>(
  a: ScoredModelRoute<T>,
  b: ScoredModelRoute<T>,
  preferences: ModelRoutingPreferences,
  now: number,
): number {
  return compareModelRouteRank(a, b, preferences, now)
    || normalizedPeerId(a.route.peerId).localeCompare(normalizedPeerId(b.route.peerId));
}

// One counter per model or seller pool. A single process-wide counter
// phase-locks when the catalog ranks model A and then model B: each model
// keeps the same parity and the same seller stays first.
const MAX_ROTATION_POOLS = 4096;
const equalHeadRotation = new Map<string, number>();

function rememberRotation(key: string, step: number): void {
  if (equalHeadRotation.has(key)) equalHeadRotation.delete(key);
  equalHeadRotation.set(key, step);
  while (equalHeadRotation.size > MAX_ROTATION_POOLS) {
    const oldest = equalHeadRotation.keys().next().value;
    if (oldest === undefined) break;
    equalHeadRotation.delete(oldest);
  }
}

function nextRotationOffset(key: string, group: number, advance: boolean): number {
  const step = ((equalHeadRotation.get(key) ?? 0) + 1) >>> 0;
  if (advance) rememberRotation(key, step);
  return step % group;
}

function rotationPoolKey<T extends ModelRouteCandidate>(
  ranked: ScoredModelRoute<T>[],
  group: number,
  rotationKey: string | undefined,
): string {
  if (rotationKey && rotationKey.length > 0) return `key:${rotationKey}`;
  const ids: string[] = [];
  for (let index = 0; index < group; index += 1) {
    const peerId = ranked[index]?.route.peerId;
    if (peerId) ids.push(normalizedPeerId(peerId));
  }
  ids.sort();
  return `peers:${ids.join('\n')}`;
}

function rotateEqualHead<T extends ModelRouteCandidate>(
  ranked: ScoredModelRoute<T>[],
  preferences: ModelRoutingPreferences,
  now: number,
  rotationKey: string | undefined,
  advance: boolean,
): ScoredModelRoute<T>[] {
  if (ranked.length < 2) return ranked;
  let group = 1;
  const first = ranked[0];
  if (!first) return ranked;
  while (group < ranked.length) {
    const next = ranked[group];
    if (!next || compareModelRouteRank(first, next, preferences, now) !== 0) break;
    group += 1;
  }
  if (group < 2) return ranked;
  const offset = nextRotationOffset(rotationPoolKey(ranked, group, rotationKey), group, advance);
  if (offset === 0) return ranked;
  const head = ranked.slice(0, group);
  for (let index = 0; index < group; index += 1) {
    const next = head[(index + offset) % group];
    if (next) ranked[index] = next;
  }
  return ranked;
}

export function rankModelRoutes<T extends ModelRouteCandidate>(
  routes: T[],
  preferences: ModelRoutingPreferences,
  now: number = Date.now(),
  rotationKey?: string,
  // A route preview and a model list pass false. They show the next seller
  // without spending the turn a live request should take.
  advance = true,
): T[] {
  const ranked = routes
    .map((route) => scoreModelRoute(route, preferences, now))
    .sort((a, b) => compareScoredModelRoutes(a, b, preferences, now));
  return rotateEqualHead(ranked, preferences, now, rotationKey, advance).map(({ route }) => route);
}

export function chooseBestModelRoute<T extends ModelRouteCandidate>(
  routes: T[],
  preferences: ModelRoutingPreferences,
  now: number = Date.now(),
  rotationKey?: string,
  advance = true,
): T | null {
  return rankModelRoutes(routes, preferences, now, rotationKey, advance)
    .find((route) => isModelRouteEligible(route, preferences)) ?? null;
}
