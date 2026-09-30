import { randomUUID } from 'node:crypto';
import type { PeerInfo, RouteRecommendation, RouteSelectionContext, ModelRouterAdapter, RoutingUsageObservation, SerializedHttpRequest } from '@antseed/node';
import { completedRequestPrice, resolveServiceBillingOffer, canonicalRoutingJson, createRoutingServiceMetadata } from '@antseed/node';
import { LEVANTO_ROUTING_PATH, validateRoutingRequest, validateRoutingResponse } from './validation.js';
import { CacheObservations } from './cache-observations.js';

type CachedRoute = { text: string; fingerprint: string; routes: RouteRecommendation[] };

export const levantoRoutingMetadata = createRoutingServiceMetadata({
  type: 'object', additionalProperties: false,
  properties: {},
});

export class LevantoRoutingAdapter implements ModelRouterAdapter {
  readonly routingMetadata = structuredClone(levantoRoutingMetadata);
  private readonly conversations = new Map<string, CachedRoute>();
  readonly observations = new CacheObservations();

  recordUsage(observation: RoutingUsageObservation): void {
    this.observations.record(observation);
  }

  async selectRoute(request: SerializedHttpRequest, peers: PeerInfo[], context: RouteSelectionContext): Promise<RouteRecommendation[] | null> {
    const body = JSON.parse(new TextDecoder().decode(request.body)) as Record<string, unknown>;
    if (body.model !== 'levanto-auto' && body.model !== 'antseed') return null;
    context.signal.throwIfAborted();
    const target = context.routingService;
    if (!target) throw new Error('Select a Levanto routing-service peer');
    const catalog = context.catalog;
    const preferences = context.preferences ?? {};
    const eligible = context.candidates.filter(candidate => !catalog || catalog.models.some(model =>
      model.provider === candidate.provider && model.serviceId === candidate.serviceId));
    const allowedCandidates = [...new Map(eligible.map(({ peerId, provider, serviceId }) =>
      [JSON.stringify([peerId, provider, serviceId]), { peerId, provider, serviceId }])).values()];
    const fingerprint = canonicalRoutingJson({ target, preferences, schema: context.preferencesSchemaHash ?? null,
      catalogRevision: catalog?.revision ?? null, allowedCandidates });
    const messages = Array.isArray(body.messages) ? body.messages : Array.isArray(body.input) ? body.input : [];
    const latestUser = [...messages].reverse().find(message => message && message.role === 'user');
    const content: unknown = latestUser?.content ?? (typeof body.input === 'string' ? body.input : undefined);
    const text = typeof content === 'string' ? content : Array.isArray(content)
      ? content.map(block => typeof block?.text === 'string' ? block.text : '').join('\n') : '';
    if (!text.trim()) throw new Error('Levanto routing requires user text in messages or Responses input');
    if (!eligible.length) throw new Error('No eligible inference candidates supported by this router');
    const cached = context.conversationKey ? this.conversations.get(context.conversationKey) : undefined;
    if (cached?.text === text && cached.fingerprint === fingerprint && context.acceptRecommendations(cached.routes)) return structuredClone(cached.routes);
    if (context.conversationKey) this.conversations.delete(context.conversationKey);

    const routingPeer = peers.find(peer => peer.peerId === target.peerId);
    let offer;
    try {
      offer = routingPeer?.metadata && resolveServiceBillingOffer(routingPeer.metadata.providers, target.provider, target.serviceId);
    } catch {}
    if (!routingPeer || offer?.serviceApiProtocol !== 'levanto-routing') throw new Error('No compatible Levanto completed-request service');
    const inputMessage = text.length > 8192 ? text.slice(0, 4096) + text.slice(-4096) : text;
    const promptTokens = Math.ceil(text.length / 4);
    const payload = {
      v: 1, preferences, inputMessage, promptTokens,
      ...(catalog ? { catalogRevision: catalog.revision } : {}),
      expectedCachedTokens: this.observations.estimates(context.conversationKey, eligible, promptTokens),
      constraints: { allowedPeerIds: [...new Set(eligible.map(candidate => candidate.peerId))],
        allowedCandidates },
    };
    validateRoutingRequest(payload);
    let recommendations: RouteRecommendation[] | undefined;
    const response = await context.sendRequest(routingPeer, {
      requestId: randomUUID(), method: 'POST', path: LEVANTO_ROUTING_PATH,
      headers: {
        'content-type': 'application/json',
      },
      body: new TextEncoder().encode(JSON.stringify({ ...payload, service: offer.service })),
    }, {
      signal: context.signal, unitBilling: offer, maxFeeMicroUsdc: completedRequestPrice(offer.unitModel).toString(),
      acceptResponse: response => {
        const parsed: unknown = JSON.parse(new TextDecoder().decode(response.body));
        const ranked = validateRoutingResponse(parsed, payload);
        const routes = ranked.filter(entry => eligible.some(candidate => candidate.peerId === entry.peer && candidate.serviceId === entry.model
          && entry.provider === candidate.provider))
          .map(entry => ({ serviceId: entry.model, peerId: entry.peer, provider: entry.provider }));
        if (!routes.length) return false;
        if (!context.acceptRecommendations(routes)) return false;
        recommendations = routes;
        return true;
      },
    });
    context.signal.throwIfAborted();
    if (response.statusCode === 409) throw new Error('Router model catalog changed. Retry to use the latest catalog.');
    if (response.statusCode === 422) throw new Error('Router cannot rank any allowed candidate. Update the allowed models or choose another router.');
    if (response.statusCode === 402) throw new Error('Routing payment could not be completed. The channel may have unpaid or disputed work. Select a model or another router; no unaccepted response will be authorized.');
    if (response.statusCode < 200 || response.statusCode >= 300 || !recommendations) throw new Error(`Levanto routing failed (${response.statusCode})`);
    if (context.conversationKey) {
      this.conversations.set(context.conversationKey, { text, fingerprint, routes: structuredClone(recommendations) });
      if (this.conversations.size > 500) this.conversations.delete(this.conversations.keys().next().value!);
    }
    return recommendations;
  }
}
