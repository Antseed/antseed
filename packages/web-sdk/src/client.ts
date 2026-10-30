/**
 * High-level browser buyer built on the SHARED buyer machinery from
 * @antseed/buyer-core — the same BuyerRequestHandler / BuyerPaymentManager /
 * BuyerPaymentNegotiator stack the node buyer proxy runs, wired to a WebRTC
 * transport and an injectable channel store. `create()` supplies durable
 * browser persistence; the public constructor retains the in-memory default.
 */

import { Contract, type AbstractSigner } from 'ethers';
import {
  BuyerPaymentManager,
  BuyerPaymentNegotiator,
  BuyerRequestHandler,
  CHANNEL_ROLE,
  CHANNEL_STATUS,
  ChannelsClient,
  DepositsClient,
  ProxyMux,
  SellerAddressResolver,
  VerificationMux,
  type BuyerConnection,
  type BuyerChannelStore,
  type BuyerIdentity,
  type BuyerPeerView,
  type BuyerSigner,
  type PaymentMux,
  type StoredChannel,
} from '@antseed/buyer-core';
import {
  MessageType,
  providerServiceHealthMatrix,
  providerServiceRoutes,
  toPeerId,
  type CloseChannelResultPayload,
  type PeerMetadata,
  type PeerId,
  type SerializedHttpRequest,
  type SerializedHttpResponse,
} from '@antseed/protocol';
import { SellerConnection, type ConnectionOptions, type RtcEnvironment } from './connection.js';
import { IndexedDbChannelStore, MemoryChannelStore } from './channel-store.js';
import { signerFromPrivateKey } from './identity.js';
import { BuyerTabLock, type WebLockManagerLike } from './tab-lock.js';

export interface SellerSummary extends BuyerPeerView {
  displayName?: string;
  publicAddress?: string;
  sellerContract?: string;
  metadata?: PeerMetadata;
}

export interface WebPaymentConfig {
  chainId: number;
  channelsContractAddress: string;
  depositsContractAddress: string;
  usdcAddress: string;
  /** RPC endpoint for read-only deposit/channel checks. Empty disables them. */
  rpcUrl: string;
  fallbackRpcUrls?: string[];
  maxPerRequestUsdc?: bigint;
  maxReserveAmountUsdc?: bigint;
  defaultAuthDurationSecs?: number;
  costToleranceMultiplier?: number;
}

export interface ClientOptions {
  /** Relay base URL, e.g. https://relay.antseed.com */
  relayUrl: string;
  /**
   * Buyer hot-wallet key, or any ethers AbstractSigner exposing its address
   * as a property (Wallet, JsonRpcSigner, custom non-extractable-key
   * signers). The peerId is its EVM address. Note: the payment stack signs a
   * SpendingAuth per request, so signers that prompt per signature (browser
   * extension wallets) are impractical for chat-style traffic.
   */
  privateKey?: string;
  wallet?: BuyerSigner;
  /** Defaults to Base mainnet (chain 8453). */
  payment?: Partial<WebPaymentConfig>;
  connection?: ConnectionOptions;
  requestTimeoutMs?: number;
  /** Receives asynchronous transport/protocol failures before the session closes. */
  onError?: (error: Error, context: { sellerPeerId: PeerId }) => void;
  /** Receives background IndexedDB failures as soon as a queued write fails. */
  onPersistenceError?: (error: Error) => void;
  /** Reject non-empty DHT snapshots older than this. Defaults to 15 minutes. */
  maxSellerSnapshotAgeMs?: number;
  /** Override RTCPeerConnection/WebSocket (browser globals by default). */
  env?: Partial<RtcEnvironment>;
  /**
   * Pre-opened custom channel store. The public constructor defaults to a
   * fresh in-memory store; production browser apps should prefer `create()`
   * so signed authorizations are durably committed before transmission and
   * signing is serialized across tabs.
   */
  channelStore?: BuyerChannelStore;
  /** Durable browser storage and cross-tab coordination options. */
  persistence?: {
    databaseName?: string;
    indexedDB?: IDBFactory;
    locks?: WebLockManagerLike;
    /** Wait for the other tab to release the buyer instead of failing fast. */
    waitForLock?: boolean;
  };
  /** Override the on-chain read clients (tests, custom RPC stacks). */
  depositsClient?: DepositsClient | null;
  channelsClient?: ChannelsClient | null;
}

