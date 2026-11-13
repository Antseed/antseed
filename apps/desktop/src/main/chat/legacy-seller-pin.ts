/**
 * Sessions written before the gateway keep a chosen seller in an `antseed:peer`
 * entry beside the model; now the pin is part of the model id (`peer@model`).
 * Read here so an upgrade doesn't quietly send a pinned chat to another seller.
 */
import type { SessionManager } from '@mariozechner/pi-coding-agent';
import { joinPinnedModel } from '../../shared/pinned-model.js';
import { normalizeServiceId } from './normalize.js';

const LEGACY_PEER_ENTRY = 'antseed:peer';

type SessionEntries = Pick<SessionManager, 'getEntries'>;

function legacyPinnedPeer(session: SessionEntries): string | null {
  const entries = session.getEntries() as Array<{ type?: string; customType?: string; data?: unknown }>;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== 'custom' || entry.customType !== LEGACY_PEER_ENTRY) continue;
    const { peerId, routeMode } = (entry.data ?? {}) as { peerId?: unknown; routeMode?: unknown };
    return routeMode === 'pinned' && typeof peerId === 'string' && /^(0x)?[0-9a-f]{40}$/i.test(peerId) ? peerId : null;
  }
  return null;
}

/** The session's model id, with a pre-gateway seller pin applied. */
export function sessionServiceId(session: SessionEntries & Pick<SessionManager, 'buildSessionContext'>): string {
  const service = normalizeServiceId(session.buildSessionContext().model?.modelId);
  const peerId = service ? legacyPinnedPeer(session) : null;
  return peerId ? joinPinnedModel(service, peerId) : service;
}

/** A model chosen now replaces the old pin, so it mustn't come back. */
export function clearLegacySellerPin(session: SessionEntries & Pick<SessionManager, 'appendCustomEntry'>): void {
  if (legacyPinnedPeer(session)) session.appendCustomEntry(LEGACY_PEER_ENTRY, { peerId: '', routeMode: 'auto' });
}
