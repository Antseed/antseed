import { createConnection, isIP } from 'node:net';
import { parseHostPort, type HostPortEndpoint } from '../../../config/public-address.js';

export type SellerEndpointClassification =
  | 'missing'
  | 'invalid'
  | 'loopback'
  | 'private'
  | 'link-local'
  | 'unspecified'
  | 'multicast'
  | 'unroutable'
  | 'potentially-public';

export type SellerEndpoint = HostPortEndpoint;

export interface SellerReachabilityAssessment {
  address: string;
  endpoint: SellerEndpoint | null;
  classification: SellerEndpointClassification;
  publiclyRoutable: boolean;
  message: string;
}

export interface TcpProbeResult {
  reachable: boolean;
  durationMs: number;
  error?: string;
}

export function parseSellerEndpoint(value: string): SellerEndpoint | null {
  return parseHostPort(value);
}

function classifyIpv4(host: string): SellerEndpointClassification {
  const octets = host.split('.').map(Number);
  const [first, second] = octets;
  if (first === undefined || second === undefined) return 'invalid';
  if (first === 0) return 'unspecified';
  if (first === 127) return 'loopback';
  if (first === 169 && second === 254) return 'link-local';
  if (
    first === 10
    || (first === 100 && second >= 64 && second <= 127)
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
  ) {
    return 'private';
  }
  if (
    (first === 192 && second === 0 && octets[2] === 2)
    || (first === 198 && (second === 18 || second === 19))
    || (first === 198 && second === 51 && octets[2] === 100)
    || (first === 203 && second === 0 && octets[2] === 113)
    || first >= 240
  ) {
    return 'unroutable';
  }
  if (first >= 224) return 'multicast';
  return 'potentially-public';
}

function classifyIpv6(host: string): SellerEndpointClassification {
  const normalized = host.toLowerCase();
  if (normalized === '::') return 'unspecified';
  if (normalized === '::1') return 'loopback';
  if (normalized.startsWith('fe8') || normalized.startsWith('fe9') || normalized.startsWith('fea') || normalized.startsWith('feb')) {
    return 'link-local';
  }
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return 'private';
  if (normalized.startsWith('ff')) return 'multicast';
  if (normalized.startsWith('2001:db8:') || normalized === '2001:db8::') return 'unroutable';
  return 'potentially-public';
}

export function assessSellerPublicAddress(value: string | undefined): SellerReachabilityAssessment {
  const address = value?.trim() ?? '';
  if (address.length === 0) {
    return {
      address,
      endpoint: null,
      classification: 'missing',
      publiclyRoutable: false,
      message: 'seller.publicAddress is empty, so buyers may have no dialable endpoint.',
    };
  }

  const endpoint = parseSellerEndpoint(address);
  if (!endpoint) {
    return {
      address,
      endpoint: null,
      classification: 'invalid',
      publiclyRoutable: false,
      message: 'seller.publicAddress must use the form host:port.',
    };
  }

  const normalizedHost = endpoint.host.toLowerCase();
  let classification: SellerEndpointClassification;
  if (normalizedHost === 'localhost' || normalizedHost.endsWith('.localhost')) {
    classification = 'loopback';
  } else {
    const ipVersion = isIP(endpoint.host);
    classification = ipVersion === 4
      ? classifyIpv4(endpoint.host)
      : ipVersion === 6
        ? classifyIpv6(endpoint.host)
        : 'potentially-public';
  }

  const publiclyRoutable = classification === 'potentially-public';
  return {
    address,
    endpoint,
    classification,
    publiclyRoutable,
    message: publiclyRoutable
      ? 'The endpoint may be public; run seller doctor and verify it from another network.'
      : `The announced host is ${classification} and is not publicly routable.`,
  };
}

export async function probeTcpEndpoint(
  endpoint: SellerEndpoint,
  timeoutMs = 3_000,
): Promise<TcpProbeResult> {
  const startedAt = Date.now();

  return await new Promise((resolve) => {
    const socket = createConnection({ host: endpoint.host, port: endpoint.port });
    let settled = false;

    const finish = (result: Omit<TcpProbeResult, 'durationMs'>): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve({ ...result, durationMs: Date.now() - startedAt });
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish({ reachable: true }));
    socket.once('timeout', () => finish({ reachable: false, error: `timed out after ${timeoutMs}ms` }));
    socket.once('error', (error) => finish({ reachable: false, error: error.message }));
  });
}

export function startupReachabilityWarning(value: string | undefined): string | null {
  const assessment = assessSellerPublicAddress(value);
  if (assessment.publiclyRoutable) return null;

  return [
    'WARNING: This seller is not announcing a publicly routable endpoint.',
    assessment.message,
    'Set one with: antseed config seller set publicAddress "seller.example.com:6882"',
    'Then run: antseed seller doctor',
    'Networking guide: https://antseed.com/docs/transport/',
  ].join('\n');
}