export interface RequestInput {
  method?: string;
  path: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  /** Selects the provider on the seller (x-antseed-provider). */
  provider?: string;
}

export interface StreamCallbacks {
  onChunk?: (data: Uint8Array, done: boolean) => void;
}

// Base mainnet defaults (see packages/node/src/payments/chain-config.ts).
const BASE_MAINNET: WebPaymentConfig = {
  chainId: 8453,
  channelsContractAddress: '0xBA66d3b4fbCf472F6F11D6F9F96aaCE96516F09d',
  depositsContractAddress: '0x0F7a3a8f4Da01637d1202bb5443fcF7F88F99fD2',
  usdcAddress: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  rpcUrl: 'https://base.publicnode.com',
};

// Stay under the ~256 KiB SCTP message ceiling browsers negotiate with
// libdatachannel sellers; the shared mux default (512 KiB) assumes node peers.
const BROWSER_UPLOAD_THRESHOLD_BYTES = 192 * 1024;

interface SessionWiring {
  conn: SellerConnection;
  proxyMux: ProxyMux;
  verificationMux: VerificationMux;
}

export class AntseedWebClient {
  private readonly identity: BuyerIdentity;
  private readonly env: RtcEnvironment;
  private readonly payment: WebPaymentConfig;
  private readonly store: BuyerChannelStore;
  private readonly channelsClient: ChannelsClient | null;
  private readonly handler: BuyerRequestHandler;
  readonly negotiator: BuyerPaymentNegotiator;
  private readonly sessions = new Map<PeerId, SessionWiring>();
  private readonly sessionPromises = new Map<PeerId, Promise<SessionWiring>>();
  private closed = false;

