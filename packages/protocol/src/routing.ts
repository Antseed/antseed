/**
 * Routing services: sellers that rank inference destinations for a buyer instead of serving
 * inference. Routing is a service category, not one API: each routing API is its own service
 * API protocol (`ROUTING_PROTOCOLS`) with its own wire binding here and its own provider plugin.
 * No routing protocol or router is a default; adding one means appending a protocol, adding
 * its wire binding to `ROUTING_WIRES`, and a buyer client adapter in `@antseed/router-core`.
 */
import { IRP_SUGGEST_WIRE } from './irp.js';
import { isRoutingProtocol, ROUTING_PROTOCOLS, type RoutingProtocol } from './service-api.js';

export { ROUTING_PROTOCOLS, isRoutingProtocol, type RoutingProtocol };

/** What a routing request does: list the models a router can rank (free), or buy a ranking. */
export type RoutingRequestAction = 'catalog' | 'rank';

/**
 * The parts of a routing protocol the seller node and unit billing need. Buyer and seller run
 * the same billing functions on the same bytes, so they always agree on the charge.
 */
export interface RoutingWireProtocol {
  readonly protocol: RoutingProtocol;
  /**
   * True when requests do not name the service being bought, so a seller may offer at most
   * one service of this protocol and the path identifies it.
   */
  readonly oneServicePerSeller: boolean;
  /** `catalog` requests are free control-plane calls; `rank` requests are billed. Null when not this protocol. */
  requestAction(method: string, path: string): RoutingRequestAction | null;
  /** Whether `path` belongs to this protocol, whatever the method. */
  isProtocolPath(path: string): boolean;
  /** Candidate IDs a rank request offered the router. */
  rankCandidateIds(requestBody: Uint8Array): string[];
  /** Whether a 2xx rank response is a usable ranking naming at least one offered candidate. */
  isBillableRanking(responseBody: Uint8Array, candidateIds: readonly string[]): boolean;
  /** A response the seller node answers locally, in this protocol's error format. */
  errorResponse(status: number, reason: 'no-router' | 'unavailable', detail: string): { contentType: string; body: Uint8Array };
}

const ROUTING_WIRES: Record<RoutingProtocol, RoutingWireProtocol> = {
  'irp-suggest': IRP_SUGGEST_WIRE,
};

export function routingWireProtocol(protocol: RoutingProtocol): RoutingWireProtocol {
  return ROUTING_WIRES[protocol];
}

/** The routing protocol a request path belongs to, or null for any other request. */
export function routingProtocolForPath(path: string): RoutingProtocol | null {
  return ROUTING_PROTOCOLS.find(protocol => ROUTING_WIRES[protocol].isProtocolPath(path)) ?? null;
}

/** The routing protocol and action of a request, or null when it is not a routing request. */
export function routingRequestOf(method: string, path: string): { protocol: RoutingProtocol; action: RoutingRequestAction } | null {
  for (const protocol of ROUTING_PROTOCOLS) {
    const action = ROUTING_WIRES[protocol].requestAction(method, path);
    if (action) return { protocol, action };
  }
  return null;
}

/** The routing protocol a service advertises, or null when it is not a routing service. */
export function routingProtocolOf(protocols: readonly string[] | undefined): RoutingProtocol | null {
  return protocols?.find(isRoutingProtocol) ?? null;
}

type ProtocolMatrix = Record<string, { services: Record<string, readonly string[] | undefined> } | undefined> | undefined;

/** Every routing service in a peer's advertised provider → service → protocols matrix. */
export function listRoutingServices(matrix: ProtocolMatrix): Array<{ provider: string; serviceId: string; protocol: RoutingProtocol }> {
  return Object.entries(matrix ?? {}).flatMap(([provider, entry]) =>
    Object.entries(entry?.services ?? {}).flatMap(([serviceId, protocols]) => {
      const protocol = routingProtocolOf(protocols);
      return protocol ? [{ provider, serviceId, protocol }] : [];
    }));
}

/**
 * The service a routing request on `protocol` addresses, for protocols whose requests do not
 * name one: the peer's only service of that protocol. Null when there is none or (invalidly)
 * more than one.
 */
export function findRoutingService(matrix: ProtocolMatrix, protocol: RoutingProtocol): { provider: string; serviceId: string } | null {
  const found = listRoutingServices(matrix).filter(service => service.protocol === protocol);
  return found.length === 1 ? { provider: found[0]!.provider, serviceId: found[0]!.serviceId } : null;
}

/** USD per 1M tokens of a candidate destination, in the protocol-neutral form routers are given. */
export type RouterPricing = { inputUsdPerMillion: number; cachedInputUsdPerMillion: number; outputUsdPerMillion: number };

/** Model catalog entry a router accepts as `*`: any model the buyer offers. */
export const ROUTER_ANY_MODEL = '*';

/**
 * One model a router can rank, from its catalog, in protocol-neutral form. `maxPricing` caps
 * the candidates the buyer sends for it; an omitted field means no limit.
 */
export type RouterModelEntry = { id: string; maxPricing?: Partial<RouterPricing> };

/** Whether `pricing` is within `limit`; an omitted limit field allows any price. */
export function withinRouterPricing(pricing: RouterPricing, limit: Partial<RouterPricing> | undefined): boolean {
  return !limit || (['inputUsdPerMillion', 'cachedInputUsdPerMillion', 'outputUsdPerMillion'] as const)
    .every(key => limit[key] === undefined || pricing[key] <= limit[key]!);
}
