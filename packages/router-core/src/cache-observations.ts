import type { RouteCandidate, RoutingUsageObservation } from '@antseed/node';

type Observation = { ratio: number; inputTokens: number; at: number };
type Conversation = { offers: Map<string, Observation>; requests: Set<string> };

/** Per-conversation prompt-cache reuse observed from completed inference responses. */
export class CacheObservations {
  private readonly conversations = new Map<string, Conversation>();

  constructor(private readonly now: () => number = Date.now) {}

  record(observation: RoutingUsageObservation): void {
    const { conversationKey, requestId, peerId, provider, serviceId, inputTokens, cachedInputTokens } = observation;
    if (!conversationKey || !requestId || !Number.isSafeInteger(inputTokens) || inputTokens <= 0
      || !Number.isSafeInteger(cachedInputTokens) || cachedInputTokens < 0 || cachedInputTokens > inputTokens) return;
    const conversation = this.conversations.get(conversationKey) ?? { offers: new Map(), requests: new Set() };
    const requestKey = JSON.stringify([requestId, peerId, provider, serviceId]);
    if (conversation.requests.has(requestKey)) return;
    conversation.requests.add(requestKey);
    if (conversation.requests.size > 512) conversation.requests.delete(conversation.requests.values().next().value!);
    const key = JSON.stringify([peerId, provider, serviceId]);
    const previous = conversation.offers.get(key);
    const ratio = cachedInputTokens / inputTokens;
    conversation.offers.delete(key);
    conversation.offers.set(key, { ratio: previous ? previous.ratio * 0.5 + ratio * 0.5 : ratio, inputTokens, at: this.now() });
    if (conversation.offers.size > 64) conversation.offers.delete(conversation.offers.keys().next().value!);
    this.conversations.delete(conversationKey);
    this.conversations.set(conversationKey, conversation);
    if (this.conversations.size > 500) this.conversations.delete(this.conversations.keys().next().value!);
  }

  /** Expected cached input tokens for one exact peer/provider/model in this conversation. */
  expectedCachedInputTokens(conversationKey: string | null, candidate: Pick<RouteCandidate, 'peerId' | 'provider' | 'serviceId'>, promptTokens: number): number {
    const conversation = conversationKey ? this.conversations.get(conversationKey) : undefined;
    const observation = conversation?.offers.get(JSON.stringify([candidate.peerId, candidate.provider, candidate.serviceId]));
    if (!observation || this.now() - observation.at > 3 * 60_000) return 0;
    return Math.max(0, Math.round(Math.min(observation.inputTokens * observation.ratio, promptTokens)));
  }
}
