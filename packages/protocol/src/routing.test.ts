import { describe, expect, it } from 'vitest';
import {
  findRoutingService,
  listRoutingServices,
  routingProtocolForPath,
  routingRequestOf,
  withinRouterPricing,
} from './routing.js';
import { ROUTING_PROTOCOLS, WELL_KNOWN_SERVICE_API_PROTOCOLS } from './service-api.js';

describe('routing protocols', () => {
  it('lists every routing protocol as a service API protocol, appended after video', () => {
    expect(ROUTING_PROTOCOLS).toEqual(['irp-suggest']);
    expect(WELL_KNOWN_SERVICE_API_PROTOCOLS.indexOf('irp-suggest')).toBe(8);
  });

  it('classifies routing requests by protocol', () => {
    expect(routingRequestOf('GET', '/v1/routing/models')).toEqual({ protocol: 'irp-suggest', action: 'catalog' });
    expect(routingRequestOf('POST', '/v1/routing/rank?x=1')).toEqual({ protocol: 'irp-suggest', action: 'rank' });
    expect(routingRequestOf('POST', '/v1/chat/completions')).toBeNull();
    expect(routingProtocolForPath('/v1/routing/rank')).toBe('irp-suggest');
    expect(routingProtocolForPath('/v1/responses')).toBeNull();
  });

  it('finds a peer\'s routing services per protocol', () => {
    const matrix = { alpha: { services: { route: ['irp-suggest'], chat: ['openai-chat-completions'] } } };
    expect(listRoutingServices(matrix)).toEqual([{ provider: 'alpha', serviceId: 'route', protocol: 'irp-suggest' }]);
    expect(findRoutingService(matrix, 'irp-suggest')).toEqual({ provider: 'alpha', serviceId: 'route' });
    expect(findRoutingService({ ...matrix, beta: { services: { other: ['irp-suggest'] } } }, 'irp-suggest')).toBeNull();
    expect(findRoutingService(undefined, 'irp-suggest')).toBeNull();
  });

  it('applies router price limits field by field', () => {
    const pricing = { inputUsdPerMillion: 1, cachedInputUsdPerMillion: 0.1, outputUsdPerMillion: 4 };
    expect(withinRouterPricing(pricing, undefined)).toBe(true);
    expect(withinRouterPricing(pricing, { outputUsdPerMillion: 4 })).toBe(true);
    expect(withinRouterPricing(pricing, { inputUsdPerMillion: 0.5 })).toBe(false);
  });
});
