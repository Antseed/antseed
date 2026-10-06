import type { Identity } from "./p2p/identity.js";
import type { PeerId, PeerInfo } from "./types/peer.js";
import type { SerializedHttpRequest, SerializedHttpResponse } from "./types/http.js";
import { ConnectionState } from "./types/connection.js";
import { ConnectionManager, type PeerConnection } from "./p2p/connection-manager.js";
import { getOrOpenOutboundConnection } from "./p2p/outbound-connection.js";
import { FrameDecoder, encodeFrame } from "./p2p/message-protocol.js";
import { KeepaliveManager, buildPongPayload } from "./p2p/keepalive.js";
import { MessageType } from "./types/protocol.js";
import { ProxyMux } from "./proxy/proxy-mux.js";
import { PaymentMux } from "./p2p/payment-mux.js";
import { VerificationMux } from "./verification/verification-mux.js";
import type { VerificationStorage } from "./verification/storage.js";
import type { VerificationSampler } from "./verification/samples.js";
import {
  BuyerFreeUsageManager,
  ChannelStore,
  ChannelsClient,
  DepositsClient,
} from "./payments/index.js";
import { BuyerPaymentManager, type BuyerPaymentConfig } from "./payments/buyer-payment-manager.js";
import { BuyerPaymentNegotiator } from "./payments/buyer-payment-negotiator.js";
import type { SellerAddressResolver } from "./discovery/seller-address-resolver.js";
import type { CloseChannelResultPayload } from "./types/protocol.js";
import {
  BuyerRequestHandler,
  type RequestExecutionOptions,
  type RequestStreamCallbacks,
} from "./buyer-request-handler.js";
import { buyerFault } from "./errors.js";
import { debugWarn } from "./utils/debug.js";

/** The identity loaded from the node's own data dir. */
export const DEFAULT_BUYER_IDENTITY = "default";

const BUYER_IDENTITY_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function isValidBuyerIdentityName(name: string): boolean {
  return BUYER_IDENTITY_NAME_PATTERN.test(name);
}

/** Node-wide services every buyer identity shares. */
export interface BuyerIdentitySharedServices {
  channelStore: ChannelStore | null;
  depositsClient: DepositsClient | null;
  channelsClient: ChannelsClient | null;
  sellerAddressResolver: SellerAddressResolver | null;
  verificationStorage: VerificationStorage | null;
  verificationSampler: VerificationSampler | null;
  /** Capabilities each seller advertised in discovery; not identity-specific. */
  peerCapabilities: Map<PeerId, Set<string>>;
  isChainReachable: () => boolean;
  onChainReadFailure: () => void;
}

export interface BuyerIdentityContextOptions {
  name: string;
  identity: Identity;
  /** Null when payments are disabled; requests then only reach free services. */
  paymentConfig: BuyerPaymentConfig | null;
  freeUsage: {
    chainId: number;
    freeUsageContractAddress: string;
    defaultAuthDurationSecs: number;
    disableMetadataV2Services: boolean;
  } | null;
  requestHandler: {
    requestTimeoutMs?: number;
    maxStreamBufferBytes?: number;
    maxStreamDurationMs?: number;
  };
  maxUploadBodyBytes?: number;
  requireSecureTransport?: boolean;
  shared: BuyerIdentitySharedServices;
  /** Receives payment events, each tagged with this identity's name. */
  emit: (event: string, payload: Record<string, unknown>) => void;
}

/**
 * Buyer state that belongs to one wallet: its authenticated connections to
 * sellers, payment channels and free-usage sessions. Discovery, routing and
 * chain clients live on the node and are shared by every identity, so an
 * extra identity costs connections and channel state, not another node.
 *
 * Sellers see each identity as a separate buyer, exactly as if it ran in its
 * own process: connections are authenticated with the identity's key and
 * channels are funded from its own deposits.
 */
export class BuyerIdentityContext {
  readonly name: string;
  readonly identity: Identity;
  readonly paymentManager: BuyerPaymentManager | null;
  readonly negotiator: BuyerPaymentNegotiator | null;
  readonly freeUsageManager: BuyerFreeUsageManager | null;
  private readonly _handler: BuyerRequestHandler;
  private readonly _muxes = new Map<PeerId, ProxyMux>();
  private readonly _paymentMuxes = new Map<PeerId, PaymentMux>();
  private readonly _verificationMuxes = new Map<PeerId, VerificationMux>();
  private readonly _decoders = new Map<PeerId, FrameDecoder>();
  private readonly _keepalives = new Map<PeerId, KeepaliveManager>();

