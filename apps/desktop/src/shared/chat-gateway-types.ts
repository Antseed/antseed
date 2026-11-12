/** Plain data the chat IPC carries between the main process, preload and renderer. Types only. */
export type ChatServiceProtocol = 'anthropic-messages' | 'openai-responses' | 'openai-chat-completions';

export type ChatModel = {
  id: string;
  label: string;
  /** `text`, `image`, `video`, `speech`, … as the gateway reports it; `text` for untyped entries. */
  type: string;
  /** Chat protocol for text models; null for models the chat cannot talk to (image, video, …). */
  protocol: ChatServiceProtocol | null;
  /** Accepts image input: vision for text models, image edits for image models. */
  supportsImages: boolean;
  /** Sellers that take image input, for a chat pinned to one when not all of them do. */
  imageInputSellerIds?: string[];
  contextWindow?: number;
  /** Sellers offering it, as the gateway lists them (before routing policy). */
  sellers: number;
  /** Some seller serves it for $0 to everyone (not only to stakers). */
  free: boolean;
  /** Cheapest price per image for an image model; null otherwise. */
  minImageUsd: number | null;
  /** A seller serving it for $0 to everyone, for a user who can't pay any other. */
  freeSellerId: string | null;
  /** Some seller's free tier is for its stakers only. */
  freeForStakers: boolean;
  /** Sellers (lowercase, no 0x) whose $0 offer is for their stakers only: not free to anyone else. */
  stakersOnlyFreeSellerIds?: string[];
  /** Some seller runs it in a verified TEE. */
  tee: boolean;
  /** Some seller runs it sealed end to end: the seller and its model provider are both in a verified TEE. */
  teeEndToEnd?: boolean;
  toolUse: boolean;
  /** Some seller declares reasoning. */
  reasoning: boolean;
  /** Every seller the gateway may pick declares reasoning (the buyer's guaranteed capability), so the chat may ask it to think. */
  reasoningEverySeller?: boolean;
  /** Sellers (lowercase, no 0x) that declare reasoning, for a chat pinned to one when not all of them do. */
  reasoningSellerIds?: string[];
  /**
   * Cheapest advertised prices across sellers, USD per million tokens; null when none advertised.
   * A stakers-only $0 offer counts only when no other seller has one.
   */
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  /**
   * No trusted seller serves it, as the connected apps judge it, while other
   * models have one. Pickers list it only while it is the model in use, and
   * defaults pick it last.
   */
  lowTrust?: boolean;
};

/** A seller for one model under the key's routing policy, as the gateway's route preview reports it. */
export type ChatRouteCandidate = {
  peerId: string;
  name: string | null;
  /** Auto-routing order among eligible sellers (1 = first choice); null when ineligible. */
  rank: number | null;
  /** Allowed by the routing policy; an ineligible seller cannot be pinned either. */
  eligible: boolean;
  /** Why it was excluded, or how it scored ("free", "success ~98%", …). */
  reasons: string[];
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  /** Cache reads; a seller charging only for these is not free. Null when not priced (or an older gateway). */
  cachedInputUsdPerMillion: number | null;
  trustScore: number | null;
  successRate: number | null;
  firstTokenMs: number | null;
  tokensPerSecond: number | null;
  failing: boolean;
};

export type ChatRoutePreview = {
  model: string;
  /** The key's policy allows this model at all. */
  modelAllowed: boolean;
  /** How Auto orders eligible sellers (balanced, price, …). */
  sort: string | null;
  candidates: ChatRouteCandidate[];
};

/** A pin/archive change for a chat; a field left out stays as it is. */
export type ConversationFlags = {
  pinned?: boolean;
  archived?: boolean;
};

/**
 * What a chat request needs from the privacy mode. `requirePrivate`: it must go
 * out in Private (the renderer's own judgment). `allowPrivateHistory`: the user
 * chose to carry this chat's Private history into Anonymous ("Keep this chat").
 */
export type OutgoingPrivacy = {
  requirePrivate?: boolean;
  allowPrivateHistory?: boolean;
  /**
   * The renderer's id for this send. The run's terminal stream events (done,
   * error) carry it back, so a late event from a stopped send can't end a
   * newer one in the same chat.
   */
  sendId?: number;
};
