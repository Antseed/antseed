import { createHash } from 'node:crypto';

/**
 * Remembers which buyer address first sent each substantial message of a free
 * conversation, so a conversation carried on under another address can be
 * recognized. New addresses cost nothing to make: a client that runs out of
 * free requests can resend the same history from a fresh one. Messages from
 * the start of a conversation are skipped, since the system prompts and
 * openings of a shared agent or app are the same for all of its users.
 */

/** Messages shorter than this, in characters of their JSON, are not tracked. */
export const MIN_TRACKED_MESSAGE_CHARS = 1_024;
/** Leading messages of a conversation that are never tracked. */
export const SKIPPED_LEADING_MESSAGES = 3;
/** A request carries on another buyer's conversation when at least this many of its messages are theirs... */
export const MOVED_MIN_MESSAGES = 5;
/** ...adding up to at least this many estimated tokens. */
export const MOVED_MIN_TOKENS = 32_000;
/** How long a message stays attributed to the buyer that first sent it. */
export const MESSAGE_OWNER_TTL_MS = 48 * 60 * 60_000;
/** Most messages remembered; the oldest are forgotten first. */
export const MAX_TRACKED_MESSAGES = 1_000_000;

const CHARS_PER_TOKEN = 4;

export interface ConversationFingerprint {
  messages: Array<{ digest: string; chars: number }>;
}

export interface MovedConversation {
  /** Lowercase address of the buyer that first sent the matched messages. */
  owner: string;
  messages: number;
  tokens: number;
}

/**
 * The trackable messages of a chat request body (OpenAI chat `messages`,
 * Anthropic `messages`, or OpenAI Responses `input`), or null when it has none.
 */
export function fingerprintConversation(body: unknown): ConversationFingerprint | null {
  if (!body || typeof body !== 'object') return null;
  const record = body as Record<string, unknown>;
  const items = Array.isArray(record['messages'])
    ? record['messages'] as unknown[]
    : Array.isArray(record['input']) ? record['input'] as unknown[] : null;
  if (!items) return null;
  const conversation = items.filter((item) => {
    const role = item && typeof item === 'object' ? (item as Record<string, unknown>)['role'] : undefined;
    return role !== 'system' && role !== 'developer';
  });
  const messages: ConversationFingerprint['messages'] = [];
  // A message repeated within one request counts once, so repeats can't add up to a match.
  const seen = new Set<string>();
  for (const item of conversation.slice(SKIPPED_LEADING_MESSAGES)) {
    const text = canonicalJson(item);
    if (text === undefined || text.length < MIN_TRACKED_MESSAGE_CHARS) continue;
    const digest = createHash('sha256').update(text).digest('base64').slice(0, 22);
    if (seen.has(digest)) continue;
    seen.add(digest);
    messages.push({ digest, chars: text.length });
  }
  return messages.length > 0 ? { messages } : null;
}

/** JSON with object keys sorted at every level, so the same message serialized another way hashes the same. */
function canonicalJson(value: unknown): string | undefined {
  return JSON.stringify(value, (_key, nested: unknown) => {
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) return nested;
    const record = nested as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
  });
}

export class FreeTierConversationTracker {
  /** Message digest → first sender and when it was last seen, oldest first. */
  private readonly _owners = new Map<string, { owner: string; seenAt: number }>();

  constructor(
    private readonly _maxMessages = MAX_TRACKED_MESSAGES,
    private readonly _ttlMs = MESSAGE_OWNER_TTL_MS,
  ) {}

  get size(): number {
    return this._owners.size;
  }

  /**
   * The other buyer whose conversation `fingerprint` carries on, or null. A
   * match needs `MOVED_MIN_MESSAGES` messages from that one buyer adding up to
   * `MOVED_MIN_TOKENS`, so a few shared snippets never count.
   */
  findMovedConversation(
    buyerAddress: string,
    fingerprint: ConversationFingerprint,
    nowMs = Date.now(),
  ): MovedConversation | null {
    const buyer = buyerAddress.toLowerCase();
    const byOwner = new Map<string, { messages: number; chars: number }>();
    for (const message of fingerprint.messages) {
      const entry = this._owners.get(message.digest);
      if (!entry || entry.owner === buyer || nowMs - entry.seenAt > this._ttlMs) continue;
      const totals = byOwner.get(entry.owner) ?? { messages: 0, chars: 0 };
      totals.messages += 1;
      totals.chars += message.chars;
      byOwner.set(entry.owner, totals);
    }
    let best: MovedConversation | null = null;
    for (const [owner, totals] of byOwner) {
      const tokens = Math.round(totals.chars / CHARS_PER_TOKEN);
      if (totals.messages < MOVED_MIN_MESSAGES || tokens < MOVED_MIN_TOKENS) continue;
      if (!best || tokens > best.tokens) best = { owner, messages: totals.messages, tokens };
    }
    return best;
  }

  /**
   * Attribute `fingerprint`'s messages to `buyerAddress` where no one else
   * holds them. Record only served requests: a refused request must not make
   * a stolen conversation look shared.
   */
  record(buyerAddress: string, fingerprint: ConversationFingerprint, nowMs = Date.now()): void {
    const buyer = buyerAddress.toLowerCase();
    for (const message of fingerprint.messages) {
      const entry = this._owners.get(message.digest);
      const owner = entry && entry.owner !== buyer && nowMs - entry.seenAt <= this._ttlMs ? entry.owner : buyer;
      // Re-inserting keeps the map ordered by last use, so eviction drops the stalest.
      this._owners.delete(message.digest);
      this._owners.set(message.digest, { owner, seenAt: nowMs });
    }
    this._evict(nowMs);
  }

  private _evict(nowMs: number): void {
    for (const [digest, entry] of this._owners) {
      if (this._owners.size <= this._maxMessages && nowMs - entry.seenAt <= this._ttlMs) break;
      this._owners.delete(digest);
    }
  }
}