  constructor(
    private readonly options: ClientOptions,
    private readonly tabLock?: BuyerTabLock,
  ) {
    const wallet = resolveWallet(options);
    this.identity = { peerId: toPeerId(wallet.address.slice(2).toLowerCase()), wallet };
    this.store = options.channelStore ?? new MemoryChannelStore();

    const globalRtc = (globalThis as Record<string, unknown>).RTCPeerConnection as
      | typeof RTCPeerConnection
      | undefined;
    const globalWs = (globalThis as Record<string, unknown>).WebSocket as
      | RtcEnvironment['WebSocket']
      | undefined;
    const RTCPeerConnectionImpl = options.env?.RTCPeerConnection ?? globalRtc;
    const WebSocketImpl = options.env?.WebSocket ?? globalWs;
    if (!RTCPeerConnectionImpl || !WebSocketImpl) {
      throw new Error('RTCPeerConnection/WebSocket unavailable — pass them via options.env');
    }
    this.env = { RTCPeerConnection: RTCPeerConnectionImpl, WebSocket: WebSocketImpl };
    this.payment = { ...BASE_MAINNET, ...options.payment };

    let depositsClient: DepositsClient | null = null;
    if (options.depositsClient !== undefined) {
      depositsClient = options.depositsClient;
    } else if (this.payment.rpcUrl) {
      depositsClient = new DepositsClient({
        rpcUrl: this.payment.rpcUrl,
        ...(this.payment.fallbackRpcUrls ? { fallbackRpcUrls: this.payment.fallbackRpcUrls } : {}),
        contractAddress: this.payment.depositsContractAddress,
        usdcAddress: this.payment.usdcAddress,
        evmChainId: this.payment.chainId,
      });
    }

    let channelsClient: ChannelsClient | null = null;
    if (options.channelsClient !== undefined) {
      channelsClient = options.channelsClient;
    } else if (this.payment.rpcUrl) {
      channelsClient = new ChannelsClient({
        rpcUrl: this.payment.rpcUrl,
        ...(this.payment.fallbackRpcUrls ? { fallbackRpcUrls: this.payment.fallbackRpcUrls } : {}),
        contractAddress: this.payment.channelsContractAddress,
        evmChainId: this.payment.chainId,
      });
    }
    this.channelsClient = channelsClient;

    const sellerAddressResolver = channelsClient
      ? new SellerAddressResolver({
          isOperator: async (sellerContract, peerAddress) => {
            const contract = new Contract(
              sellerContract,
              ['function isOperator(address) view returns (bool)'],
              channelsClient.provider,
            );
            return contract.getFunction('isOperator')(peerAddress) as Promise<boolean>;
          },
        })
      : undefined;

    const bpm = new BuyerPaymentManager(
      this.identity,
      {
        rpcUrl: this.payment.rpcUrl,
        ...(this.payment.fallbackRpcUrls ? { fallbackRpcUrls: this.payment.fallbackRpcUrls } : {}),
        depositsContractAddress: this.payment.depositsContractAddress,
        channelsContractAddress: this.payment.channelsContractAddress,
        usdcAddress: this.payment.usdcAddress,
        identityRegistryAddress: '0x0000000000000000000000000000000000000000',
        chainId: this.payment.chainId,
        defaultAuthDurationSecs: this.payment.defaultAuthDurationSecs ?? 900,
        maxPerRequestUsdc: this.payment.maxPerRequestUsdc ?? 500_000n,
        maxReserveAmountUsdc: this.payment.maxReserveAmountUsdc ?? 1_000_000n,
        ...(this.payment.costToleranceMultiplier !== undefined
          ? { costToleranceMultiplier: this.payment.costToleranceMultiplier }
          : {}),
        dataDir: '',
      },
      this.store,
      sellerAddressResolver,
    );

    this.negotiator = new BuyerPaymentNegotiator(
      this.identity,
      bpm,
      depositsClient,
      channelsClient,
      this.store,
      {},
      { emit: () => true },
      sellerAddressResolver,
    );

    this.handler = new BuyerRequestHandler(
      { ...(options.requestTimeoutMs !== undefined ? { requestTimeoutMs: options.requestTimeoutMs } : {}) },
      {
        localPeerId: this.identity.peerId,
        negotiator: this.negotiator,
        verificationStorage: null,
        verificationSampler: null,
        getConnection: (peer) => this.requireSession(peer.peerId).then((s) => s.conn),
        getMux: (peerId) => this.sessions.get(peerId)!.proxyMux,
        getVerificationMux: (peerId) => this.sessions.get(peerId)!.verificationMux,
        registerPaymentMux: () => {},
      },
    );
  }

  /**
   * Open a production browser client. This acquires the identity-wide tab lock
   * and hydrates IndexedDB before BuyerPaymentManager is constructed.
   */
  static async create(options: ClientOptions): Promise<AntseedWebClient> {
    const wallet = resolveWallet(options);
    const payment = { ...BASE_MAINNET, ...options.payment };
    const locks = options.persistence?.locks
      ?? (globalThis.navigator as Navigator & { locks?: WebLockManagerLike } | undefined)?.locks;
    if (!locks) {
      throw new Error('Web Locks API unavailable — paid browser operation is disabled');
    }

    const scope = [
      payment.chainId,
      payment.channelsContractAddress.toLowerCase(),
      wallet.address.toLowerCase(),
    ].join(':');
    const tabLock = await BuyerTabLock.acquire(`antseed:buyer:${scope}`, locks, {
      wait: options.persistence?.waitForLock ?? false,
    });

    try {
      const store = options.channelStore ?? await IndexedDbChannelStore.open({
        databaseName: options.persistence?.databaseName ?? `antseed-web-sdk:${scope}`,
        ...(options.persistence?.indexedDB ? { indexedDB: options.persistence.indexedDB } : {}),
        ...(options.onPersistenceError ? { onWriteError: options.onPersistenceError } : {}),
      });
      const { privateKey: _privateKey, ...safeOptions } = options;
      return new AntseedWebClient({ ...safeOptions, wallet, channelStore: store }, tabLock);
    } catch (error) {
      await tabLock.release();
      throw error;
    }
  }

