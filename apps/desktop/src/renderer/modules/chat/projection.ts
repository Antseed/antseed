import type {
  ChatServiceOptionEntry,
  DiscoverRow,
  VprRouteSelection,
  VprRoutingPreferences,
} from '../../core/state';
import { sameCanonicalModel } from '../catalog/model-identity.js';
import { chooseBestVprRoute } from '../routing/select.js';
import { routesForSelectedModel } from '../catalog/view-models.js';

export function findChatOptionForVprSelection(
  options: ChatServiceOptionEntry[],
  selection: VprRouteSelection,
): ChatServiceOptionEntry | null {
  const model = selection.model;
  if (!model) return null;
  const peerMatches = (option: ChatServiceOptionEntry): boolean => (
    selection.mode !== 'pinned-peer' ||
    !selection.peerId ||
    option.peerId === selection.peerId
  );
  // Exact provider+serviceId first; then any canonical variant of the model
  // (entries aggregate near-identical serviceIds across providers). The
  // matched option carries its own advertised serviceId, which is what
  // dispatch must send to its peer.
  return options.find((option) => (
    option.provider === model.provider && option.id === model.serviceId && peerMatches(option)
  )) ?? options.find((option) => (
    sameCanonicalModel(option.id, model.serviceId) && peerMatches(option)
  )) ?? null;
}

/**
 * Resolve the chat option an AI VPN selection should dispatch to. Pinned mode
 * requires the exact peer (a missing pin returns null so callers can fall
 * back to the user's explicit chat selection). Auto mode picks the peer via
 * the routing-preferences scorer instead of whichever option sorts first, so
 * preferences apply to real dispatch — not just the "best route" labels.
 */
export type ResolveVprChatOptions = {
  /**
   * Peers to skip, used when failing a conversation over from a peer that just
   * stopped responding. Ignored entirely in pinned mode.
   */
  excludePeerIds?: string[];
  now?: number;
};

export function resolveVprChatOption(
  options: ChatServiceOptionEntry[],
  rows: DiscoverRow[],
  selection: VprRouteSelection,
  preferences: VprRoutingPreferences,
  opts?: ResolveVprChatOptions,
): ChatServiceOptionEntry | null {
  if (!selection.model) return null;
  // Pinned mode returns before any health or exclusion logic: the user chose
  // this peer, and failover must never quietly move them off it.
  if (selection.mode === 'pinned-peer' && selection.peerId) {
    return findChatOptionForVprSelection(options, selection);
  }

  const candidates = routesForSelectedModel(rows, selection.model);
  const excluded = new Set(opts?.excludePeerIds ?? []);
  const filtered = excluded.size > 0
    ? candidates.filter((row) => !excluded.has(row.peerId))
    : candidates;
  // Excluding everything must not strand the send — better to retry the peer
  // that just failed than to refuse to dispatch at all.
  const usable = filtered.length > 0 ? filtered : candidates;

  // The option is looked up by the chosen ROW's provider/serviceId (not the
  // selection's): the entry may aggregate serviceId variants, and the request
  // must carry the id the routed peer actually advertises.
  const bestRoute = chooseBestVprRoute(usable, preferences, opts?.now ?? Date.now());
  if (bestRoute) {
    const bestOption = options.find((option) => (
      option.provider === bestRoute.provider &&
      option.id === bestRoute.serviceId &&
      option.peerId === bestRoute.peerId
    )) ?? options.find((option) => (
      option.id === bestRoute.serviceId &&
      option.peerId === bestRoute.peerId
    ));
    if (bestOption) return bestOption;
  }

  return candidates.length === 0
    ? findChatOptionForVprSelection(options, selection)
    : null;
}
