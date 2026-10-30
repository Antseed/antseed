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

  it('keeps each protocol route of upstreams sharing a provider name and service', () => {
    const chat: ProviderAnnouncement = { ...upstream({ 'gpt-6-sol': healthy }, 1), serviceApiProtocols: { 'gpt-6-sol': ['openai-chat-completions'] }, serviceUnitBillingModels: undefined };
    const video: ProviderAnnouncement = {
      ...upstream({ 'gpt-6-sol': healthy }, 9),
      serviceApiProtocols: { 'gpt-6-sol': ['fal-video'] },
      serviceUnitBillingModels: { 'gpt-6-sol': { 'fal-video': { version: 1, components: [{ unit: 'video_seconds', priceUsd: 0.5 }] } } },
    };
    const peer = peerInfo([chat, video]);
    expect(peer.providerServiceApiProtocols.openai.services['gpt-6-sol']).toEqual(['openai-chat-completions', 'fal-video']);
    expect(peer.providerServiceUnitBillingModels.openai.services['gpt-6-sol']['fal-video'].components[0].priceUsd).toBe(0.5);
    expect(peer.providerPricing.openai.services['gpt-6-sol'].inputUsdPerMillion).toBe(1);
  });

  it('takes terms from the first healthy upstream of the name when others are interleaved', () => {
    const other: ProviderAnnouncement = { ...upstream({ 'gpt-6-sol': healthy }, 5), provider: 'codex' };
    const peer = peerInfo([upstream({ 'gpt-6-sol': failing }, 9), other, upstream({ 'gpt-6-sol': healthy }, 1)]);
    expect(peer.providerPricing.openai.services['gpt-6-sol'].inputUsdPerMillion).toBe(1);
    expect(peer.providerPricing.codex.services['gpt-6-sol'].inputUsdPerMillion).toBe(5);
  });

  it('marks a protocol only failing upstreams serve, while the service stays routable', () => {
    const route = (protocol: 'venice-video' | 'fal-video', health: ServiceHealth): ProviderAnnouncement => ({
      ...upstream({ 'gpt-6-sol': health }),
      serviceApiProtocols: { 'gpt-6-sol': [protocol] },
      serviceUnitBillingModels: { 'gpt-6-sol': { [protocol]: { version: 1, components: [{ unit: 'video_seconds', priceUsd: 0.5 }] } } },
    });
    const peer = peerInfo([route('venice-video', healthy), route('fal-video', failing)]);
    expect(peer.providerServiceHealth.openai).toEqual({ services: { 'gpt-6-sol': healthy }, failingProtocols: { 'gpt-6-sol': { 'fal-video': failing } } });
    expect(peer.providerServiceApiProtocols.openai.services['gpt-6-sol']).toEqual(['venice-video', 'fal-video']);
    // When every route fails, the service itself is failing and no protocol is singled out.
    expect(peerInfo([route('venice-video', failing), route('fal-video', failing)]).providerServiceHealth.openai.failingProtocols).toBeUndefined();
  });

  it('keeps the capabilities of the upstream serving each protocol', () => {
    const chat: ProviderAnnouncement = { ...upstream({ 'gpt-6-sol': healthy }), serviceApiProtocols: { 'gpt-6-sol': ['openai-chat-completions'] }, serviceUnitBillingModels: undefined, serviceCapabilities: { 'gpt-6-sol': { supportedParameters: ['seed'] } } };
    const video: ProviderAnnouncement = { ...upstream({ 'gpt-6-sol': healthy }), serviceApiProtocols: { 'gpt-6-sol': ['fal-video'] }, serviceUnitBillingModels: undefined, serviceCapabilities: { 'gpt-6-sol': { supportedParameters: ['video_url'] } } };
    expect(peerInfo([chat, video]).providerServiceCapabilities.openai).toEqual({
      services: { 'gpt-6-sol': { supportedParameters: ['seed'] } },
      protocols: { 'gpt-6-sol': { 'fal-video': { supportedParameters: ['video_url'] } } },
    });
  });
});
