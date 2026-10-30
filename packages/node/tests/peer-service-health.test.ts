import { describe, expect, it } from 'vitest';
import { AntseedNode } from '../src/node.js';
import { METADATA_VERSION, type PeerMetadata, type ProviderAnnouncement, type ServiceHealth } from '../src/discovery/peer-metadata.js';

function upstream(serviceHealth?: Record<string, ServiceHealth>, price = 1): ProviderAnnouncement {
  return {
    provider: 'openai',
    services: ['gpt-6-sol'],
    defaultPricing: { inputUsdPerMillion: price, outputUsdPerMillion: price },
    serviceUnitBillingModels: { 'gpt-6-sol': { 'openai-images': { version: 1, components: [{ unit: 'output_images', priceUsd: price }] } } },
    ...(serviceHealth ? { serviceHealth } : {}),
    maxConcurrency: 1,
    currentLoad: 0,
  };
}

function peerInfo(providers: ProviderAnnouncement[]) {
  const metadata: PeerMetadata = {
    peerId: 'a'.repeat(40) as PeerMetadata['peerId'],
    version: METADATA_VERSION,
    providers,
    region: 'test',
    timestamp: Date.now(),
    signature: '',
  };
  const node = new AntseedNode({ role: 'buyer' });
  return (node as any)._lookupResultToPeerInfo({ host: '127.0.0.1', port: 6882, metadata });
}

const peerHealth = (providers: ProviderAnnouncement[]) => peerInfo(providers).providerServiceHealth;

describe('service health across upstreams sharing a provider name', () => {
  const failing: ServiceHealth = { status: 'failing', reason: 'timeout', checkedAt: 2 };
  const healthy: ServiceHealth = { status: 'healthy', checkedAt: 1 };

  it('stays routable while any upstream is healthy, in either order', () => {
    expect(peerHealth([upstream({ 'gpt-6-sol': healthy }), upstream({ 'gpt-6-sol': failing })])?.openai.services['gpt-6-sol']).toEqual(healthy);
    expect(peerHealth([upstream({ 'gpt-6-sol': failing }), upstream({ 'gpt-6-sol': healthy })])?.openai.services['gpt-6-sol']).toEqual(healthy);
  });

  it('stays routable when the other upstream has not been checked yet', () => {
    expect(peerHealth([upstream({ 'gpt-6-sol': failing }), upstream()])).toBeUndefined();
  });

  it('is failing only when every upstream reports failing', () => {
    const older: ServiceHealth = { status: 'failing', reason: 'auth', checkedAt: 1 };
    expect(peerHealth([upstream({ 'gpt-6-sol': older }), upstream({ 'gpt-6-sol': failing })])?.openai.services['gpt-6-sol']).toEqual(failing);
  });

  it('takes pricing and billing from the upstream the seller serves the service through', () => {
    const terms = (providers: ProviderAnnouncement[]) => {
      const peer = peerInfo(providers);
      return [
        peer.providerPricing.openai.services['gpt-6-sol'].inputUsdPerMillion,
        peer.providerServiceUnitBillingModels.openai.services['gpt-6-sol']['openai-images'].components[0].priceUsd,
      ];
    };
    expect(terms([upstream({ 'gpt-6-sol': healthy }, 1), upstream({ 'gpt-6-sol': failing }, 9)])).toEqual([1, 1]);
    expect(terms([upstream({ 'gpt-6-sol': failing }, 9), upstream({ 'gpt-6-sol': healthy }, 1)])).toEqual([1, 1]);
    expect(terms([upstream(undefined, 1), upstream(undefined, 9)])).toEqual([1, 1]);
    expect(terms([upstream({ 'gpt-6-sol': failing }, 1), upstream({ 'gpt-6-sol': failing }, 9)])).toEqual([1, 1]);
  });
});
