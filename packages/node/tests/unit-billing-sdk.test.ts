import { describe, expect, it, vi } from 'vitest';
import { AntseedNode } from '../src/node.js';
import type { PeerInfo } from '../src/types/peer.js';
import type { Provider } from '../src/interfaces/seller-provider.js';
import { completedRequestOffer, isLegacyInferenceService } from '../src/billing/service.js';

describe('unit billing through normal SDK requests', () => {
  const offer = { provider: 'summarizer', service: 'summary', serviceApiProtocol: 'typesafe-systemone' as const, unitModel: { version: 1 as const, components: [{ unit: 'completed_requests' as const, priceUsd: 0.001 }] } };
  function setup() {
    const agreed = structuredClone(offer);
    const peer = { peerId: 'a'.repeat(40), metadata: { version: 12, peerId: 'a'.repeat(40), providers: [{
      provider: offer.provider, services: [offer.service], defaultPricing: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 }, maxConcurrency: 1, currentLoad: 0,
      serviceApiProtocols: { [offer.service]: [offer.serviceApiProtocol] },
      serviceUnitBillingModels: { [offer.service]: { [offer.serviceApiProtocol]: { version: 1, components: [{ unit: 'completed_requests', priceUsd: offer.unitModel.components[0]!.priceUsd }] } } },
    }] } } as PeerInfo;
    const verifyMetadataSignature = vi.fn(async () => true);
    const sendRequest = vi.fn(async () => ({ statusCode: 200 }));
    const node = { _peerLookup: { verifyMetadataSignature }, _buyerHandler: { sendRequest } } as unknown as AntseedNode;
    const send = (maxFeeMicroUsdc = '1000') => AntseedNode.prototype.sendRequest.call(node, peer, {
      requestId: 'summary-1', method: 'POST', path: '/summary', headers: {}, body: new TextEncoder().encode('{}'),
    }, { unitBilling: agreed, maxFeeMicroUsdc, acceptResponse: () => true });
    return { peer, agreed, send, verifyMetadataSignature, sendRequest };
  }
  it('verifies the signed billing model and forwards its exact price without a capability flag', async () => {
    const harness = setup();
    await harness.send();
    expect(harness.verifyMetadataSignature).toHaveBeenCalledWith(harness.peer.metadata);
    expect(harness.sendRequest).toHaveBeenCalledWith(harness.peer, expect.objectContaining({
      path: '/summary', method: 'POST',
    }), undefined, expect.objectContaining({ unitBilling: offer }));
  });
  it('rejects invalid signature, identity mismatch, and excessive fee before dispatch', async () => {
    const expensive = setup();
    await expect(expensive.send('999')).rejects.toThrow('buyer limit');
    expect(expensive.sendRequest).not.toHaveBeenCalled();
    const unsigned = setup();
    unsigned.verifyMetadataSignature.mockResolvedValue(false);
    await expect(unsigned.send()).rejects.toThrow('Verified');
    expect(unsigned.sendRequest).not.toHaveBeenCalled();
    const mismatched = setup();
    mismatched.peer.metadata!.peerId = 'b'.repeat(40);
    await expect(mismatched.send()).rejects.toThrow('Verified');
    expect(mismatched.sendRequest).not.toHaveBeenCalled();
  });
  it('retains the advertised model when metadata rounds USD to float32', async () => {
    const harness = setup();
    const model = harness.peer.metadata!.providers[0]!.serviceUnitBillingModels![offer.service]![offer.serviceApiProtocol]!;
    model.components[0]!.priceUsd = Math.fround(0.001);
    await harness.send();
    expect(harness.sendRequest).toHaveBeenCalledWith(expect.anything(), expect.anything(), undefined,
      expect.objectContaining({ unitBilling: { ...offer, unitModel: model } }));
  });
  it('snapshots the nested agreed and advertised models before signature verification', async () => {
    const harness = setup();
    harness.verifyMetadataSignature.mockImplementation(async () => {
      harness.agreed.unitModel.components[0]!.priceUsd = 0.009;
      harness.peer.metadata!.providers[0]!.serviceUnitBillingModels![offer.service]![offer.serviceApiProtocol]!.components[0]!.priceUsd = 0.009;
      return true;
    });
    await harness.send();
    expect(harness.sendRequest).toHaveBeenCalledWith(expect.anything(), expect.anything(), undefined,
      expect.objectContaining({ unitBilling: offer }));
  });
  it('still rejects missing or changed advertised prices before dispatch', async () => {
    const missing = setup();
    missing.peer.metadata!.providers[0]!.serviceUnitBillingModels = {};
    await expect(missing.send()).rejects.toThrow('Missing completed-request billing model');
    expect(missing.sendRequest).not.toHaveBeenCalled();
    const changed = setup();
    changed.peer.metadata!.providers[0]!.serviceUnitBillingModels![offer.service]![offer.serviceApiProtocol]!.components[0]!.priceUsd = 0.002;
    await expect(changed.send()).rejects.toThrow('offer changed');
    expect(changed.sendRequest).not.toHaveBeenCalled();
  });
});