  /**
   * In-memory client for tests and free interoperability experiments. Paid
   * applications must use `create()` so reload recovery and tab exclusion are
   * active.
   */
  static ephemeral(options: ClientOptions): AntseedWebClient {
    return new AntseedWebClient({ ...options, channelStore: options.channelStore ?? new MemoryChannelStore() });
  }

  get peerId(): PeerId {
    return this.identity.peerId;
  }

  async sellers(): Promise<SellerSummary[]> {
    const res = await fetch(`${this.options.relayUrl.replace(/\/$/, '')}/sellers`);
    if (!res.ok) throw new Error(`relay /sellers failed: ${res.status}`);
    const body = (await res.json()) as {
      peers: PeerMetadata[];
      static: { peerId: string; host: string; port: number }[];
      updatedAt: string;
    };
    let useDiscoveredPeers = body.peers.length > 0;
    if (useDiscoveredPeers) {
      const updatedAt = Date.parse(body.updatedAt);
      const maxAge = this.options.maxSellerSnapshotAgeMs ?? 15 * 60_000;
      if (!Number.isFinite(updatedAt) || Date.now() - updatedAt > maxAge) {
        if (body.static.length === 0) throw new Error('relay seller snapshot is stale');
        useDiscoveredPeers = false;
      }
    }
    const byId = new Map<string, SellerSummary>();
    for (const entry of body.static) {
      const peerId = toPeerId(entry.peerId.toLowerCase());
      byId.set(peerId, { peerId, providers: [], publicAddress: `${entry.host}:${entry.port}` });
    }
    if (useDiscoveredPeers) {
      for (const metadata of body.peers) {
        const peer = sellerSummaryFromMetadata(metadata);
        byId.set(peer.peerId, peer);
      }
    }
    return [...byId.values()];
  }

  /** Connect to a seller. `peer` extras (pricing, metadata) improve cost validation. */
  async connect(
    seller: string | SellerSummary,
    peer: Partial<BuyerPeerView> = {},
  ): Promise<SellerSession> {
    this.assertOpen();
    const sellerPeerId = typeof seller === 'string' ? seller : seller.peerId;
    const peerId = toPeerId(sellerPeerId.toLowerCase());
    const sellerView = typeof seller === 'string'
      ? {}
      : seller as unknown as Partial<BuyerPeerView>;
    const peerView: BuyerPeerView = { ...sellerView, ...peer, peerId };
    await this.requireSession(peerId);
    return new SellerSession(this, peerView);
  }

  /** @internal */
  async requireSession(peerId: PeerId): Promise<SessionWiring> {
    this.assertOpen();
    const existing = this.sessions.get(peerId);
    if (existing) {
      if (existing.conn.isOpen) return existing;
      // Close a lingering (e.g. mid-connect) session before overwriting it.
      existing.conn.close();
      this.dropSession(peerId);
    }

    const pending = this.sessionPromises.get(peerId);
    if (pending) return pending;

    const opening = this.openSession(peerId);
    this.sessionPromises.set(peerId, opening);
    try {
      return await opening;
    } finally {
      if (this.sessionPromises.get(peerId) === opening) {
        this.sessionPromises.delete(peerId);
      }
    }
  }

