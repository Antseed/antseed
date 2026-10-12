import type { DiscoverRow } from '../../core/state';
import { sameCanonicalModel } from '../catalog/model-identity';
import type { BuyerConversationSummary } from '../../types/bridge';
import { shortPeerId } from './tools';

/**
 * Shared helpers for buyer conversation rows (per-chat routing) — the same
 * list renders on the Home page, the Apps page, and the floating pill.
 */

/** How long after a chat's last request its row keeps the green pulse. The
    buyer stamps lastActiveAt per dispatched request, so this must outlast
    the gap between an agent tool's consecutive calls (and the 3s payload
    cadence) or the pulse would flicker mid-conversation. */
export const CONVERSATION_ACTIVE_HOLD_MS = 10_000;

/** Display name: user label, else prompt snippet, else the session key. */
export function conversationTitle(record: BuyerConversationSummary): string {
  return record.label || record.snippet || record.sessionKey.slice(0, 12);
}

/** Service id of the pinned model, or null when following the default route. */
export function conversationPinnedServiceId(record: BuyerConversationSummary): string | null {
  const model = record.pinnedModel?.trim() ?? '';
  if (!model) return null;
  const at = model.indexOf('@');
  return at > 0 ? model.slice(at + 1) || null : model;
}

/** Service id of the route the chat's latest request went to (set as soon as a
    seller is chosen), falling back to the pin. */
export function conversationRoutedServiceId(record: BuyerConversationSummary): string | null {
  const model = (record.lastModel || record.pinnedModel)?.trim() ?? '';
  if (!model) return null;
  const at = model.indexOf('@');
  return at > 0 ? model.slice(at + 1) || null : model;
}

/** Catalog label for a seller's service id, matching seller spellings like
    `opus-5.5` to the canonical catalog entry. */
export function catalogModelLabel(catalog: ReadonlyArray<{ serviceId: string; label: string }>, serviceId: string): string {
  const entry = catalog.find((candidate) => candidate.serviceId === serviceId)
    ?? catalog.find((candidate) => sameCanonicalModel(candidate.serviceId, serviceId));
  return entry?.label ?? serviceId;
}

/** Peer id of the chat's pinned route, or null while unpinned. */
export function conversationPinnedPeerId(record: BuyerConversationSummary): string | null {
  const model = record.pinnedModel?.trim() ?? '';
  const at = model.indexOf('@');
  return at > 0 ? model.slice(0, at).toLowerCase() || null : null;
}

/** Peer id of the seller that served the chat's most recent request — ground
    truth of where requests actually went, which can diverge from the pin when
    routing misbehaves. Falls back to the pinned route for chats whose buyer
    predates `lastModel`. Both fields are `<peerId>@<service>` strings. */
export function conversationRoutedPeerId(record: BuyerConversationSummary): string | null {
  const model = record.lastModel || record.pinnedModel;
  if (!model) return null;
  const at = model.indexOf('@');
  return at > 0 ? model.slice(0, at).toLowerCase() || null : null;
}

/**
 * Display name of the seller that served the chat's last request — resolved
 * against the full discover list, not the preference-filtered routable rows:
 * a request landing on an excluded peer is exactly what the "Show routed
 * peer" debug preference exists to reveal. Falls back to a short peer id for
 * peers missing from discovery (offline).
 */
export function conversationRoutedPeerName(
  record: BuyerConversationSummary,
  rows: DiscoverRow[],
): string | null {
  const peerId = conversationRoutedPeerId(record);
  if (!peerId) return null;
  const row = rows.find((candidate) => candidate.peerId.toLowerCase() === peerId);
  return row?.peerDisplayName?.trim() || row?.peerLabel?.trim() || shortPeerId(peerId);
}

/** Slugs are single tokens ('codex', 'opencode') while the wire-derived
    tool slug may carry a variant suffix ('codex-exec', 'codex-cli-rs'), so
    either side may extend the other by a `-` segment. */
function toolMatchesSlug(tool: string, slug: string): boolean {
  if (!slug) return false;
  if (tool === slug) return true;
  return tool.startsWith(`${slug}-`) || slug.startsWith(`${tool}-`);
}

/**
 * True when a conversation's tool slug belongs to the given app profile.
 * The profile's configurable client names (`toolSlugs` — the User-Agent
 * product / session-header identity each request carries) are the source of
 * truth; the profile name itself remains a fallback match.
 */
export function conversationMatchesApp(
  tool: string,
  profile: { name: string; toolSlugs?: string[] },
): boolean {
  if (profile.toolSlugs?.some((slug) => toolMatchesSlug(tool, slug))) return true;
  return toolMatchesSlug(tool, profile.name);
}

/** True while the chat reads as receiving traffic (drives the green pulse). */
export function isConversationActive(lastActiveAt: number): boolean {
  return Date.now() - lastActiveAt < CONVERSATION_ACTIVE_HOLD_MS;
}

/** Compact session identifier for meta lines ("019f83b7"): common tool
    prefixes like `ses_` are stripped so the distinctive part shows. */
export function shortSessionId(sessionKey: string): string {
  return sessionKey.replace(/^[a-z]+_/i, '').slice(0, 8);
}

/**
 * What a chat has cost so far, as a meta-line fragment ("$0.42", "<$0.01").
 * Null when nothing has been attributed yet — free routes, chats from before
 * spend tracking shipped, or a first request still in flight — so callers can
 * drop the segment instead of printing a misleading "$0.00".
 */
export function conversationCost(record: BuyerConversationSummary): string | null {
  let baseUnits: bigint;
  try {
    baseUnits = BigInt(record.spentUsdc ?? '0');
  } catch {
    return null;
  }
  if (baseUnits <= 0n) return null;
  // USDC has 6 decimals; anything under a cent rounds to $0.00, which reads
  // as free rather than cheap.
  if (baseUnits < 10_000n) return '<$0.01';
  const cents = baseUnits / 10_000n;
  return `$${(cents / 100n).toString()}.${(cents % 100n).toString().padStart(2, '0')}`;
}

/** Compact relative timestamp for chat rows ("now", "5m", "2h", "3d"). */
export function conversationAge(timestamp: number): string {
  const delta = Date.now() - timestamp;
  if (delta < 60_000) return 'now';
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)}m`;
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)}h`;
  return `${Math.floor(delta / 86_400_000)}d`;
}