describe('independent service execution and pricing', () => {
  function provider(): Provider {
    return {
      name: 'mixed', services: ['route', 'image'], maxConcurrency: 4,
      pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
      serviceApiProtocols: { route: ['model-routing'], image: ['openai-images'] },
      serviceUnitBillingModels: {
        route: { 'model-routing': { version: 1, components: [{ unit: 'completed_requests', priceUsd: 0.001 }] } },
        image: { 'openai-images': { version: 1, components: [{ unit: 'output_images', priceUsd: 0.04 }] } },
      },
      handleRequest: vi.fn(),
    };
  }
  function register(candidate: Provider): void {
    AntseedNode.prototype.registerProvider.call({ _providers: [] } as unknown as AntseedNode, candidate);
  }
  it('keeps completed requests out of inference listings without filtering their metadata', () => {
    const candidate = provider();
    register(candidate);
    expect(completedRequestOffer(candidate, 'route')).toEqual({ provider: 'mixed', service: 'route', serviceApiProtocol: 'model-routing' as const, unitModel: { version: 1 as const, components: [{ unit: 'completed_requests' as const, priceUsd: 0.001 }] } });
    expect(candidate.services.filter(service => isLegacyInferenceService(candidate, service))).toEqual(['image']);
  });
  it('allows routing execution without forcing completed-request pricing', () => {
    const candidate = provider();
    delete candidate.serviceUnitBillingModels!.route;
    expect(() => register(candidate)).not.toThrow();
    expect(completedRequestOffer(candidate, 'route')).toBeUndefined();
    expect(candidate.services.filter(service => isLegacyInferenceService(candidate, service))).toEqual(['image']);
  });
  it('allows the same completed-request price on a TypeSafe API', () => {
    const candidate = provider();
    const model = candidate.serviceUnitBillingModels!.route!['model-routing']!;
    candidate.serviceApiProtocols!.route = ['typesafe-systemone'];
    candidate.serviceUnitBillingModels!.route = { 'typesafe-systemone': model };
    expect(() => register(candidate)).not.toThrow();
    expect(completedRequestOffer(candidate, 'route')?.unitModel).toBe(model);
  });
  it('rejects ambiguous service pricing or an unadvertised API protocol', () => {
    const candidate = provider();
    candidate.serviceApiProtocols!.route = ['model-routing', 'typesafe-systemone'];
    candidate.serviceUnitBillingModels!.route!['typesafe-systemone'] = { version: 1, components: [{ unit: 'completed_requests', priceUsd: 0.002 }] };
    expect(() => register(candidate)).toThrow('same unit price');
    const unadvertised = provider();
    unadvertised.serviceApiProtocols!.route = [];
    expect(() => register(unadvertised)).toThrow('advertised API protocol');
  });
  it('rejects unmeasured token surcharges', () => {
    const surcharge = provider();
    surcharge.pricing.defaults.inputUsdPerMillion = 1;
    expect(() => register(surcharge)).toThrow('unmeasured token charges');
  });
  it('keeps seller-side coverage checks around the shared price resolver', () => {
    const candidate = provider();
    candidate.serviceApiProtocols!.route!.push('typesafe-systemone');
    expect(() => completedRequestOffer(candidate, 'route')).toThrow('same unit price');
    candidate.serviceUnitBillingModels!.route!['typesafe-systemone'] = {
      version: 1, components: [{ unit: 'output_images', priceUsd: 0.001 }],
    };
    expect(() => completedRequestOffer(candidate, 'route')).toThrow('Invalid');
    candidate.serviceUnitBillingModels!.route!['typesafe-systemone'] = {
      version: 1, components: [{ unit: 'completed_requests', priceUsd: -1 }],
    };
    expect(() => completedRequestOffer(candidate, 'route')).toThrow('non-negative');
  });
  it('supports zero-priced completions and keeps request-priced images out of inference listings', () => {
    const free = provider();
    free.serviceUnitBillingModels!.route = { 'model-routing': { version: 1, components: [{ unit: 'completed_requests', priceUsd: 0 }] } };
    expect(() => register(free)).not.toThrow();
    const invalid = provider();
    invalid.serviceUnitBillingModels!.image = { 'openai-images': { version: 1, components: [{ unit: 'completed_requests', priceUsd: 0.001 }] } };
    expect(() => register(invalid)).not.toThrow();
    expect(isLegacyInferenceService(invalid, 'image')).toBe(false);
  });
});
