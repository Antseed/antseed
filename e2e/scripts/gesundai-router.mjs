import { validateRoutingRequest } from '../../plugins/router-levanto/dist/validation.js';
import { createServer } from 'node:http';
import { resolveRoutingPreferences } from '@antseed/node';

export const GESUNDAI_PREFERENCES_SCHEMA = {
  type: 'object', additionalProperties: false,
  properties: { cqt: { type: 'string', enum: ['1', '3', '5', '7', '9'], default: '5', title: 'Cost quality', description: 'Set your preferred balance between cost and response quality.' } },
};

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
  serviceApiProtocols = { 'levanto-route': ['levanto-routing'] };
  routingCatalog = {
    version: 1, revision: 'gesundai-1', title: 'Auto Router',
    models: [{ provider: GESUNDAI_TARGET.provider, serviceId: GESUNDAI_TARGET.serviceId }],
    preferencesSchema: GESUNDAI_PREFERENCES_SCHEMA,
  };
  serviceUnitBillingModels = { 'levanto-route': { 'levanto-routing': {
    version: 1, components: [{ unit: 'completed_requests', priceUsd: 0 }],
  } } };

  constructor(loadOffer) { this.loadOffer = loadOffer; }
  getCapacity() { return { current: 0, max: this.maxConcurrency }; }

  async handleRequest(request) {
    const response = (statusCode, body) => ({ requestId: request.requestId, statusCode,
      headers: { 'content-type': 'application/json' }, body: Buffer.from(JSON.stringify(body)) });
    if (request.method !== 'POST' || request.path !== '/_antseed/levanto-route') {
      return response(404, { error: 'Use POST /_antseed/levanto-route' });
    }
    let input;
    try {
      input = JSON.parse(Buffer.from(request.body).toString());
      validateRoutingRequest(input);
      resolveRoutingPreferences(this.routingCatalog.preferencesSchema, input.preferences);
      if (input.service !== 'levanto-route') throw new Error('Unknown routing service');
    } catch {
      return response(400, { error: 'Invalid Levanto routing request' });
    }
    const { allowedPeerIds, blockedPeerIds, maxInputUsdPerMillion, minTrustScore } = input.constraints;
    if (input.catalogRevision !== undefined && input.catalogRevision !== this.routingCatalog.revision) return response(409, { error: 'catalog_changed' });
    if (!input.constraints.allowedCandidates.some(candidate =>
      candidate.peerId === GESUNDAI_TARGET.peerId && candidate.provider === GESUNDAI_TARGET.provider && candidate.serviceId === GESUNDAI_TARGET.serviceId)) {
      return response(422, { error: 'no_allowed_candidates' });
    }
    if ((Array.isArray(allowedPeerIds) && !allowedPeerIds.includes(GESUNDAI_TARGET.peerId))
      || blockedPeerIds?.includes(GESUNDAI_TARGET.peerId)) {
      return response(503, { error: 'GesundAI GPT 6 Astra is not eligible for this request; no alternative will be recommended' });
    }
    try {
      const offer = await this.loadOffer();
      if (!offer || offer.peerId !== GESUNDAI_TARGET.peerId || offer.provider !== GESUNDAI_TARGET.provider || offer.serviceId !== GESUNDAI_TARGET.serviceId) {
        throw new Error('GesundAI GPT 6 Astra is not available in the buyer catalog');
      }
      const price = { inUsdPerM: offer.inputUsdPerMillion, outUsdPerM: offer.outputUsdPerMillion,
        cachedInUsdPerM: offer.cachedInputUsdPerMillion ?? offer.inputUsdPerMillion };
      if (!Object.values(price).every((value) => Number.isFinite(value) && value >= 0)) throw new Error('GesundAI pricing is unavailable');
      if (maxInputUsdPerMillion !== undefined && price.inUsdPerM > maxInputUsdPerMillion) throw new Error('GesundAI exceeds the requested price limit');
      if (minTrustScore !== undefined && (offer.effectiveReputationScore ?? 0) < minTrustScore) throw new Error('GesundAI does not meet the requested trust limit');
      const outputTokens = 256;
      return response(200, { v: 1, ...(input.catalogRevision !== undefined ? { catalogRevision: input.catalogRevision } : {}), router: 'fake-levanto-gesundai', ranked: [{
        model: GESUNDAI_TARGET.serviceId, peer: GESUNDAI_TARGET.peerId, price,
        provider: GESUNDAI_TARGET.provider,
        estimate: { inputTokens: input.promptTokens, cachedInputTokens: 0, outputTokens,
          costUsd: (input.promptTokens * price.inUsdPerM + outputTokens * price.outUsdPerM) / 1_000_000 },
      }] });
    } catch (error) {
      return response(503, { error: error instanceof Error ? error.message : 'GesundAI offer lookup failed' });
    }
  }
}

/** Serve a router catalog the way a router's own HTTP API does: GET /_antseed/route/catalog. */
export async function startRoutingCatalogServer(port, getCatalog, host = '127.0.0.1') {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    const catalog = request.method === 'GET' && url.pathname === '/_antseed/route/catalog'
      ? getCatalog(url.searchParams.get('provider'), url.searchParams.get('service')) : undefined;
    response.statusCode = catalog ? 200 : 404;
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(catalog ?? { error: 'not_found' }));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, () => resolve(undefined));
  });
  return { url: `http://${host}:${server.address().port}`, close: () => new Promise((resolve) => server.close(() => resolve(undefined))) };
}
