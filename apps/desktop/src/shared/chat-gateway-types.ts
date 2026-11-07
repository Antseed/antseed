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
  contextWindow?: number;
  /** Sellers offering it, as the gateway lists them (before routing policy). */
  sellers: number;
  /** Some seller serves it for $0 to everyone (not only to stakers). */
  free: boolean;
  /** Some seller's free tier is for its stakers only. */
  freeForStakers: boolean;
  /** Some seller runs it in a verified TEE. */
  tee: boolean;
  toolUse: boolean;
  reasoning: boolean;
  /** Cheapest advertised prices across sellers, USD per million tokens; null when none advertised. */
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
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
