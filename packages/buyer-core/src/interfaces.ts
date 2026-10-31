/**
 * Environment interfaces for the buyer machinery. @antseed/node satisfies
 * them with its PeerConnection / sqlite ChannelStore / verification storage;
 * other transports and storage backends can provide their own. All are
 * structural — implementations don't need to import this package.
 */

import type { AbstractSigner } from 'ethers';
import type {
  ConnectionState,
  PeerId,
  PeerMetadata,
  ProviderPricingMatrixEntry,
  ProviderServiceCategoryMatrixEntry,
  ProviderServiceApiProtocolMatrixEntry,
  ProviderServiceCapabilityMatrixEntry,
  ProviderServiceHealthMatrixEntry,
  ProviderServiceUnitBillingModelMatrixEntry,
  ResponseAuthPayload,
  SerializedHttpRequest,
  SerializedHttpResponse,
} from '@antseed/protocol';

/** Minimum transport surface the muxes need: raw frame bytes out. */
export interface FrameSender {
  send(data: Uint8Array): void;
}

/** Connection surface used by the buyer request/payment machinery. */
export interface BuyerConnection extends FrameSender {
  readonly state: ConnectionState;
  on(event: 'stateChange', listener: (state: ConnectionState) => void): unknown;
  off(event: 'stateChange', listener: (state: ConnectionState) => void): unknown;
}

/**
 * The signer surface the buyer machinery needs: EIP-712 signing plus a
 * synchronously readable address. ethers `Wallet` satisfies it; so does any
 * AbstractSigner subclass (non-extractable WebCrypto keys, embedded wallets)
 * that exposes its address as a property.
 */
export type BuyerSigner = AbstractSigner & { readonly address: string };

/** Local identity: the hot-wallet signer whose address is the peerId. */
export interface BuyerIdentity {
  peerId: PeerId;
  wallet: BuyerSigner;
}

/**
 * The subset of peer knowledge the buyer machinery reads. @antseed/node's
 * PeerInfo is a structural superset.
 */
export interface BuyerPeerView {
  peerId: PeerId;
  capabilities?: string[];
  providerPricing?: Record<string, ProviderPricingMatrixEntry>;
  providers?: string[];
  providerServiceCategories?: Record<string, ProviderServiceCategoryMatrixEntry>;
  providerServiceApiProtocols?: Record<string, ProviderServiceApiProtocolMatrixEntry>;
  providerServiceUnitBillingModels?: Record<string, ProviderServiceUnitBillingModelMatrixEntry>;
  providerServiceCapabilities?: Record<string, ProviderServiceCapabilityMatrixEntry>;
  /** Seller self health check results per provider/service (metadata v13+). */
  providerServiceHealth?: Record<string, ProviderServiceHealthMatrixEntry>;
  defaultInputUsdPerMillion?: number;
  defaultOutputUsdPerMillion?: number;
  defaultCachedInputUsdPerMillion?: number;
  metadata?: PeerMetadata;
}

export interface StoredResponseAuth extends ResponseAuthPayload {
  receivedAt: number;
  verified: boolean;
  verificationError: string | null;
  requestPreimage?: Uint8Array | null;
  responsePreimage?: Uint8Array | null;
}

/**
 * Who a receipt is for, from the buyer's own request: the peer it sent the
 * request to and the service it asked for. A receipt's own peer and service
 * fields are whatever the seller wrote, so only these can be trusted.
 */
export interface ResponseAuthContext {
  sellerPeerId: string;
  requestedService: string;
}

/** Sink for seller-signed per-response receipts (sqlite on node, optional elsewhere). */
export interface ResponseAuthSink {
  insertResponseAuth(record: StoredResponseAuth, context?: ResponseAuthContext): void;
}

export interface ResponseAuthSampleInput {
  request: SerializedHttpRequest;
  response: SerializedHttpResponse;
  responseAuth: ResponseAuthPayload;
  verified: boolean;
  verificationError: string | null;
}

/** Optional sampler that persists full request/response pairs for audits. */
export interface ResponseAuthSampler {
  maybeStoreResponseAuthSample(input: ResponseAuthSampleInput): Promise<unknown>;
}
