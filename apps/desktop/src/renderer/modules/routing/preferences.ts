import type { VprPeerListing, VprRoutingPreferences, VprRouteSelection } from '../../core/state';
import type { ModelRoutingPreferences } from '@antseed/node/model-routing';

export const VPR_PREFERENCES_STORAGE_KEY = 'antseed.desktop.vpr.preferences';
export const VPR_ROUTE_SELECTION_STORAGE_KEY = 'antseed.desktop.vpr.routeSelection';
const VPR_PREFERENCES_VERSION = 2;
const ROUTING_PEER_ID_PATTERN = /^(?:0x)?[0-9a-f]{40}$/i;

type StoredObject = Record<string, unknown>;

function isStoredObject(value: unknown): value is StoredObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function loadJson(storageKey: string): unknown {
  if (typeof localStorage === 'undefined') {
    return null;
  }
  const raw = localStorage.getItem(storageKey);
  if (raw === null) {
    return null;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function readNonNegativeFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Trimmed, de-duplicated, blank-free peer id list — order preserved. */
export function normalizePeerIdList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const peerId = item.trim();
    if (peerId.length > 0) seen.add(peerId);
  }
  return [...seen];
}

function loadRouteModel(value: unknown): VprRouteSelection['model'] {
  if (value === null) {
    return null;
  }
  if (!isStoredObject(value)) {
    return null;
  }
  if (
    typeof value.provider !== 'string' ||
    typeof value.serviceId !== 'string' ||
    typeof value.label !== 'string'
  ) {
    return null;
  }

  return {
    provider: value.provider,
    serviceId: value.serviceId,
    label: value.label,
    categories: isStringArray(value.categories) ? value.categories : [],
  };
}

export function loadVprRoutingPreferences(fallback: VprRoutingPreferences): VprRoutingPreferences {
  const parsed = loadJson(VPR_PREFERENCES_STORAGE_KEY);
  if (!isStoredObject(parsed)) {
    return fallback;
  }

  // Pre-versioned preferences defaulted minTrustScore to 0; a stored 0 there
  // means "never touched", so it adopts the new default instead.
  let minTrustScore = readNonNegativeFiniteNumber(parsed.minTrustScore, fallback.minTrustScore);
  if (parsed.version !== VPR_PREFERENCES_VERSION && minTrustScore === 0) {
    minTrustScore = fallback.minTrustScore;
  }

  return {
    autoRouting: readBoolean(parsed.autoRouting, fallback.autoRouting),
    preferFreePeers: readBoolean(parsed.preferFreePeers, fallback.preferFreePeers),
    maxInputUsdPerMillion: readNonNegativeFiniteNumber(
      parsed.maxInputUsdPerMillion,
      fallback.maxInputUsdPerMillion,
    ),
    minTrustScore,
    allowedPeerIds: Array.isArray(parsed.allowedPeerIds)
      ? normalizePeerIdList(parsed.allowedPeerIds)
      : fallback.allowedPeerIds,
    blockedPeerIds: Array.isArray(parsed.blockedPeerIds)
      ? normalizePeerIdList(parsed.blockedPeerIds)
      : fallback.blockedPeerIds,
  };
}

export function saveVprRoutingPreferences(value: VprRoutingPreferences): void {
  if (typeof localStorage === 'undefined') {
    return;
  }
  localStorage.setItem(VPR_PREFERENCES_STORAGE_KEY, JSON.stringify({
    version: VPR_PREFERENCES_VERSION,
    ...value,
  }));
}

export function buyerModelRoutingPreferences(
  value: VprRoutingPreferences,
): ModelRoutingPreferences {
  const validPeerIds = (peerIds: string[]): string[] => normalizePeerIdList(peerIds)
    .filter((peerId) => ROUTING_PEER_ID_PATTERN.test(peerId));
  return {
    preferFreePeers: value.preferFreePeers,
    maxInputUsdPerMillion: value.maxInputUsdPerMillion,
    minTrustScore: value.minTrustScore,
    allowedPeerIds: validPeerIds(value.allowedPeerIds),
    blockedPeerIds: validPeerIds(value.blockedPeerIds),
  };
}

export function peerListingOf(preferences: VprRoutingPreferences, peerId: string): VprPeerListing {
  if (preferences.blockedPeerIds.includes(peerId)) return 'blocked';
  if (preferences.allowedPeerIds.includes(peerId)) return 'allowed';
  return 'none';
}

/**
 * Move a peer onto one routing list, off the other. The lists stay mutually
 * exclusive so the UI never has to render a peer that is both allowed and
 * blocked.
 */
export function applyPeerListing(
  preferences: VprRoutingPreferences,
  peerId: string,
  listing: VprPeerListing,
): VprRoutingPreferences {
  const id = peerId.trim();
  if (id.length === 0) return preferences;

  const allowed = preferences.allowedPeerIds.filter((entry) => entry !== id);
  const blocked = preferences.blockedPeerIds.filter((entry) => entry !== id);
  if (listing === 'allowed') allowed.push(id);
  if (listing === 'blocked') blocked.push(id);

  return { ...preferences, allowedPeerIds: allowed, blockedPeerIds: blocked };
}

export function loadVprRouteSelection(fallback: VprRouteSelection): VprRouteSelection {
  const parsed = loadJson(VPR_ROUTE_SELECTION_STORAGE_KEY);
  if (!isStoredObject(parsed)) {
    return fallback;
  }
  if (parsed.mode !== 'auto' && parsed.mode !== 'pinned-peer') {
    return fallback;
  }

  return {
    model: loadRouteModel(parsed.model),
    mode: parsed.mode,
    peerId: typeof parsed.peerId === 'string' || parsed.peerId === null ? parsed.peerId : fallback.peerId,
  };
}

export function saveVprRouteSelection(value: VprRouteSelection): void {
  if (typeof localStorage === 'undefined') {
    return;
  }
  localStorage.setItem(VPR_ROUTE_SELECTION_STORAGE_KEY, JSON.stringify(value));
}