  private async openSession(peerId: PeerId): Promise<SessionWiring> {
    const bridgeUrl = `${this.options.relayUrl.replace(/\/$/, '').replace(/^http/, 'ws')}/bridge/${peerId}`;
    const conn = await SellerConnection.connect(bridgeUrl, this.identity.wallet, this.env, this.options.connection);
    if (this.closed) {
      conn.close();
      throw new Error('AntseedWebClient is closed');
    }
    const proxyMux = new ProxyMux(conn, { uploadThresholdBytes: BROWSER_UPLOAD_THRESHOLD_BYTES });
    const verificationMux = new VerificationMux(conn);
    const paymentMux: PaymentMux = this.negotiator.getOrCreatePaymentMux(peerId, conn as BuyerConnection);

    conn.onFrame = (frame) => {
      if (frame.type >= 0x50 && frame.type <= 0x5f) {
        void paymentMux.handleFrame(frame).catch((error: unknown) => this.failSession(peerId, error));
      } else if (frame.type >= 0x80 && frame.type <= 0x8f) {
        void verificationMux.handleFrame(frame).catch((error: unknown) => this.failSession(peerId, error));
      } else if (frame.type !== MessageType.Ping && frame.type !== MessageType.Pong) {
        void proxyMux.handleFrame(frame).catch((error: unknown) => this.failSession(peerId, error));
      }
    };
    conn.onClose = () => this.dropSession(peerId);

    const wiring: SessionWiring = { conn, proxyMux, verificationMux };
    this.sessions.set(peerId, wiring);
    return wiring;
  }

  /** @internal */
  async sendRequest(
    peer: BuyerPeerView,
    req: SerializedHttpRequest,
    callbacks?: { onChunk?: (data: Uint8Array, done: boolean) => void },
  ): Promise<SerializedHttpResponse> {
    const session = await this.requireSession(peer.peerId);
    await this.negotiator.recoverPendingReserveBeforeRequest(peer, session.conn);
    const streamCallbacks = callbacks?.onChunk
      ? {
          onResponseChunk: (chunk: { data: Uint8Array; done: boolean }) =>
            callbacks.onChunk!(chunk.data, chunk.done),
        }
      : undefined;
    return this.handler.sendRequest(peer, req, streamCallbacks);
  }

  disconnect(sellerPeerId: string): void {
    const peerId = toPeerId(sellerPeerId.toLowerCase());
    const session = this.sessions.get(peerId);
    session?.conn.close();
    this.dropSession(peerId);
  }

  closeAll(): void {
    for (const [peerId, session] of [...this.sessions]) {
      session.conn.close();
      this.dropSession(peerId);
    }
  }

  listActiveChannels(): StoredChannel[] {
    return this.store.getActiveChannelsByBuyer(CHANNEL_ROLE.BUYER, this.identity.wallet.address);
  }

  /** @internal */
  getActiveChannelForPeer(sellerPeerId: string): StoredChannel | null {
    return this.store.getActiveChannelByPeerAndBuyer(
      toPeerId(sellerPeerId.toLowerCase()),
      CHANNEL_ROLE.BUYER,
      this.identity.wallet.address,
    );
  }

  /** Start the contract grace period using the buyer's configured operator signer. */
  async requestOnChainClose(channelId: string, operatorSigner: AbstractSigner): Promise<string> {
    this.assertOwnedActiveChannel(channelId);
    if (!this.channelsClient) throw new Error('channels client unavailable');
    return this.channelsClient.requestClose(operatorSigner, channelId);
  }

  /** Release the remaining reserve after the contract grace period has elapsed. */
  async withdrawTimedOutChannel(channelId: string, operatorSigner: AbstractSigner): Promise<string> {
    this.assertOwnedActiveChannel(channelId);
    if (!this.channelsClient) throw new Error('channels client unavailable');
    const txHash = await this.channelsClient.withdraw(operatorSigner, channelId);
    this.store.updateChannelStatus(channelId, CHANNEL_STATUS.TIMEOUT);
    await this.store.flush?.();
    return txHash;
  }