  private constructor(
    private readonly _options: BuyerIdentityContextOptions,
    private readonly _connectionManager: ConnectionManager,
  ) {
    this.name = _options.name;
    this.identity = _options.identity;
    const { shared } = _options;
    const emitter = {
      emit: (event: string, ...args: unknown[]): boolean => {
        const payload = args[0];
        _options.emit(event, { ...(payload && typeof payload === "object" ? payload : {}), buyerIdentity: this.name });
        return true;
      },
    };

    this.freeUsageManager = _options.freeUsage
      ? new BuyerFreeUsageManager(
        this.identity,
        _options.freeUsage,
        shared.sellerAddressResolver ?? undefined,
        shared.channelStore ?? undefined,
      )
      : null;

    if (_options.paymentConfig && shared.channelStore) {
      this.paymentManager = new BuyerPaymentManager(
        this.identity,
        _options.paymentConfig,
        shared.channelStore,
        shared.sellerAddressResolver ?? undefined,
      );
      this.paymentManager.setSpendListener((event) => emitter.emit("payment:spend", event));
      this.negotiator = new BuyerPaymentNegotiator(
        this.identity,
        this.paymentManager,
        shared.depositsClient,
        shared.channelsClient,
        shared.channelStore,
        { isChainReachable: shared.isChainReachable, onChainReadFailure: shared.onChainReadFailure },
        emitter,
        shared.sellerAddressResolver ?? undefined,
        this.freeUsageManager,
      );
    } else {
      this.paymentManager = null;
      this.negotiator = null;
    }

    this._handler = new BuyerRequestHandler(_options.requestHandler, {
      localPeerId: this.identity.peerId,
      negotiator: this.negotiator,
      freeUsageManager: this.freeUsageManager,
      verificationStorage: shared.verificationStorage,
      verificationSampler: shared.verificationSampler,
      getConnection: (peer) => this.connect(peer as PeerInfo),
      getMux: (peerId, conn) => this._getOrCreateMux(peerId, conn as PeerConnection),
      getVerificationMux: (peerId, conn) => this._getOrCreateVerificationMux(peerId, conn as PeerConnection),
      registerPaymentMux: (peerId, mux) => this._paymentMuxes.set(peerId, mux),
    });
  }

  static async create(options: BuyerIdentityContextOptions): Promise<BuyerIdentityContext> {
    const connectionManager = await ConnectionManager.init(undefined, {
      requireSecureTransport: options.requireSecureTransport,
    });
    connectionManager.setLocalIdentity(options.identity);
    connectionManager.on("error", (err: Error) => {
      debugWarn(`[ConnectionManager:${options.name}] ${err.message}`);
    });
    return new BuyerIdentityContext(options, connectionManager);
  }

  get address(): string {
    return this.identity.wallet.address;
  }

  sendRequest(
    peer: PeerInfo,
    req: SerializedHttpRequest,
    callbacks: RequestStreamCallbacks | undefined,
    options?: RequestExecutionOptions,
  ): Promise<SerializedHttpResponse> {
    return this._handler.sendRequest(peer, req, callbacks, options);
  }

  async connect(peer: PeerInfo): Promise<PeerConnection> {
    const conn = await getOrOpenOutboundConnection(
      this._connectionManager,
      peer,
      this._options.shared.peerCapabilities,
      (opened) => this._wireConnection(opened, peer.peerId),
    );
    this._getOrCreateMux(peer.peerId, conn);
    if (this.negotiator) {
      this._paymentMuxes.set(peer.peerId, this.negotiator.getOrCreatePaymentMux(peer.peerId, conn));
    }
    return conn;
  }

  /** The live connection to a seller, if this identity has one. */
  liveConnection(peerId: PeerId): PeerConnection | null {
    const conn = this._connectionManager.getConnection(peerId);
    if (!conn) return null;
    return conn.state === ConnectionState.Open || conn.state === ConnectionState.Authenticated ? conn : null;
  }

  requestChannelClose(
    peerId: PeerId,
    conn: PeerConnection,
    opts: { includeAuth?: boolean; timeoutMs?: number },
  ): Promise<CloseChannelResultPayload> {
    if (!this.negotiator) throw buyerFault("Buyer payments are not configured on this node", "node-not-started");
    return this.negotiator.requestChannelClose(peerId, conn, opts);
  }

