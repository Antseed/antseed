/**
 * The seller an Auto chat expects to answer. The chat asks the gateway to
 * prefer it (`x-antseed-prefer-peer`, a soft preference the buyer honors only
 * among sellers the key's policy allows) and speaks its protocol, so the reply
 * normally needs no conversion between API standards: the seller that answered
 * the chat last, else Auto's first choice in the gateway's route preview.
 */
import type { AiChatMessage } from './conversation-types.js';
import type { ChatRoutePreview } from '../../shared/chat-gateway-types.js';

/** The header the buyer reads as a soft seller preference for one request. */
export const PREFER_PEER_HEADER = 'x-antseed-prefer-peer';

/** The seller that answered the chat's latest reply, if the reply recorded one. */
export function lastServingSeller(messages: readonly AiChatMessage[]): string | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!;
    if (message.role !== 'assistant') continue;
    const peerId = message.meta?.peerId?.trim();
    if (peerId) return peerId;
  }
  return null;
}

/** Auto's first choice in the gateway's route preview: the eligible seller ranked first. */
export function previewFirstSeller(preview: ChatRoutePreview): string | null {
  let first: { peerId: string; rank: number } | null = null;
  for (const candidate of preview.candidates) {
    if (!candidate.eligible || candidate.rank === null) continue;
    if (!first || candidate.rank < first.rank) first = { peerId: candidate.peerId, rank: candidate.rank };
  }
  return first?.peerId ?? null;
}