  /** Close all transports, flush storage, and release this buyer for another tab. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.negotiator.drainPendingNeedAuth();
    this.closeAll();
    this.negotiator.cleanup();
    try {
      await this.store.flush?.();
      await this.store.close?.();
    } finally {
      await this.tabLock?.release();
    }
  }

  /** @internal */
  async requestChannelClose(
    peer: BuyerPeerView,
    options?: { includeAuth?: boolean; timeoutMs?: number },
  ): Promise<CloseChannelResultPayload> {
    const session = await this.requireSession(peer.peerId);
    const result = await this.negotiator.requestChannelClose(peer.peerId, session.conn, options);
    await this.store.flush?.();
    return result;
  }

  private dropSession(peerId: PeerId): void {
    const session = this.sessions.get(peerId);
    session?.verificationMux.close();
    this.negotiator.onPeerDisconnect(peerId);
    this.sessions.delete(peerId);
  }

  private failSession(peerId: PeerId, cause: unknown): void {
    const error = cause instanceof Error ? cause : new Error(String(cause));
    try {
      this.options.onError?.(error, { sellerPeerId: peerId });
    } catch {
      // Error observers are diagnostic only and must not create a second
      // unhandled rejection while the failed session is being torn down.
    } finally {
      this.disconnect(peerId);
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('AntseedWebClient is closed');
  }

  private assertOwnedActiveChannel(channelId: string): StoredChannel {
    this.assertOpen();
    const channel = this.store.getChannel(channelId);
    if (
      !channel
      || channel.status !== CHANNEL_STATUS.ACTIVE
      || channel.role !== CHANNEL_ROLE.BUYER
      || channel.buyerEvmAddr.toLowerCase() !== this.identity.wallet.address.toLowerCase()
    ) {
      throw new Error('active channel is not owned by this buyer');
    }
    return channel;
  }
}

export function sellerSummaryFromMetadata(metadata: PeerMetadata): SellerSummary {
  const providers = metadata.providers.map((provider) => provider.provider);
  const firstProvider = metadata.providers[0];
  const providerPricing: NonNullable<BuyerPeerView['providerPricing']> = {};
  const providerServiceCategories: NonNullable<BuyerPeerView['providerServiceCategories']> = {};
  const providerServiceApiProtocols: NonNullable<BuyerPeerView['providerServiceApiProtocols']> = {};
  const providerServiceUnitBillingModels: NonNullable<BuyerPeerView['providerServiceUnitBillingModels']> = {};
  const providerServiceCapabilities: NonNullable<BuyerPeerView['providerServiceCapabilities']> = {};
  // Merged across upstreams sharing a provider name: failing only when all of them fail.
  const providerServiceHealth: NonNullable<BuyerPeerView['providerServiceHealth']> = providerServiceHealthMatrix(metadata.providers);
  // Each service's terms come from the upstream the seller serves it through.
  const routes = providerServiceRoutes(metadata.providers);

  for (const announcement of metadata.providers) {
    const provider = announcement.provider;
    const services = Object.fromEntries(
      announcement.services.filter((service) => routes.owns(announcement, service)).map((service) => [
        service,
        announcement.servicePricing?.[service] ?? announcement.defaultPricing,
      ]),
    );
    const pricing = providerPricing[provider];
    if (pricing) {
      pricing.services ??= {};
      Object.assign(pricing.services, services);
    } else {
      providerPricing[provider] = {
        defaults: { ...announcement.defaultPricing },
        ...(Object.keys(services).length > 0 ? { services } : {}),
      };
    }

    mergeServiceMatrix(providerServiceCategories, provider, routes.ownedEntries(announcement, announcement.serviceCategories));
    mergeServiceMatrix(providerServiceApiProtocols, provider, routes.ownedEntries(announcement, announcement.serviceApiProtocols));
    mergeServiceMatrix(
      providerServiceUnitBillingModels,
      provider,
      routes.ownedEntries(announcement, announcement.serviceUnitBillingModels),
    );
    mergeServiceMatrix(providerServiceCapabilities, provider, routes.ownedEntries(announcement, announcement.serviceCapabilities));
  }

  return {
    peerId: toPeerId(metadata.peerId.toLowerCase()),
    ...(metadata.displayName ? { displayName: metadata.displayName } : {}),
    ...(metadata.publicAddress ? { publicAddress: metadata.publicAddress } : {}),
    ...(metadata.sellerContract ? { sellerContract: metadata.sellerContract } : {}),
    metadata,
    providers,
    ...(metadata.capabilities?.length ? { capabilities: [...metadata.capabilities] } : {}),
    ...(Object.keys(providerPricing).length ? { providerPricing } : {}),
    ...(Object.keys(providerServiceCategories).length ? { providerServiceCategories } : {}),
    ...(Object.keys(providerServiceApiProtocols).length ? { providerServiceApiProtocols } : {}),
    ...(Object.keys(providerServiceUnitBillingModels).length
      ? { providerServiceUnitBillingModels }
      : {}),
    ...(Object.keys(providerServiceCapabilities).length ? { providerServiceCapabilities } : {}),
    ...(Object.keys(providerServiceHealth).length ? { providerServiceHealth } : {}),
    defaultInputUsdPerMillion: firstProvider?.defaultPricing.inputUsdPerMillion,
    defaultOutputUsdPerMillion: firstProvider?.defaultPricing.outputUsdPerMillion,
    defaultCachedInputUsdPerMillion: firstProvider?.defaultPricing.cachedInputUsdPerMillion,
  };
}

function mergeServiceMatrix<T>(
  target: Record<string, { services: Record<string, T> }>,
  provider: string,
  services: Record<string, T> | undefined,
): void {
  if (!services || Object.keys(services).length === 0) return;
  const existing = target[provider];
  if (existing) Object.assign(existing.services, services);
  else target[provider] = { services: { ...services } };
}

export class SellerSession {
  constructor(
    private readonly client: AntseedWebClient,
    readonly peer: BuyerPeerView,
  ) {}