  async stop(): Promise<void> {
    if (this.negotiator) {
      // Let in-transit NeedAuth messages land so sellers can settle what they served.
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      await this.negotiator.drainPendingNeedAuth();
      this.negotiator.cleanup();
    }
    for (const keepalive of this._keepalives.values()) keepalive.stop();
    this._keepalives.clear();
    for (const mux of this._verificationMuxes.values()) mux.close();
    this._verificationMuxes.clear();
    this._muxes.clear();
    this._paymentMuxes.clear();
    this._decoders.clear();
    this._connectionManager.closeAll();
  }

  private _getOrCreateMux(peerId: PeerId, conn: PeerConnection): ProxyMux {
    let mux = this._muxes.get(peerId);
    if (!mux) {
      mux = new ProxyMux(conn, { maxUploadBodyBytes: this._options.maxUploadBodyBytes });
      this._muxes.set(peerId, mux);
    }
    return mux;
  }

  private _getOrCreateVerificationMux(peerId: PeerId, conn: PeerConnection): VerificationMux {
    let mux = this._verificationMuxes.get(peerId);
    if (!mux) {
      mux = new VerificationMux(conn);
      this._verificationMuxes.set(peerId, mux);
    }
    return mux;
  }

  /** Frame dispatch and keepalive for an outbound connection to a seller. */
  private _wireConnection(conn: PeerConnection, peerId: PeerId): void {
    const decoder = new FrameDecoder();
    const isOpen = (): boolean => conn.state === ConnectionState.Open || conn.state === ConnectionState.Authenticated;
    const logFailure = (kind: string) => (err: unknown): void => {
      debugWarn(`[Node:${this.name}] Failed to handle ${kind} frame from ${peerId.slice(0, 12)}...: ${err instanceof Error ? err.message : String(err)}`);
    };

    conn.on("message", (data: Uint8Array) => {
      let frames: ReturnType<typeof decoder.feed>;
      try {
        frames = decoder.feed(data);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        debugWarn(`[Node:${this.name}] Failed to decode frame from ${peerId.slice(0, 12)}...: ${message}`);
        conn.fail(err instanceof Error ? err : new Error(message));
        return;
      }
      const proxyMux = this._muxes.get(peerId);
      const paymentMux = this._paymentMuxes.get(peerId);
      const verificationMux = this._verificationMuxes.get(peerId);
      for (const frame of frames) {
        if (frame.type === MessageType.Ping) {
          if (isOpen()) {
            conn.send(encodeFrame({ type: MessageType.Pong, messageId: frame.messageId, payload: buildPongPayload(frame.payload) }));
          }
        } else if (frame.type === MessageType.Pong) {
          this._keepalives.get(peerId)?.handlePong(frame.payload);
        } else if (paymentMux && PaymentMux.isPaymentMessage(frame.type)) {
          paymentMux.handleFrame(frame).catch(logFailure("payment"));
        } else if (verificationMux && VerificationMux.isVerificationMessage(frame.type)) {
          verificationMux.handleFrame(frame).catch(logFailure("verification"));
        } else if (proxyMux) {
          proxyMux.handleFrame(frame).catch((err: unknown) => {
            logFailure("proxy")(err);
            conn.fail(err instanceof Error ? err : new Error(String(err)));
          });
        }
      }
    });
    this._decoders.set(peerId, decoder);

    conn.on("stateChange", (state: ConnectionState) => {
      if (state !== ConnectionState.Closed && state !== ConnectionState.Failed) return;
      // A reconnect may already have replaced this connection's session.
      if (this._decoders.get(peerId) !== decoder) return;
      this._keepalives.get(peerId)?.stop();
      this._keepalives.delete(peerId);
      this._muxes.get(peerId)?.abortPendingUploads();
      this._muxes.delete(peerId);
      this._paymentMuxes.delete(peerId);
      this._verificationMuxes.get(peerId)?.close();
      this._verificationMuxes.delete(peerId);
      this._decoders.delete(peerId);
      this.negotiator?.onPeerDisconnect(peerId);
      this.freeUsageManager?.onPeerDisconnect(peerId);
    });

    const keepalive = new KeepaliveManager({
      sendPing: (payload: Uint8Array) => {
        if (isOpen()) conn.send(encodeFrame({ type: MessageType.Ping, messageId: 0, payload }));
      },
      onDead: () => {
        if (!isOpen()) return;
        debugWarn(`[Node:${this.name}] Keepalive timeout for ${peerId.slice(0, 12)}...`);
        conn.fail(new Error("Keepalive timeout"));
      },
    });
    this._keepalives.get(peerId)?.stop();
    this._keepalives.set(peerId, keepalive);
    keepalive.start();
  }
}
