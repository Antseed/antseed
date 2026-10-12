import type { DiscoverRow, PeerEntry } from '../../core/state';
import type { LogEvent, RuntimeProcessState, SystemProxyProfileSummary } from '../../types/bridge';
import { CODING_ONLY_SUFFIX_RE } from '../catalog/model-identity';

export type VprPeerOption = { peerId: string; label: string; services: string[]; online: boolean };
export type VprProfileTraffic = {
  count: number;
  lastSeen: number | null;
  lastLine: string | null;
  lastStatus: number | null;
  lastStatusAt: number | null;
};
export type VprToolRoute = { peerId: string; model: string };

export const STATUS_TEXT: Record<number, string> = {
  400: 'Bad request', 401: 'Unauthorized', 402: 'Payment required', 403: 'Forbidden',
  404: 'Not found', 408: 'Timeout', 429: 'Rate limited',
  500: 'Server error', 502: 'Bad gateway', 503: 'Unavailable', 504: 'Gateway timeout',
};

export function isOkStatus(code: number | null): boolean {
  return code !== null && code >= 200 && code < 400;
}

export function statusLabel(code: number): string {
  if (isOkStatus(code)) return 'Healthy';
  return `${code} ${STATUS_TEXT[code] ?? 'Error'}`;
}

export function shortPeerId(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}...${id.slice(-4)}` : id;
}

export function buildVprPeerOptions(lastPeers: PeerEntry[], discoverRows: DiscoverRow[]): VprPeerOption[] {
  const byPeer = new Map<string, VprPeerOption>();
  for (const peer of lastPeers) {
    byPeer.set(peer.peerId, {
      peerId: peer.peerId,
      label: peer.displayName || shortPeerId(peer.peerId),
      services: peer.services,
      online: peer.online,
    });
  }
  for (const row of discoverRows) {
    const existing = byPeer.get(row.peerId);
    const services = new Set(existing?.services ?? []);
    if (row.serviceId) services.add(row.serviceId);
    byPeer.set(row.peerId, {
      peerId: row.peerId,
      label: row.peerDisplayName || row.peerLabel || existing?.label || shortPeerId(row.peerId),
      services: [...services],
      online: existing?.online ?? true,
    });
  }
  return [...byPeer.values()].sort((a, b) => (
    a.online !== b.online ? (a.online ? -1 : 1) : a.label.localeCompare(b.label)
  ));
}

export function activeProfilesFromRuntimeState(state: RuntimeProcessState | null): Set<string> | null {
  const raw = state?.activeProfileNames;
  return Array.isArray(raw) ? new Set(raw.filter((entry): entry is string => typeof entry === 'string')) : null;
}

export function buildVprProfileTraffic(
  logs: LogEvent[],
  profiles: SystemProxyProfileSummary[],
): Map<string, VprProfileTraffic> {
  const traffic = new Map<string, VprProfileTraffic>();
  for (const profile of profiles) {
    traffic.set(profile.name, { count: 0, lastSeen: null, lastLine: null, lastStatus: null, lastStatusAt: null });
  }

  for (const event of logs) {
    if (event.mode !== 'system-proxy') continue;
    const line = event.line.replace(/\x1b\[[0-9;]*m/g, '');
    const response = line.match(/←\s+(\d{3})\s+(\S+)\s+\|\s+source:(\S+)/);
    if (response) {
      const status = Number(response[1]);
      const host = response[2]!;
      const source = response[3]!;
      const profile = profiles.find((entry) => entry.name === source || entry.domains.some((domain) => host === domain || host.includes(domain)));
      if (profile) {
        const prev = traffic.get(profile.name)!;
        traffic.set(profile.name, { ...prev, lastStatus: status, lastStatusAt: event.timestamp });
      }
      continue;
    }

    if (!/(?:CONNECT|→)\s/.test(line)) continue;
    const profile = profiles.find((entry) => line.includes(`source:${entry.name}`) || entry.domains.some((domain) => line.includes(domain)));
    if (!profile) continue;
    const prev = traffic.get(profile.name) ?? { count: 0, lastSeen: null, lastLine: null, lastStatus: null, lastStatusAt: null };
    traffic.set(profile.name, { ...prev, count: prev.count + 1, lastSeen: event.timestamp, lastLine: line });
  }

  return traffic;
}

export function resolveVprToolRoute(
  routes: Record<string, VprToolRoute>,
  profileName: string,
  defaults: VprToolRoute,
): VprToolRoute {
  const override = routes[profileName];
  return {
    peerId: override?.peerId || defaults.peerId,
    model: override?.model || defaults.model,
  };
}

/** The serviceId `peerId` advertises for the selected model, so routes never send the catalog id to a peer that names it differently. */
export function peerServiceIdForModel(modelRoutes: DiscoverRow[], peerId: string): string | null {
  const peerRoutes = modelRoutes.filter((route) => route.peerId === peerId);
  const route = peerRoutes.find((candidate) => !CODING_ONLY_SUFFIX_RE.test(candidate.serviceId)) ?? peerRoutes[0];
  return route?.serviceId ?? null;
}

export function resolveVprToolRouteForPeerOptions(
  routes: Record<string, VprToolRoute>,
  profileName: string,
  defaults: VprToolRoute,
  peerOptions: VprPeerOption[],
): VprToolRoute {
  const override = routes[profileName];
  const peerId = override?.peerId || defaults.peerId;
  const services = peerOptions.find((peer) => peer.peerId === peerId)?.services ?? [];
  const model = override?.model || (!override ? defaults.model : '');

  if (!model || (services.length > 0 && !services.includes(model))) {
    return { peerId, model: services[0] ?? '' };
  }
  return { peerId, model };
}
