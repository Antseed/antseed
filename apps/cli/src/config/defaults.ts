import { DEFAULT_MODEL_ROUTING_PREFERENCES } from '@antseed/node/model-routing';
import type { AntseedConfig } from './types.js';

export const DEFAULT_BUYER_PEER_REFRESH_INTERVAL_MS = 5 * 60_000;
export const DEFAULT_BUYER_METADATA_FETCH_TIMEOUT_MS = 1500;
export const DEFAULT_BUYER_REQUEST_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_BUYER_MAX_STREAM_DURATION_MS = 30 * 60_000;
/** Jurisdictions under comprehensive sanctions; sellers refuse their IPs unless they opt out. */
export const DEFAULT_RESTRICTED_COUNTRIES = ['CU', 'IR', 'KP', 'SY'];

/**
 * Create a default Antseed configuration with sensible defaults.
 */
export function createDefaultConfig(): AntseedConfig {
  return {
    identity: {
      // Replaced with a deterministic peer-derived name when the CLI creates
      // or loads an identity (for example, `antseed seller setup/start`).
      displayName: 'Antseed Node',
    },
    seller: {
      reserveFloor: 10,
      maxConcurrentBuyers: 50,
      providers: {},
      publicAddress: '',
    },
    buyer: {
      maxPricing: {
        defaults: {
          inputUsdPerMillion: 100,
          outputUsdPerMillion: 100,
        },
      },
      minPeerReputation: 0,
      routingPreferences: {
        ...DEFAULT_MODEL_ROUTING_PREFERENCES,
        allowedPeerIds: [],
        blockedPeerIds: [],
      },
      proxyPort: 8377,
      peerRefreshIntervalMs: DEFAULT_BUYER_PEER_REFRESH_INTERVAL_MS,
      metadataFetchTimeoutMs: DEFAULT_BUYER_METADATA_FETCH_TIMEOUT_MS,
      requestTimeoutMs: DEFAULT_BUYER_REQUEST_TIMEOUT_MS,
      maxStreamDurationMs: DEFAULT_BUYER_MAX_STREAM_DURATION_MS,
      disableMetadataV2Services: false,
      autoSweep: true,
    },
    payments: {
      preferredMethod: 'crypto',
      platformFeeRate: 0.05,
      crypto: {
        chainId: 'base-mainnet',
      },
    },
    relayer: {
      enabled: true,
    },
    network: {
      bootstrapNodes: [],
    },
  };
}