  /**
   * Send one request through the shared buyer stack: 402 negotiation,
   * NeedAuth signing, retries, and streaming all behave exactly like the
   * node buyer proxy.
   */
  async request(input: RequestInput, callbacks: StreamCallbacks = {}): Promise<SerializedHttpResponse> {
    const req: SerializedHttpRequest = {
      requestId: crypto.randomUUID(),
      method: input.method ?? 'POST',
      path: input.path,
      headers: {
        ...(input.provider ? { 'x-antseed-provider': input.provider } : {}),
        ...input.headers,
      },
      body: typeof input.body === 'string' ? new TextEncoder().encode(input.body) : input.body ?? new Uint8Array(0),
    };
    return this.client.sendRequest(this.peer, req, callbacks);
  }

  close(): void {
    this.client.disconnect(this.peer.peerId);
  }

  /** Ask the seller to settle and release this payment channel. */
  closeChannel(options?: {
    includeAuth?: boolean;
    timeoutMs?: number;
  }): Promise<CloseChannelResultPayload> {
    return this.client.requestChannelClose(this.peer, options);
  }

  /** Start the on-chain timeout path when cooperative close is unavailable. */
  requestOnChainClose(operatorSigner: AbstractSigner): Promise<string> {
    return this.client.requestOnChainClose(this.requireActiveChannel().sessionId, operatorSigner);
  }

  /** Withdraw after the on-chain close grace period. */
  withdrawTimedOutChannel(operatorSigner: AbstractSigner): Promise<string> {
    return this.client.withdrawTimedOutChannel(this.requireActiveChannel().sessionId, operatorSigner);
  }

  private requireActiveChannel(): StoredChannel {
    const channel = this.client.getActiveChannelForPeer(this.peer.peerId);
    if (!channel) throw new Error(`No active payment channel with seller ${this.peer.peerId.slice(0, 12)}...`);
    return channel;
  }
}

function resolveWallet(options: ClientOptions): BuyerSigner {
  const wallet = options.wallet
    ?? (options.privateKey ? signerFromPrivateKey(options.privateKey) : null);
  if (!wallet) throw new Error('provide privateKey or wallet');
  return wallet;
}
