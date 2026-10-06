import { validateRoutingRankRequest } from '@antseed/node';

export const GESUNDAI_TARGET = Object.freeze({
  peerId: '983e9de990b9ac8d36d373db5d0b49a4d7f7d826',
  provider: 'openai-responses',
  serviceId: 'gpt-6-astra',
});

export function findGesundaiOffer(catalog) {
  return (catalog.data ?? []).flatMap((model) => model.peers ?? []).find((peer) => (
    peer.peerId === GESUNDAI_TARGET.peerId && peer.provider === GESUNDAI_TARGET.provider
    && peer.serviceId === GESUNDAI_TARGET.serviceId
  ));
}

export class GesundaiDevRouter {
  name = 'fake-levanto';
  services = ['levanto-route'];
  pricing = { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } };
  maxConcurrency = 10;
  serviceApiProtocols = { 'levanto-route': ['model-routing'] };
  serviceUnitBillingModels = { 'levanto-route': { 'model-routing': {
    version: 1, components: [{ unit: 'completed_requests', priceUsd: 0 }],
  } } };

  constructor(loadOffer) { this.loadOffer = loadOffer; }
  getCapacity() { return { current: 0, max: this.maxConcurrency }; }

  async handleRequest(request) {
    const response = (statusCode, body) => ({ requestId: request.requestId, statusCode,
      headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(body)) });
    if (request.headers['x-antseed-service'] !== 'levanto-route') return response(404, { detail: 'Unknown routing service' });
    if (request.method === 'GET' && request.path === '/v1/routing/models') {
      return response(200, { object: 'list', data: [{ id: GESUNDAI_TARGET.serviceId, object: 'model' }] });
    }
    if (request.method !== 'POST' || request.path !== '/v1/routing/rank') return response(404, { detail: 'Unknown endpoint' });
    let input;
    try {
      input = JSON.parse(Buffer.from(request.body).toString());
      validateRoutingRankRequest(input);
    } catch {
      return response(400, { detail: 'Invalid IRP rank request' });
    }
    const candidate = input.routing.candidates.find(entry => entry.model === GESUNDAI_TARGET.serviceId
      && entry.id === GESUNDAI_TARGET.provider + ':' + GESUNDAI_TARGET.serviceId + '@' + GESUNDAI_TARGET.peerId);
    if (!candidate) return response(422, { detail: 'No eligible GesundAI candidate' });
    try {
      const offer = await this.loadOffer();
      if (!offer || offer.peerId !== GESUNDAI_TARGET.peerId || offer.provider !== GESUNDAI_TARGET.provider || offer.serviceId !== GESUNDAI_TARGET.serviceId) {
        throw new Error('GesundAI GPT 6 Astra is not available in the buyer catalog');
      }
      const price = { inUsdPerM: offer.inputUsdPerMillion, outUsdPerM: offer.outputUsdPerMillion,
        cachedInUsdPerM: offer.cachedInputUsdPerMillion ?? offer.inputUsdPerMillion };
      if (!Object.values(price).every((value) => Number.isFinite(value) && value >= 0)) throw new Error('GesundAI pricing is unavailable');
      return response(200, { id: request.requestId, object: 'routing.ranking', created: Math.floor(Date.now() / 1000),
        router: { id: 'fake-levanto-gesundai', version: '1' }, ranked: [{ candidate_id: candidate.id }] });
    } catch (error) {
      return response(503, { detail: error instanceof Error ? error.message : 'GesundAI offer lookup failed' });
    }
  }
}
