import { EventEmitter } from "node:events";
import { homedir } from "node:os";
import { join } from "node:path";
import { IDENTITY_HISTORY_TTL_MS, IdentityHistoryCollector } from './reputation/identity-history.js';
import { computeTrustScore } from './reputation/trust-score.js';
import { TrustSignalsClient } from './payments/evm/trust-signals-client.js';

import type { Identity, IdentityStore } from "./p2p/identity.js";
import { loadOrCreateIdentity } from "./p2p/identity.js";
import type { PeerId } from "./types/peer.js";
import type { PeerInfo, PeerVerificationResults, TokenPricingUsdPerMillion } from "./types/peer.js";
import { peerIdToAddress } from "./types/peer.js";
import type { ServiceUnitBillingModelsV1 } from "./types/billing.js";
import type {
  SerializedHttpRequest,
  SerializedHttpResponse,
} from "./types/http.js";
import type { ConnectionConfig } from "./types/connection.js";
import { MeteringStorage } from "./metering/storage.js";
import { ReceiptGenerator } from "./metering/receipt-generator.js";
import {
  SellerSessionTracker,
  type SellerSessionSnapshot,
} from "./metering/seller-session-tracker.js";
import { ConnectionState } from "./types/connection.js";
import {
  DHTNode,
  DEFAULT_DHT_CONFIG,
  SUBNET_COUNT,
  type DHTNodeConfig,
} from "./discovery/dht-node.js";
import { toBootstrapConfig, OFFICIAL_BOOTSTRAP_NODES, mergeBootstrapNodes } from "./discovery/bootstrap.js";
import {
  ConnectionManager,
  PeerConnection,
} from "./p2p/connection-manager.js";
import {
  PeerAnnouncer,
  type AnnouncerConfig,
  type SellerContractConfig,
} from "./discovery/announcer.js";
import type { PeerVerifications } from "./discovery/peer-metadata.js";
import { verifyPeerMetadataDomains } from "./discovery/domain-verification.js";
import { verifyPeerMetadataGithub } from "./discovery/github-verification.js";
import {
  PeerLookup,
  DEFAULT_LOOKUP_CONFIG,
  type LookupConfig,
  type LookupResult,
} from "./discovery/peer-lookup.js";
import { HttpMetadataResolver } from "./discovery/http-metadata-resolver.js";
import { ProxyMux } from "./proxy/proxy-mux.js";
import { PaymentMux } from "./p2p/payment-mux.js";
import { SweepMux } from "./p2p/sweep-mux.js";
import { VerificationMux } from "./verification/verification-mux.js";
import { DepositRelayer } from "./payments/deposit-relayer.js";
import type { UsageAttribution } from "./payments/evm/signatures.js";
import {
  CONNECTION_CAPABILITY_RELAYS_SWEEPS_V1,
  CONNECTION_CAPABILITY_COOPERATIVE_CLOSE_V1,
  CONNECTION_CAPABILITY_WEBRTC_V1,
  peerSupportsCooperativeClose,
  type SweepRequestPayload,
  type SweepReceiptPayload,
  type CloseChannelResultPayload,
} from "./types/protocol.js";
import { VerificationStorage } from "./verification/storage.js";
import { VerificationSampler } from "./verification/samples.js";
import { FrameDecoder, encodeFrame } from "./p2p/message-protocol.js";
import { KeepaliveManager, buildPongPayload } from "./p2p/keepalive.js";
import { MessageType } from "./types/protocol.js";
import type {
  Provider,
  ProviderStreamCallbacks,
} from "./interfaces/seller-provider.js";
import type { Router } from "./interfaces/buyer-router.js";
import type { Prover } from "./interfaces/plugin.js";
import { NatTraversal } from "./p2p/nat-traversal.js";
import { signUtf8 } from "./p2p/identity.js";
import {
  BalanceManager,
  type PaymentConfig,
  type PaymentMethod,
  DepositsClient,
  ChannelsClient,
  FreeUsageClient,
  BuyerFreeUsageManager,
  SellerFreeUsageManager,
  SellerFreeTierLimiter,
  type SellerFreeTierConfig,
  StakingClient,
  ChannelStore,
  CHANNEL_KIND,
  CHANNEL_ROLE,
  CHANNEL_STATUS,
} from "./payments/index.js";
import { debugLog, debugWarn } from "./utils/debug.js";
import { parsePublicAddress } from "./discovery/public-address.js";
import { sanitizePeerDisplayName } from "./discovery/display-name.js";
import { BuyerPaymentManager, type BuyerPaymentConfig } from "./payments/buyer-payment-manager.js";
import { BuyerPaymentNegotiator } from "./payments/buyer-payment-negotiator.js";
import { RpcHealthMonitor, type RpcHealthStatus } from "./payments/rpc-health.js";
import { SellerAddressResolver } from "./discovery/seller-address-resolver.js";
import { Contract as EthersContract } from "ethers";
import { SellerPaymentManager, type SellerPaymentConfig } from "./payments/seller-payment-manager.js";
import { IdentityClient } from "./payments/evm/identity-client.js";
import { SellerRequestHandler } from "./seller-request-handler.js";
import {
  BuyerRequestHandler,
  type RequestStreamCallbacks,
  type RequestStreamResponseMetadata,
  type RequestExecutionOptions,
} from "./buyer-request-handler.js";
import {
  buildSybilContext,
  computeOnChainSybilRisk,
  type SybilContext,
} from "./reputation/sybil-risk.js";
import { buyerFault } from "./errors.js";

/** Store the trust score on the peer; leaves the fields untouched when the peer is unscored. */
function applyTrust(peer: PeerInfo): void {
  const trust = computeTrustScore(peer);
  if (!trust) return;
  peer.trust = trust;
  peer.onChainReputationScore = trust.score;
}

export type { Provider, ProviderStreamCallbacks };
export type { Router };
export type { BuyerPaymentConfig };
export type { SellerSessionSnapshot };
export type { RequestStreamCallbacks, RequestStreamResponseMetadata, RequestExecutionOptions };

export type BuyerChannelSummary = {
  channelId: string;
  peerId: string;
  seller: string;
  buyer: string;
  /** Latest in-memory ReserveAuth ceiling. Null when it is not available. */
  reserveCeiling: string | null;
  /** Latest cumulative SpendingAuth amount persisted in the channel store. */
  cumulativeSigned: string;
  /** Final locally observed settlement amount, when the channel is finished. */
  settledAmount: string | null;
  deadline: number;
  reservedAt: number;
  /** Last local cumulative usage/auth update for this channel. */
  updatedAt: number;
  status: string;
  requestCount: number;
  tokensDelivered: string;
  outputTokens: string;
};

export interface NodePaymentsConfig {
  /** Enable seller-side payment channels and automatic settlement. */
  enabled?: boolean;
  /** Payment method used for settlement. Default: "crypto" */
  paymentMethod?: PaymentMethod;
  /** Platform fee rate in [0,1]. Default: 0.05 */
  platformFeeRate?: number;
  /** Idle time before calling settle() to collect earnings (channel stays open). Default: 10 min. */
  settlementIdleMs?: number;
  /** Idle time before calling close() to end the channel entirely. Default: 12 hours. */
  closeIdleMs?: number;
  /** Default deposit amount in USDC units. Default: "1" */
  defaultDepositAmountUSDC?: string;
  /** Optional seller wallet address for auto-funded deposit. */
  sellerWalletAddress?: string;
  /** Settlement backend configuration (crypto). */
  paymentConfig?: PaymentConfig | null;
  /** Base JSON-RPC URL (e.g. http://127.0.0.1:8545 for anvil) */
  rpcUrl?: string;
  /** Additional RPC endpoints for transparent failover via ethers FallbackProvider (quorum=1). */
  fallbackRpcUrls?: string[];
  /** Deployed AntseedDeposits contract address */
  depositsAddress?: string;
  /** Deployed AntseedChannels contract address */
  channelsAddress?: string;
  /** Optional deployed AntseedFreeUsage contract address */
  freeUsageAddress?: string;
  /** USDC token contract address */
  usdcAddress?: string;
  /** ERC-8004 IdentityRegistry contract address */
  identityRegistryAddress?: string;
  /** AntseedSellerRegistry (or legacy AntseedStaking) contract address: seller → agent id. */
  stakingAddress?: string;
  /** AntseedSellerPools contract address (buyer trust score: pool staking power). */
  sellerPoolsAddress?: string;
  /** AntseedUsageAccounting contract address (buyer trust score: recognized usage per epoch). */
  usageAccountingAddress?: string;
  /** AntseedWashTradingRegistry contract address (buyer trust score: proven wash traders). */
  washTradingRegistryAddress?: string;
  /** Chain ID for EIP-712 domain. Default: 8453 (Base) */
  chainId?: number;
  /** Default maximum USDC per spending auth. Default: 500000 ($0.50) */
  defaultMaxAmountUsdc?: string;
  /** Default auth duration in seconds. Default: 90000 */
  defaultAuthDurationSecs?: number;
  /** Minimum USDC per request (base units) for seller. Default: "10000" ($0.01). */
  minBudgetPerRequest?: string;
  /** Minimum unsettled delta (base units) required before idle settle submits a tx. Default: "2000" (~$0.002). */
  minSettleDelta?: string;
  /** Serve channels whose buyer already requested close on-chain, risking uncollectible work. Default: false. */
  serveWhileClosePending?: boolean;
  /** Optional seller-side slack for estimate-only reserve preflight checks. Unset disables estimate-only rejection. */
  reserveEstimateOverdraftUsdc?: string;
  /** Maximum USDC the buyer authorizes per single request (base units). Default: "500000" ($0.50). */
  maxPerRequestUsdc?: string;
  /** Maximum total USDC the buyer will reserve in a single SpendingAuth (base units). Default: "10000000" ($10.00). */
  maxReserveAmountUsdc?: string;
  /** Disable per-service buyer attribution in metadata v2. Default: false. */
  disableMetadataV2Services?: boolean;
  /** Deployed AntseedDepositRelay contract address (gasless deposit sweeps). */
  depositRelayAddress?: string;
  /** Deployed AntseedReferrals contract address (emission-funded referral rewards). */
  referralsAddress?: string;
  /**
   * Buyer-side attribution appended to every signed SpendingAuth / FreeUsage
   * metadata blob: the referrer wallet (bound on-chain by AntseedStats on the
   * buyer's first settlement) and the bytes32 client id of this software.
   */
  attribution?: UsageAttribution;
}

export interface NodeRelayerConfig {
  /** Relay buyer deposit sweeps with the seller wallet. Default: true (opt-out). */
  enabled?: boolean;
  /** Minimum acceptable profit (FEE - estimated gas cost) in USDC base units.
   *  May be negative to relay at a loss (local testing). Default: "0". */
  minProfitBaseUnits?: string;
  /** Max concurrent sweep submissions. Default: 2. */
  maxInFlight?: number;
  /** Max sweep requests accepted per peer per minute. Default: 6. */
  maxPerPeerPerMinute?: number;
}

export interface NodeVerificationConfig {
  /** Random sample rate for storing full buyer request/response evidence. Default: 0.005. */
  sampleRate?: number;
  /** Maximum combined encoded request + response bytes per sample. Default: 16 MiB. */
  maxSampleBytes?: number;
  /** Optional directory for verification samples. Default: <dataDir>/verification_samples. */
  samplesDir?: string;
}

export interface NodeConfig {
  role: 'seller' | 'buyer';
  displayName?: string;
  /** Publicly reachable seller address override ("host:port") announced in metadata. */
  publicAddress?: string;
  /** External ownership claims announced in signed peer metadata. */
  verifications?: PeerVerifications;
  /** Extra peer capability strings to advertise (e.g. supported verifier SDKs). */
  capabilities?: string[];
  /** Refuse plaintext TCP and unsigned SDP in both directions. Default false (legacy peers fall back to plaintext). */
  requireSecureTransport?: boolean;
  dataDir?: string;           // Default: ~/.antseed
  dhtPort?: number;           // Default: 6881 for seller, 0 for buyer
  signalingPort?: number;     // Default: 6882 for seller
  bootstrapNodes?: Array<{ host: string; port: number }>;
  requestTimeoutMs?: number;  // Default: 300000
  /** Timeout in ms for each HTTP metadata fetch during peer discovery. Default: 1500 */
  metadataFetchTimeoutMs?: number;
  /** Maximum buffered body size (bytes) while reconstructing streaming responses. Default: 16 MiB. */
  maxStreamBufferBytes?: number;
  /** Maximum upload body size (bytes) a seller will accept per request. Default: 64 MiB. */
  maxUploadBodyBytes?: number;
  /** Maximum wall time allowed for a streaming response. Default: 30 minutes. */
  maxStreamDurationMs?: number;
  /** Allow private/loopback IPs in DHT lookups. Default: false. Set true for local testing. */
  allowPrivateIPs?: boolean;
  /** Use only the provided bootstrapNodes and skip the official public DHT nodes. Default: false.
   *  Set true for isolated local testing where official nodes must not be contacted. */
  noOfficialBootstrap?: boolean;
  /** Override the DHT operation timeout in ms. Defaults to DEFAULT_DHT_CONFIG.operationTimeoutMs. */
  dhtOperationTimeoutMs?: number;
  /** Optional seller-side payment runtime wiring. */
  payments?: NodePaymentsConfig;
  /** Optional per-address request limit for zero-priced seller services. */
  freeTier?: SellerFreeTierConfig;
  /** Seller-side deposit-sweep relayer settings (opt-out, ON by default). */
  relayer?: NodeRelayerConfig;
  /** Optional buyer-side verification storage and sampling settings. */
  verification?: NodeVerificationConfig;
  /** Pluggable identity storage backend. When set, takes precedence over dataDir for identity loading. */
  identityStore?: IdentityStore;
  /** Optional explicit config.json path for runtime config reloads. */
  configPath?: string;
  /**
   * Optional on-chain seller contract (e.g. DiemStakingProxy). When set, the
   * announcer publishes it in metadata; buyers verify the binding by calling
   * `sellerContract.isOperator(peerAddress)`.
   */
  sellerContract?: SellerContractConfig;
}

export interface BuyerUsageChannelPoint {
  reservedAt: number;
  updatedAt: number;
  requestCount: number;
  inputTokens: string;
  outputTokens: string;
}

/** Per-service usage summed across all buyer channels (paid + free).
    `serviceIdHash` is keccak256(serviceName) — see getServiceMetadataId. */
export interface BuyerUsageServicePoint {
  serviceIdHash: string;
  amountUsdc: string;
  inputTokens: string;
  cachedInputTokens: string;
  outputTokens: string;
  requestCount: number;
}

export interface BuyerUsageTotals {
  totalRequests: number;
  totalInputTokens: string;
  totalOutputTokens: string;
  totalSettlements: number;
  uniqueSellers: number;
  activeChannels: number;
  channels: BuyerUsageChannelPoint[];
  services: BuyerUsageServicePoint[];
}

const EMPTY_BUYER_USAGE: BuyerUsageTotals = {
  totalRequests: 0,
  totalInputTokens: '0',
  totalOutputTokens: '0',
  totalSettlements: 0,
  uniqueSellers: 0,
  activeChannels: 0,
  channels: [],
  services: [],
};

const EXTERNAL_VERIFICATION_RESULT_TTL_MS = IDENTITY_HISTORY_TTL_MS;

/** How long one relayer gets exclusive first refusal on a sweep offer before
 *  it passes to the next candidate. The relayer replies 'submitted' right
 *  after its local checks + one Base RPC simulation (~1-2s on healthy RPCs),
 *  so a peer that hasn't answered in 3s isn't going to win the deposit —
 *  move on. */
const DEFAULT_SWEEP_OFFER_TIMEOUT_MS = 3_000;
/** Don't offer a sweep whose authorization expires too soon to safely land —
 *  mirrors MIN_REMAINING_VALIDITY_SECS in the seller-side relayer. */
const MIN_SWEEP_DISPATCH_VALIDITY_SECS = 30;

export class AntseedNode extends EventEmitter {
  private _config: NodeConfig;
  private _identity: Identity | null = null;
  private _dht: DHTNode | null = null;
  private _connectionManager: ConnectionManager | null = null;
  private _providers: Provider[] = [];
  private _provers: Prover[] = [];
  private _router: Router | null = null;
  private _started = false;
  private _announcer: PeerAnnouncer | null = null;
  /** Set while advertising is paused (e.g. seller wallet out of gas). */
  private _advertisingPausedReason: string | null = null;
  private _peerLookup: PeerLookup | null = null;
  private _muxes = new Map<PeerId, ProxyMux>();
  private _decoders = new Map<PeerId, FrameDecoder>();
  private _keepalives = new Map<PeerId, KeepaliveManager>();
  private _nat: NatTraversal | null = null;
  private _metering: MeteringStorage | null = null;
  private _receiptGenerator: ReceiptGenerator | null = null;
  private _balanceManager: BalanceManager | null = null;
  private _depositsClient: DepositsClient | null = null;
  private _channelsClient: ChannelsClient | null = null;
  private _freeUsageClient: FreeUsageClient | null = null;
  private _buyerFreeUsageManager: BuyerFreeUsageManager | null = null;
  private _sellerFreeUsageManager: SellerFreeUsageManager | null = null;
  private _stakingClient: StakingClient | null = null;
  /** Batched reader for the on-chain inputs of the buyer trust score. */
  private _trustSignalsClient: TrustSignalsClient | null = null;
  private _sellerAddressResolver: SellerAddressResolver | null = null;
  private _identityClient: IdentityClient | null = null;
  private _paymentMuxes = new Map<PeerId, PaymentMux>();
  private _verificationMuxes = new Map<PeerId, VerificationMux>();
  private _sweepMuxes = new Map<PeerId, SweepMux>();
  private _peerCapabilities = new Map<PeerId, Set<string>>();
  /** Seller-side deposit-sweep relayer (initialized when configured + enabled). */
  private _depositRelayer: DepositRelayer | null = null;
  /** Seller-side request handler (provider matching, execution, load tracking). */
  private _sellerHandler: SellerRequestHandler | null = null;
  /** Buyer-side payment manager (initialized when buyer has payment config). */
  private _buyerPaymentManager: BuyerPaymentManager | null = null;
  /** Buyer-side payment negotiation (402 handling, SpendingAuth, cost tracking). */
  private _buyerNegotiator: BuyerPaymentNegotiator | null = null;
  /** Background chain-RPC reachability monitor (created when payments are configured). */
  private _rpcHealth: RpcHealthMonitor | null = null;
  /** Buyer-side request execution (streaming, timeouts, 402 retry). */
  private _buyerHandler: BuyerRequestHandler | null = null;
  /** Seller-side payment manager (initialized when seller has payment config). */
  private _sellerPaymentManager: SellerPaymentManager | null = null;
  /** Shared channel store for payment persistence. */
  private _channelStore: ChannelStore | null = null;
  /** Buyer-side response authentication storage. */
  private _verificationStorage: VerificationStorage | null = null;
  /** Buyer-side plaintext evidence sampler for verified response auths. */
  private _verificationSampler: VerificationSampler | null = null;
  /** Periodic timeout checker interval. */
  private _timeoutCheckerInterval: ReturnType<typeof setInterval> | null = null;
  /** Block cursor for CloseRequested event polling. */
  private _closeRequestedFromBlock: number = 0;
  /** Seller session lifecycle tracking (metering, settlement). */
  private _sessionTracker: SellerSessionTracker | null = null;
  /** Buyer-side background full discovery sweep, if one is running. */
  private _backgroundPeerDiscoveryPromise: Promise<PeerInfo[]> | null = null;
  /** Serializes non-blocking on-chain enrichment for incrementally discovered peers. */
  private _partialPeerEnrichmentChain: Promise<void> = Promise.resolve();
  /** Serializes non-blocking external claim verification for discovered peers. */
  private _externalVerificationChain: Promise<void> = Promise.resolve();
  private _identityHistoryCollector: IdentityHistoryCollector | undefined;
  private _externalVerificationCache = new Map<PeerId, {
    claimsKey: string;
    checkedAtMs: number;
    results: PeerVerificationResults;
  }>();
  private _externalVerificationInFlight = new Set<string>();

  constructor(config: NodeConfig) {
    super();
    this._config = config;
  }

  get peerId(): string | null {
    return this._identity?.peerId ?? null;
  }

  get identity(): Identity | null {
    return this._identity;
  }

  registerProvider(provider: Provider): void {
    this._providers.push(provider);
  }

  /**
   * Re-sign the advertised seller metadata snapshot without a DHT announce.
   * Call after mutating a provider's `services` at runtime (e.g. when the
   * model health checker unadvertises or restores a service) so the next
   * `GET /metadata` fetch reflects the change immediately.
   */
  async refreshSellerMetadata(): Promise<void> {
    await this._announcer?.refreshMetadata();
  }

  /**
   * Stop announcing this seller to the DHT and re-sign the metadata snapshot
   * with zero providers, so buyers stop discovering a peer that cannot
   * actually serve (e.g. its wallet has no ETH to fund settlement). The
   * `/metadata` endpoint reflects the pause immediately; already-published
   * DHT entries age out on the buyer's staleness cutoff.
   */
  async pauseAdvertising(reason: string): Promise<void> {
    this._advertisingPausedReason = reason;
    this._announcer?.stopPeriodicAnnounce();
    await this._announcer?.refreshMetadata();
  }

  /** Resume DHT announcements after `pauseAdvertising` (announces immediately). */
  resumeAdvertising(): void {
    if (this._advertisingPausedReason === null) return;
    this._advertisingPausedReason = null;
    this._announcer?.startPeriodicAnnounce();
  }

  /** Why advertising is currently paused, or null when advertising normally. */
  get advertisingPausedReason(): string | null {
    return this._advertisingPausedReason;
  }

  /** Register an embedded verifier prover (serves reserved attestation requests). */
  registerProver(prover: Prover): void {
    this._provers.push(prover);
  }

  setRouter(router: Router): void {
    this._router = router;
  }

  get router(): Router | null {
    return this._router;
  }

  /** Buyer-side payment manager (null if payments not enabled or not in buyer mode). */
  get buyerPaymentManager(): BuyerPaymentManager | null {
    return this._buyerPaymentManager;
  }

  /** Buyer-side payment negotiator (null if payments not configured for buyer). */
  get buyerNegotiator(): BuyerPaymentNegotiator | null {
    return this._buyerNegotiator;
  }

  /**
   * Live payments status for control planes and UIs. Payments stay enabled
   * while the chain RPC is unreachable — buyer authorization is signed
   * off-chain — so `rpc.state` is a health signal, not an on/off switch.
   */
  getPaymentsStatus(): {
    configured: boolean;
    buyerActive: boolean;
    sellerActive: boolean;
    chainId: number | null;
    rpc: RpcHealthStatus | null;
  } {
    const payments = this._config.payments;
    return {
      configured: payments?.enabled === true,
      buyerActive: this._buyerNegotiator !== null,
      sellerActive: this._sellerPaymentManager !== null,
      chainId: payments?.chainId ?? null,
      rpc: this._rpcHealth?.status() ?? null,
    };
  }

  /** Actual DHT port after binding (0 means not started). */
  get dhtPort(): number {
    return this._dht?.getPort() ?? 0;
  }

  /** DHT routing-table size — stays 0 when UDP is blocked or there is no internet. */
  get dhtNodeCount(): number {
    return this._dht?.getNodeCount() ?? 0;
  }

  /** Actual signaling/connection port after binding (0 means not started). */
  get signalingPort(): number {
    return this._connectionManager?.getListeningPort() ?? 0;
  }

  /** ERC-8004 IdentityRegistry client (null if not configured). */
  get identityClient(): IdentityClient | null {
    return this._identityClient;
  }

  /** AntseedFreeUsage client (null if not configured). */
  get freeUsageClient(): FreeUsageClient | null {
    return this._freeUsageClient;
  }

  /** Buyer-side free usage manager (null if free usage is not configured). */
  get buyerFreeUsageManager(): BuyerFreeUsageManager | null {
    return this._buyerFreeUsageManager;
  }

  /** Seller-side free usage manager (null if free usage is not configured). */
  get sellerFreeUsageManager(): SellerFreeUsageManager | null {
    return this._sellerFreeUsageManager;
  }

  /** Current connection state for a peer if a connection exists, otherwise null. */
  getPeerConnectionState(peerId: PeerId): ConnectionState | null {
    return this._connectionManager?.getConnection(peerId)?.state ?? null;
  }

  /**
   * Active seller sessions currently tracked in-memory.
   * Includes open sessions before they are finalized/settled.
   */
  getActiveSellerSessions(): SellerSessionSnapshot[] {
    return this._sessionTracker?.getActiveSessions() ?? [];
  }

  /** Number of active in-memory seller channels that are not currently settling. */
  getActiveSellerChannelCount(): number {
    return this._sessionTracker?.getActiveChannelCount() ?? 0;
  }

  async start(): Promise<void> {
    if (this._started) {
      throw new Error("Node already started");
    }

    const dataDir = this._config.dataDir ?? join(homedir(), ".antseed");

    // Load or create identity
    this._identity = await loadOrCreateIdentity(this._config.identityStore ?? dataDir);
    debugLog(`[Node] Identity loaded: ${this._identity.peerId.slice(0, 12)}...`);

    // Determine bootstrap nodes — merge official + any user-configured nodes unless
    // noOfficialBootstrap is set (e.g. isolated local testing).
    const bootstrapNodes = toBootstrapConfig(
      this._config.noOfficialBootstrap
        ? (this._config.bootstrapNodes ?? [])
        : mergeBootstrapNodes(OFFICIAL_BOOTSTRAP_NODES, this._config.bootstrapNodes ?? [])
    );
    debugLog(`[Node] Starting as ${this._config.role} with ${bootstrapNodes.length} bootstrap node(s)`);

    if (this._config.role === "seller") {
      await this._startSeller(bootstrapNodes);
    } else {
      await this._startBuyer(bootstrapNodes);
    }

    this._started = true;
    debugLog(`[Node] Started successfully`);
    this.emit("started");
  }

  async stop(): Promise<void> {
    if (!this._started) {
      return;
    }

    // Give in-transit NeedAuth messages time to arrive on the DataChannel,
    // then wait for their handlers to finish. This ensures the seller has a
    // valid SpendingAuth for settlement before we close the connection.
    if (this._buyerNegotiator) {
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
      await this._buyerNegotiator.drainPendingNeedAuth();
    }

    // End all active buyer payment sessions before shutdown
    if (this._buyerNegotiator) {
      this._buyerNegotiator.cleanup();
    }
    if (this._rpcHealth) {
      this._rpcHealth.stop();
      this._rpcHealth = null;
    }
    if (this._sellerFreeUsageManager) {
      await this._sellerFreeUsageManager.flushAllPendingRecords();
    }

    if (this._sessionTracker) {
      await this._sessionTracker.finalizeAllSessions("node-stop");
      this._sessionTracker.clearTimers();
    }
    if (this._sellerHandler) {
      this._sellerHandler.clearMetadataRefreshTimer();
      this._sellerHandler = null;
    }

    // Remove NAT port mappings
    if (this._nat) {
      await this._nat.cleanup();
      this._nat = null;
    }

    // Stop announcer
    if (this._announcer) {
      this._announcer.stopPeriodicAnnounce();
      this._announcer = null;
    }

    // Stop all keepalive managers
    for (const keepalive of this._keepalives.values()) {
      keepalive.stop();
    }
    this._keepalives.clear();

    // Close all proxy muxes
    this._muxes.clear();
    this._paymentMuxes.clear();
    this._peerCapabilities.clear();
    for (const verificationMux of this._verificationMuxes.values()) {
      verificationMux.close();
    }
    this._verificationMuxes.clear();
    this._decoders.clear();

    // Close all connections
    if (this._connectionManager) {
      this._connectionManager.closeAll();
      this._connectionManager = null;
    }

    // Stop DHT
    if (this._dht) {
      await this._dht.stop();
      this._dht = null;
    }

    if (this._balanceManager) {
      try {
        const dataDir = this._config.dataDir ?? join(homedir(), ".antseed");
        await this._balanceManager.save(join(dataDir, "payments"));
      } catch (err) {
        debugWarn(`[Node] Failed to persist payment balances: ${err instanceof Error ? err.message : err}`);
      }
    }

    if (this._metering) {
      try {
        this._metering.close();
      } catch {
        // ignore close errors
      }
      this._metering = null;
    }

    if (this._verificationStorage) {
      try {
        this._verificationStorage.close();
      } catch {
        // ignore close errors
      }
      this._verificationStorage = null;
    }
    this._verificationSampler = null;

    if (this._timeoutCheckerInterval) {
      clearInterval(this._timeoutCheckerInterval);
      this._timeoutCheckerInterval = null;
    }

    if (this._channelStore) {
      try {
        this._channelStore.close();
      } catch {
        // ignore close errors
      }
      this._channelStore = null;
    }

    this._peerLookup = null;
    this._receiptGenerator = null;
    this._balanceManager = null;
    this._depositsClient = null;
    this._channelsClient = null;
    this._freeUsageClient = null;
    this._buyerFreeUsageManager = null;
    this._sellerFreeUsageManager = null;
    this._stakingClient = null;
    this._trustSignalsClient = null;
    this._identityClient = null;
    this._sellerAddressResolver = null;
    this._buyerPaymentManager = null;
    this._buyerNegotiator = null;
    this._buyerHandler = null;
    this._backgroundPeerDiscoveryPromise = null;
    this._sellerPaymentManager = null;
    this._sessionTracker = null;
    this._started = false;
    this.emit("stopped");
  }

  async discoverPeers(service?: string): Promise<PeerInfo[]> {
    if (!this._peerLookup) {
      throw buyerFault("Node not started or not in buyer mode", "node-not-started");
    }

    debugLog(`[Node] Discovering peers (service: "${service ?? "*"}")...`);
    debugLog(`[Node] Discovery plan: wildcard warmup + budgeted sequential subnet shard lookups (${SUBNET_COUNT} total) + parallel metadata resolve; exhaustive sweep continues in background`);

    // Always enumerate via subnet+wildcard. Service filtering is metadata
    // driven — announcing per-service DHT topics did O(services) work per
    // reannounce cycle, recreated the K-closest saturation problem on every
    // popular service infohash, and was already an opportunistic optimisation
    // (the production proxy never used it; the CLI always re-filtered
    // metadata-side anyway). The signed metadata document carries the full
    // service catalog, so we filter against that after enumeration.
    const results = await this._peerLookup.findAll();
    debugLog(`[Node] DHT returned ${results.length} foreground result(s)`);
    this._startBackgroundPeerDiscoverySweep();
    return this._lookupResultsToPeerInfos(results, service);
  }

  private async _lookupResultsToPeerInfos(results: LookupResult[], service?: string): Promise<PeerInfo[]> {
    // Deduplicate by peerId (DHT can return the same peer from multiple topic lookups)
    const seen = new Set<string>();
    const peers: PeerInfo[] = [];
    for (const r of results) {
      const p = this._lookupResultToPeerInfo(r);
      if (!seen.has(p.peerId)) {
        seen.add(p.peerId);
        peers.push(p);
      }
    }

    const filtered = service ? peers.filter((p) => peerOffersService(p, service)) : peers;
    this._attachCachedExternalVerificationResults(filtered);
    this._queueExternalVerification(filtered);

    // On-chain enrichment runs after the metadata filter so we don't waste
    // RPC calls on peers we'll discard.
    await this._enrichPeersWithOnChainStats(filtered);

    for (const p of filtered) {
      debugLog(`[Node]   peer ${p.peerId.slice(0, 12)}... providers=[${p.providers.join(",")}] addr=${p.publicAddress ?? "?"}`);
    }
    return filtered;
  }

  startBackgroundPeerDiscoverySweep(): void {
    this._startBackgroundPeerDiscoverySweep();
  }

  private _startBackgroundPeerDiscoverySweep(): void {
    if (!this._peerLookup || this._backgroundPeerDiscoveryPromise) {
      return;
    }
    const peerLookup = this._peerLookup;
    const emittedPeerIds = new Set<string>();
    debugLog(`[Node] Starting background exhaustive peer discovery sweep`);
    this._backgroundPeerDiscoveryPromise = (async () => {
      const results = await peerLookup.findAllExhaustive(async (partialResults, context) => {
        if (partialResults.length === 0) return;
        const peers: PeerInfo[] = [];
        for (const result of partialResults) {
          const peer = this._lookupResultToPeerInfo(result);
          if (emittedPeerIds.has(peer.peerId)) continue;
          emittedPeerIds.add(peer.peerId);
          peers.push(peer);
        }
        if (peers.length === 0) return;
        debugLog(
          `[Node] Background DHT partial ${context.phase}`
          + `${context.subnet !== undefined ? ` ${context.subnet}/${SUBNET_COUNT - 1}` : ""}`
          + ` emitted ${peers.length} peer(s) from ${context.endpointCount} endpoint(s)`,
        );
        this._attachCachedExternalVerificationResults(peers);
        this.emit("peers:discovered", peers);
        this._queueExternalVerification(peers);
        this._queuePartialPeerEnrichment(peers);
      });
      debugLog(`[Node] Background DHT sweep returned ${results.length} result(s)`);
      const peers = await this._lookupResultsToPeerInfos(results);
      this.emit("peers:discovered", peers);
      return peers;
    })().catch((err) => {
      debugWarn(`[Node] Background DHT sweep failed: ${err instanceof Error ? err.message : err}`);
      return [];
    }).finally(() => {
      this._backgroundPeerDiscoveryPromise = null;
    });
  }

  private _queuePartialPeerEnrichment(peers: PeerInfo[]): void {
    if (peers.length === 0 || !this._trustSignalsClient) {
      return;
    }
    const peersToEnrich = peers;
    this._partialPeerEnrichmentChain = this._partialPeerEnrichmentChain.then(async () => {
      if (!this._started || !this._trustSignalsClient) {
        return;
      }
      await this._enrichPeersWithOnChainStats(peersToEnrich);
      if (!this._started) {
        return;
      }
      const enriched = peersToEnrich.filter((peer) => typeof peer.onChainStatsFetchedAt === "number");
      if (enriched.length === 0) {
        return;
      }
      debugLog(`[Node] Background DHT partial on-chain enrichment emitted ${enriched.length} peer(s)`);
      this.emit("peers:discovered", enriched);
    }).catch((err) => {
      debugWarn(`[Node] Background DHT partial on-chain enrichment failed: ${err instanceof Error ? err.message : err}`);
    });
  }

  private _attachCachedExternalVerificationResults(peers: PeerInfo[]): void {
    const nowMs = Date.now();
    for (const peer of peers) {
      const claimsKey = this._externalVerificationClaimsKey(peer);
      if (!claimsKey) continue;
      const cached = this._externalVerificationCache.get(peer.peerId);
      if (
        cached
        && cached.claimsKey === claimsKey
        && nowMs - cached.checkedAtMs < EXTERNAL_VERIFICATION_RESULT_TTL_MS
      ) {
        peer.verificationResults = cached.results;
      }
    }
  }

  private _queueExternalVerification(peers: PeerInfo[]): void {
    const queued: PeerInfo[] = [];
    const nowMs = Date.now();
    for (const peer of peers) {
      if (this._externalVerificationInFlight.size >= 512) break;
      const claimsKey = this._externalVerificationClaimsKey(peer);
      if (!claimsKey) continue;
      const cacheKey = `${peer.peerId}:${claimsKey}`;
      if (this._externalVerificationInFlight.has(cacheKey)) continue;
      const cached = this._externalVerificationCache.get(peer.peerId);
      if (
        cached
        && cached.claimsKey === claimsKey
        && nowMs - cached.checkedAtMs < EXTERNAL_VERIFICATION_RESULT_TTL_MS
      ) {
        continue;
      }
      this._externalVerificationInFlight.add(cacheKey);
      queued.push(peer);
    }
    if (queued.length === 0) return;

    this._externalVerificationChain = this._externalVerificationChain.then(async () => {
      if (!this._started) return;
      const verifiedPeers = await this._verifyExternalClaimsForPeers(queued);
      if (!this._started || verifiedPeers.length === 0) return;
      debugLog(`[Node] External verification emitted ${verifiedPeers.length} peer update(s)`);
      this.emit("peers:discovered", verifiedPeers);
    }).catch((err) => {
      debugWarn(`[Node] External verification failed: ${err instanceof Error ? err.message : err}`);
    }).finally(() => {
      for (const peer of queued) {
        const claimsKey = this._externalVerificationClaimsKey(peer);
        if (claimsKey) {
          this._externalVerificationInFlight.delete(`${peer.peerId}:${claimsKey}`);
        }
      }
    });
  }

  private async _verifyExternalClaimsForPeers(peers: PeerInfo[]): Promise<PeerInfo[]> {
    const queue = peers.slice();
    const verifiedPeers: PeerInfo[] = [];
    const EXTERNAL_VERIFICATION_CONCURRENCY = 2;
    const workers = Array.from({ length: Math.min(EXTERNAL_VERIFICATION_CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        const peer = queue.shift();
        if (!peer) return;
        const verified = await this._verifyExternalClaimsForPeer(peer);
        if (verified) {
          verifiedPeers.push(verified);
        }
      }
    });
    await Promise.all(workers);
    return verifiedPeers;
  }

  private async _verifyExternalClaimsForPeer(peer: PeerInfo): Promise<PeerInfo | null> {
    const metadata = peer.metadata;
    const claimsKey = this._externalVerificationClaimsKey(peer);
    if (!metadata || !claimsKey) return null;

    try {
      const [domains, github] = await Promise.all([
        verifyPeerMetadataDomains(metadata),
        verifyPeerMetadataGithub(metadata),
      ]);
      const checkedAtMs = Date.now();
      const allResults = [...domains, ...github];
      const results: PeerVerificationResults = {
        verified: allResults.length > 0 && allResults.every((result) => result.verified),
        checkedAtMs,
        domains,
        github,
      };
      this._identityHistoryCollector ??= new IdentityHistoryCollector();
      results.identityHistory = await this._identityHistoryCollector.collect(results);
      if (this._externalVerificationCache.size >= 512) {
        this._externalVerificationCache.delete(this._externalVerificationCache.keys().next().value!);
      }
      this._externalVerificationCache.set(peer.peerId, {
        claimsKey,
        checkedAtMs,
        results,
      });
      peer.verificationResults = results;
      applyTrust(peer);
      return peer;
    } catch (err) {
      debugWarn(`[Node] External verification failed for ${peer.peerId.slice(0, 12)}...: ${err instanceof Error ? err.message : err}`);
      return null;
    }
  }

  private _externalVerificationClaimsKey(peer: PeerInfo): string | null {
    const verifications = peer.metadata?.verifications;
    const domainCount = verifications?.domains?.length ?? 0;
    const githubCount = verifications?.github?.length ?? 0;
    if (domainCount + githubCount === 0) return null;
    return JSON.stringify({
      domains: verifications?.domains ?? [],
      github: verifications?.github ?? [],
    });
  }

  /**
   * Look up a single peer by its peerId via the per-peer DHT topic.
   * Much cheaper and more deterministic than walking the wildcard topic:
   * one infohash lookup, return the first endpoint that serves matching
   * signed metadata. Falls back to wildcard discovery for compatibility with
   * old sellers that do not announce per-peer topics yet.
   * Returns `null` if the peer is not currently announcing
   * (or if its metadata is stale / signature-invalid).
   *
   * The returned `PeerInfo` is on-chain-enriched the same way `discoverPeers`
   * enriches its results, so volume / last-settled / ghost counts are
   * available when chain RPC is configured.
   */
  async findPeer(peerId: string, options?: { awaitExternalVerification?: boolean }): Promise<PeerInfo | null> {
    if (!this._peerLookup) {
      throw buyerFault("Node not started or not in buyer mode", "node-not-started");
    }
    const normalized = peerId.trim().toLowerCase().replace(/^0x/, "");
    if (!/^[0-9a-f]{40}$/.test(normalized)) {
      return null;
    }

    debugLog(`[Node] findPeer(${normalized.slice(0, 12)}...) via per-peer DHT topic`);
    let results = await this._peerLookup.findByPeerId(normalized);
    if (results.length === 0) {
      debugLog(`[Node]   per-peer topic empty; falling back to wildcard scan`);
      results = (await this._peerLookup.findAll()).filter(
        (r) => r.metadata.peerId.toLowerCase() === normalized,
      );
      if (results.length === 0) {
        debugLog(`[Node]   wildcard fallback empty; not found`);
        return null;
      }
    }

    // Multiple endpoints can legitimately announce for the same peerId
    // (multi-homed seller). The lookup already filtered to those whose
    // served metadata matches the id; pick the freshest by timestamp.
    const best = results.reduce((acc, r) =>
      r.metadata.timestamp > acc.metadata.timestamp ? r : acc,
    );
    const peer = this._lookupResultToPeerInfo(best);
    this._attachCachedExternalVerificationResults([peer]);
    if (options?.awaitExternalVerification && !peer.verificationResults && this._externalVerificationClaimsKey(peer)) {
      await this._verifyExternalClaimsForPeer(peer);
    } else {
      this._queueExternalVerification([peer]);
    }
    await this._enrichPeersWithOnChainStats([peer]);
    return peer;
  }

  /**
   * Verify claimed on-chain stats against actual contract data, and
   * populate volume / last-settled which are never announced by sellers.
   *
   * Concurrency is capped so a wildcard DHT lookup returning hundreds of
   * peers doesn't fan out into hundreds of simultaneous eth_calls (resolver
   * isOperator + getAgentId + getAgentStats per peer). Most RPC endpoints
   * will rate-limit past ~10-20 concurrent calls; we stay well under that.
   *
   * Mutates the supplied peers in place. No-op when chain clients aren't
   * configured — callers can safely invoke this regardless.
   */
  private async _enrichPeersWithOnChainStats(peers: PeerInfo[]): Promise<void> {
    const client = this._trustSignalsClient;
    if (!client || peers.length === 0) {
      return;
    }
    const resolver = this._sellerAddressResolver;
    // Every stale peer is read in one batched pass (two Multicall3 round
    // trips), so the refresh interval bounds RPC usage per discovery cycle
    // instead of the peer count.
    const ON_CHAIN_STATS_TTL_MS = 120_000;
    const nowMs = Date.now();
    const peersWithCompleteStats = new Set<PeerInfo>();
    const stale: Array<{ peer: PeerInfo; address: string }> = [];
    for (const p of peers) {
      if (typeof p.onChainStatsFetchedAt === 'number' && nowMs - p.onChainStatsFetchedAt < ON_CHAIN_STATS_TTL_MS) {
        peersWithCompleteStats.add(p);
        continue;
      }
      try {
        const address = resolver
          ? await resolver.resolveSellerAddress(p.peerId, p.metadata)
          : peerIdToAddress(p.peerId);
        stale.push({ peer: p, address });
      } catch {
        // Unresolvable seller address: leave the previous snapshot in place.
      }
    }
    if (stale.length === 0) {
      this._applyTrust(peers, peersWithCompleteStats);
      return;
    }
    let signals: Awaited<ReturnType<TrustSignalsClient['read']>>;
    try {
      signals = await client.read(stale.map((entry) => entry.address));
    } catch (err) {
      debugWarn(`[Node] On-chain trust signal read failed: ${err instanceof Error ? err.message : err}`);
      this._applyTrust(peers, peersWithCompleteStats);
      return;
    }
    for (const { peer: p, address } of stale) {
      const read = signals.get(address);
      // A peer without an agent id (or a failed batch entry) keeps its
      // previous complete snapshot, or stays unenriched when newly discovered.
      if (!read) continue;
      p.onChainAgentId = read.agentId;
      if (read.channelCount !== undefined) p.onChainChannelCount = read.channelCount;
      if (read.ghostCount !== undefined) p.onChainGhostCount = read.ghostCount;
      if (read.totalVolumeUsdcMicros !== undefined) p.onChainTotalVolumeUsdcMicros = read.totalVolumeUsdcMicros;
      if (read.lastSettledAtSec !== undefined) p.onChainLastSettledAtSec = read.lastSettledAtSec;
      if (read.usageEpoch !== undefined) {
        p.onChainUsageEpoch = read.usageEpoch;
        p.onChainUsageShareBps = read.usageShareBps;
        p.onChainUsageLastEpochUsdcMicros = read.usageLastEpochUsdcMicros;
      }
      if (read.poolStakeAnts !== undefined) p.onChainPoolStakeAnts = read.poolStakeAnts;
      if (read.poolPowerShareBps !== undefined) p.onChainPoolPowerShareBps = read.poolPowerShareBps;
      if (read.washFlagged !== undefined) p.onChainWashFlagged = read.washFlagged;
      if (read.washShareBps !== undefined) p.onChainWashShareBps = read.washShareBps;
      p.onChainStatsFetchedAt = Date.now();
      peersWithCompleteStats.add(p);
    }
    this._applyTrust(peers, peersWithCompleteStats);
  }

  /** Recompute the trust score and the display-only sybil heuristic. */
  private _applyTrust(peers: PeerInfo[], peersToUpdate?: ReadonlySet<PeerInfo>): void {
    if (peers.length === 0) return;
    const ctx: SybilContext | undefined = peers.length >= 2
      ? buildSybilContext(peers)
      : undefined;
    for (const p of peers) {
      if (peersToUpdate && !peersToUpdate.has(p)) continue;
      if (ctx && typeof p.onChainChannelCount === 'number') {
        const sybil = computeOnChainSybilRisk(p, ctx);
        p.onChainSybilRisk = sybil.risk;
        p.onChainSybilFlags = sybil.flags;
      }
      applyTrust(p);
    }
  }

  /**
   * Eagerly open a connection to a peer and wire up the mux.
   * Subsequent sendRequest / sendRequestStream calls will reuse this connection.
   */
  async connectToPeer(peer: PeerInfo): Promise<void> {
    const conn = await this._getOrCreateConnection(peer);
    this._getOrCreateMux(peer.peerId, conn);
    const negotiator = this._buyerNegotiator;
    if (negotiator) {
      this._paymentMuxes.set(peer.peerId, negotiator.getOrCreatePaymentMux(peer.peerId, conn));
    }
  }

  /**
   * Ask a seller to close our payment channel with it right now, releasing the
   * reserved deposit without the on-chain `requestClose()` → 15-minute grace →
   * `withdraw()` round trip.
   *
   * The seller refuses while it is still serving (or still owed for) requests
   * on that channel; those refusals come back as `{ status: 'rejected', code }`
   * rather than as exceptions. Only a missing session, a peer we can't reach,
   * or an unanswered request throws.
   *
   * By default the buyer attaches its latest SpendingAuth so a seller that lost
   * the last one can still close at the full amount owed; the seller settles at
   * whichever cumulative is higher.
   */
  async requestChannelClose(
    sellerPeerId: string,
    opts: { includeAuth?: boolean; timeoutMs?: number } = {},
  ): Promise<CloseChannelResultPayload> {
    const negotiator = this._buyerNegotiator;
    if (!negotiator) {
      throw new Error('Buyer payments are not configured on this node');
    }
    if (!this._connectionManager) {
      throw new Error('Node not started');
    }

    const peerId = sellerPeerId as PeerId;
    let conn = this._connectionManager.getConnection(peerId);
    if (!conn || (conn.state !== ConnectionState.Open && conn.state !== ConnectionState.Authenticated)) {
      const peer = await this.findPeer(sellerPeerId);
      if (!peer) {
        throw new Error(
          `Seller ${sellerPeerId.slice(0, 12)}... is not connected and could not be found on the network. ` +
          `A cooperative close needs the seller online — otherwise use the on-chain request-close flow.`,
        );
      }
      await this.connectToPeer(peer);
      conn = this._connectionManager.getConnection(peer.peerId);
      if (!conn) {
        throw new Error(`Failed to establish a connection to seller ${sellerPeerId.slice(0, 12)}...`);
      }
    }

    // A seller that predates this feature drops the 0x59 frame silently, so
    // without this the buyer would wait out the full 60s response timeout and
    // get a vague "did not answer". Note the capability must come from the
    // peer's discovery metadata (`_peerCapabilities`), not
    // `conn.hasRemoteCapability` — the latter is only populated for *inbound*
    // connections, so on the buyer's own outbound connection it is always
    // empty and would reject every close.
    const capabilities = this._peerCapabilities.get(peerId);
    if (capabilities && capabilities.size > 0
      && !peerSupportsCooperativeClose({ capabilities: [...capabilities] })) {
      throw new Error(
        `Seller ${sellerPeerId.slice(0, 12)}... does not support cooperative close ` +
        `(missing ${CONNECTION_CAPABILITY_COOPERATIVE_CLOSE_V1}). ` +
        `Use the on-chain request-close flow instead.`,
      );
    }

    return negotiator.requestChannelClose(peerId, conn, opts);
  }

  /**
   * Query session stats for a specific seller peer.
   * Combines channel store data (authoritative payment/session info) with
   * metering events when available.
   */
  getMeteringStatsByPeer(sellerPeerId: string): {
    // Current session
    totalRequests: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    reservedUsdc: string | null;
    consumedUsdc: string | null;
    channelStatus: string | null;
    reservedAt: number | null;
    // Lifetime totals (across all sessions with this peer)
    lifetimeSessions: number;
    lifetimeRequests: number;
    lifetimeInputTokens: number;
    lifetimeOutputTokens: number;
    lifetimeTotalTokens: number;
    lifetimeAuthorizedUsdc: string;
    lifetimeFirstSessionAt: number | null;
    lifetimeLastSessionAt: number | null;
  } | null {
    const buyerAddress = this._identity?.wallet.address ?? null;
    const channel = (buyerAddress != null)
      ? (
        this._channelStore?.getActiveChannelByPeerAndBuyer(sellerPeerId, CHANNEL_ROLE.BUYER, buyerAddress)
        ?? this._channelStore?.getLatestChannelByPeerAndBuyer(sellerPeerId, CHANNEL_ROLE.BUYER, buyerAddress)
      )
      : (
        this._channelStore?.getActiveChannelByPeer(sellerPeerId, CHANNEL_ROLE.BUYER)
        ?? this._channelStore?.getLatestChannel(sellerPeerId, CHANNEL_ROLE.BUYER)
      )
      ?? null;

    const lifetime = (buyerAddress != null)
      ? this._channelStore?.getTotalsByPeerAndBuyer(sellerPeerId, CHANNEL_ROLE.BUYER, buyerAddress)
      : this._channelStore?.getTotalsByPeer(sellerPeerId, CHANNEL_ROLE.BUYER)
      ?? null;

    const liveTotals = this._buyerPaymentManager?.getResponseTokenTotals(sellerPeerId);
    const inputTokens = (liveTotals != null) ? liveTotals.input
      : (channel != null) ? Number(channel.tokensDelivered || '0')
      : 0;
    const outputTokens = (liveTotals != null) ? liveTotals.output
      : (channel != null) ? Number(channel.previousConsumption || '0')
      : 0;

    return {
      totalRequests: channel?.requestCount ?? 0,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      reservedUsdc: this._buyerPaymentManager?.getReserveCeiling(sellerPeerId)?.toString() ?? null,
      consumedUsdc: channel?.authMax ?? null,
      channelStatus: channel?.status ?? null,
      reservedAt: channel?.reservedAt ?? null,
      lifetimeSessions: lifetime?.totalSessions ?? 0,
      lifetimeRequests: lifetime?.totalRequests ?? 0,
      lifetimeInputTokens: lifetime?.totalInputTokens ?? 0,
      lifetimeOutputTokens: lifetime?.totalOutputTokens ?? 0,
      lifetimeTotalTokens: (lifetime?.totalInputTokens ?? 0) + (lifetime?.totalOutputTokens ?? 0),
      lifetimeAuthorizedUsdc: (lifetime?.totalAuthorizedUsdc ?? 0n).toString(),
      lifetimeFirstSessionAt: lifetime?.firstSessionAt ?? null,
      lifetimeLastSessionAt: lifetime?.lastSessionAt ?? null,
    };
  }

  /**
   * Return active buyer-side channels for the current identity's EVM address.
   * Combines the persistent ChannelStore (session metadata + cumulative signed
   * amount) with the in-memory reserve ceiling tracked by BuyerPaymentManager.
   *
   * The ReserveAuth ceiling lives only in the payment manager. When it is not
   * available, return null rather than substituting the unrelated cumulative
   * SpendingAuth amount stored in authMax.
   */
  getActiveBuyerChannels(): BuyerChannelSummary[] {
    const buyerAddress = this._identity?.wallet.address ?? null;
    if (!buyerAddress || !this._channelStore) return [];
    const stored = this._channelStore.getActiveChannelsByBuyer(CHANNEL_ROLE.BUYER, buyerAddress);
    return stored.map((c) => {
      const liveReserve = this._buyerPaymentManager?.getReserveCeiling(c.peerId);
      return {
        channelId: c.sessionId,
        peerId: c.peerId,
        seller: c.sellerEvmAddr,
        buyer: c.buyerEvmAddr,
        reserveCeiling: liveReserve != null && liveReserve > 0n ? liveReserve.toString() : null,
        cumulativeSigned: c.authMax,
        settledAmount: c.settledAmount,
        deadline: c.deadline,
        reservedAt: c.reservedAt,
        updatedAt: c.updatedAt,
        status: c.status,
        requestCount: c.requestCount,
        tokensDelivered: c.tokensDelivered,
        // Buyer rows overload previousConsumption as cumulative output tokens
        // (see getBuyerUsageTotals).
        outputTokens: c.previousConsumption,
      };
    });
  }

  /** All buyer channels (any local status), used for history views. */
  getAllBuyerChannels(): BuyerChannelSummary[] {
    const buyerAddress = this._identity?.wallet.address ?? null;
    if (!buyerAddress || !this._channelStore) return [];
    const stored = this._channelStore.getAllChannelsByBuyer('buyer', buyerAddress);
    return stored.map((c) => {
      const liveReserve = c.status === CHANNEL_STATUS.ACTIVE
        ? this._buyerPaymentManager?.getReserveCeiling(c.peerId)
        : null;
      return {
        channelId: c.sessionId,
        peerId: c.peerId,
        seller: c.sellerEvmAddr,
        buyer: c.buyerEvmAddr,
        reserveCeiling: liveReserve != null && liveReserve > 0n ? liveReserve.toString() : null,
        cumulativeSigned: c.authMax,
        settledAmount: c.settledAmount,
        deadline: c.deadline,
        reservedAt: c.reservedAt,
        updatedAt: c.updatedAt,
        status: c.status,
        requestCount: c.requestCount,
        tokensDelivered: c.tokensDelivered,
        // Buyer rows overload previousConsumption as cumulative output tokens
        // (see getBuyerUsageTotals).
        outputTokens: c.previousConsumption,
      };
    });
  }

  /**
   * On buyer rows in payment_channels, `tokensDelivered` stores cumulative
   * input tokens and `previousConsumption` stores cumulative output tokens —
   * columns are semantically overloaded vs seller rows. Set in
   * buyer-payment-manager.recordAndPersistTokens.
   */
  getBuyerUsageTotals(): BuyerUsageTotals {
    const buyerAddress = this._identity?.wallet.address ?? null;
    if (!buyerAddress || !this._channelStore) return EMPTY_BUYER_USAGE;
    // Paid channels plus free-usage sessions — both carry real traffic and
    // the desktop usage tiles/float must reflect the sum.
    const stored = [
      ...this._channelStore.getAllChannelsByBuyer('buyer', buyerAddress),
      ...this._channelStore.getAllChannelsByBuyer('buyer', buyerAddress, CHANNEL_KIND.FREE),
    ];
    let totalRequests = 0;
    let totalInput = 0n;
    let totalOutput = 0n;
    let totalSettlements = 0;
    let activeChannels = 0;
    const sellers = new Set<string>();
    const channels: BuyerUsageChannelPoint[] = [];
    for (const c of stored) {
      totalRequests += c.requestCount;
      try { totalInput += BigInt(c.tokensDelivered || '0'); } catch { /* skip */ }
      try { totalOutput += BigInt(c.previousConsumption || '0'); } catch { /* skip */ }
      // Settlement/active-channel counters describe paid channels only —
      // free sessions never settle and can't be closed from the UI.
      if (c.channelKind !== CHANNEL_KIND.FREE) {
        if (c.status === CHANNEL_STATUS.SETTLED) totalSettlements += 1;
        if (c.status === CHANNEL_STATUS.ACTIVE) activeChannels += 1;
      }
      if (c.peerId) sellers.add(c.peerId);
      channels.push({
        reservedAt: c.reservedAt,
        updatedAt: c.updatedAt,
        requestCount: c.requestCount,
        inputTokens: c.tokensDelivered || '0',
        outputTokens: c.previousConsumption || '0',
      });
    }
    // Per-service usage (model attribution for the desktop savings tile).
    // Documented as lower bounds — requests that raced NeedAuth may lack
    // service attribution, so Σ services ≤ channel totals.
    const services = this._channelStore.getBuyerServiceUsageTotals(buyerAddress).map((s) => ({
      serviceIdHash: s.serviceId,
      amountUsdc: s.amountUsdc,
      inputTokens: s.inputTokens,
      cachedInputTokens: s.cachedInputTokens,
      outputTokens: s.outputTokens,
      requestCount: s.requestCount,
    }));
    return {
      totalRequests,
      totalInputTokens: totalInput.toString(),
      totalOutputTokens: totalOutput.toString(),
      totalSettlements,
      uniqueSellers: sellers.size,
      activeChannels,
      channels,
      services,
    };
  }

  async sendRequest(
    peer: PeerInfo,
    req: SerializedHttpRequest,
    options?: RequestExecutionOptions,
  ): Promise<SerializedHttpResponse> {
    if (!this._buyerHandler) throw buyerFault("Node not started or not in buyer mode", "node-not-started");
    return this._buyerHandler.sendRequest(peer, req, undefined, options);
  }

  async sendRequestStream(
    peer: PeerInfo,
    req: SerializedHttpRequest,
    callbacks: RequestStreamCallbacks,
    options?: RequestExecutionOptions,
  ): Promise<SerializedHttpResponse> {
    if (!this._buyerHandler) throw buyerFault("Node not started or not in buyer mode", "node-not-started");
    return this._buyerHandler.sendRequest(peer, req, callbacks, options);
  }

  private _createDHTConfig(port: number, bootstrapNodes: Array<{ host: string; port: number }>): DHTNodeConfig {
    return {
      peerId: this._identity!.peerId,
      port,
      bootstrapNodes,
      reannounceIntervalMs: DEFAULT_DHT_CONFIG.reannounceIntervalMs,
      operationTimeoutMs: this._config.dhtOperationTimeoutMs ?? DEFAULT_DHT_CONFIG.operationTimeoutMs,
      allowPrivateIPs: this._config.allowPrivateIPs,
    };
  }

  private _wireConnection(conn: PeerConnection, peerId: PeerId): void {
    const decoder = new FrameDecoder();
    conn.on("message", (data: Uint8Array) => {
      let frames: ReturnType<typeof decoder.feed>;
      try {
        frames = decoder.feed(data);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        debugWarn(`[Node] Failed to decode frame from ${peerId.slice(0, 12)}...: ${message}`);
        conn.fail(err instanceof Error ? err : new Error(message));
        return;
      }
      const proxyMux = this._muxes.get(peerId);
      const paymentMux = this._paymentMuxes.get(peerId);
      const verificationMux = this._verificationMuxes.get(peerId);
      const sweepMux = this._sweepMuxes.get(peerId);
      for (const frame of frames) {
        // Keepalive: respond to Ping, dispatch Pong to manager
        if (frame.type === MessageType.Ping) {
          if (conn.state === ConnectionState.Open || conn.state === ConnectionState.Authenticated) {
            conn.send(encodeFrame({
              type: MessageType.Pong,
              messageId: frame.messageId,
              payload: buildPongPayload(frame.payload),
            }));
          }
          continue;
        }
        if (frame.type === MessageType.Pong) {
          this._keepalives.get(peerId)?.handlePong(frame.payload);
          continue;
        }
        if (paymentMux && PaymentMux.isPaymentMessage(frame.type)) {
          paymentMux.handleFrame(frame).catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            debugWarn(`[Node] Failed to handle payment frame from ${peerId.slice(0, 12)}...: ${message}`);
          });
        } else if (verificationMux && VerificationMux.isVerificationMessage(frame.type)) {
          verificationMux.handleFrame(frame).catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            debugWarn(`[Node] Failed to handle verification frame from ${peerId.slice(0, 12)}...: ${message}`);
          });
        } else if (sweepMux && SweepMux.isSweepMessage(frame.type)) {
          sweepMux.handleFrame(frame).catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            debugWarn(`[Node] Failed to handle sweep frame from ${peerId.slice(0, 12)}...: ${message}`);
          });
        } else if (proxyMux) {
          proxyMux.handleFrame(frame).catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            debugWarn(`[Node] Failed to handle frame from ${peerId.slice(0, 12)}...: ${message}`);
            conn.fail(err instanceof Error ? err : new Error(message));
          });
        }
      }
    });

    this._decoders.set(peerId, decoder);

    conn.on("stateChange", (state: ConnectionState) => {
      if (state === ConnectionState.Closed || state === ConnectionState.Failed) {
        // Guard against stale close events: if a reconnect arrived before this
        // connection finished closing, a new decoder will have been registered.
        // Wiping the maps would evict the live session, so bail out early.
        if (this._decoders.get(peerId) !== decoder) return;
        // Stop keepalive for this peer
        this._keepalives.get(peerId)?.stop();
        this._keepalives.delete(peerId);
        // Flush any in-progress chunked uploads so buffers are not leaked
        this._muxes.get(peerId)?.abortPendingUploads();
        this._muxes.delete(peerId);
        this._paymentMuxes.delete(peerId);
        this._peerCapabilities.delete(peerId);
        this._verificationMuxes.get(peerId)?.close();
        this._verificationMuxes.delete(peerId);
        this._sweepMuxes.delete(peerId);
        this._decoders.delete(peerId);
        // Clean up buyer-side payment state on disconnect
        this._buyerNegotiator?.onPeerDisconnect(peerId);
        this._buyerFreeUsageManager?.onPeerDisconnect(peerId);
        this._sellerFreeUsageManager?.onPeerDisconnect(peerId);
        // Handle buyer disconnect (seller side)
        if (this._sellerPaymentManager) {
          this._sellerPaymentManager.onBuyerDisconnect(peerId);
        }
        if (this._sessionTracker) {
          void this._sessionTracker.finalizeSession(peerId, "disconnect");
        }
      }
    });

    // Start keepalive pings on outbound (buyer-initiated) connections to
    // detect dead peers proactively instead of waiting for a request to fail.
    if (conn.isInitiator) {
      const keepalive = new KeepaliveManager({
        sendPing: (payload: Uint8Array) => {
          if (conn.state === ConnectionState.Open || conn.state === ConnectionState.Authenticated) {
            conn.send(encodeFrame({
              type: MessageType.Ping,
              messageId: 0,
              payload,
            }));
          }
        },
        onDead: () => {
          if (conn.state !== ConnectionState.Open && conn.state !== ConnectionState.Authenticated) return;
          debugWarn(`[Node] Keepalive timeout for ${peerId.slice(0, 12)}...`);
          conn.fail(new Error("Keepalive timeout"));
        },
      });
      this._keepalives.get(peerId)?.stop();
      this._keepalives.set(peerId, keepalive);
      keepalive.start();
    }
  }

  private async _startSeller(bootstrapNodes: Array<{ host: string; port: number }>): Promise<void> {
    const identity = this._identity!;
    const dhtPort = this._config.dhtPort ?? 6881;
    const signalingPort = this._config.signalingPort ?? 6882;
    debugLog(`[Node] Starting seller — DHT port=${dhtPort}, signaling port=${signalingPort}`);

    const dataDir = this._config.dataDir ?? join(homedir(), ".antseed");
    try {
      this._metering = new MeteringStorage(join(dataDir, "metering.db"));
      debugLog("[Node] Metering storage initialized");
    } catch (err) {
      debugWarn(`[Node] Metering storage unavailable: ${err instanceof Error ? err.message : err}`);
    }

    if (this._metering) {
      this._receiptGenerator = new ReceiptGenerator({
        peerId: identity.peerId,
        sign: (message: string) => signUtf8(identity.wallet, message),
      });
    }

    // Initialize seller session tracker
    this._sessionTracker = new SellerSessionTracker(
      identity,
      this._metering,
      this._receiptGenerator,
      { settlementIdleMs: this._config.payments?.settlementIdleMs, closeIdleMs: this._config.payments?.closeIdleMs },
      {
        onSessionUpdated: (snapshot) => this.emit("session:updated", snapshot),
        onSessionFinalized: (info) => this.emit("session:finalized", info),
      },
    );

    await this._initializePayments(dataDir);
    this._warnIfFreeUsageMeteringUnavailable();

    // Wire idle session events to on-chain settlement
    if (this._sellerPaymentManager) {
      const spm = this._sellerPaymentManager;
      this.on("session:finalized", (info: { buyerPeerId: string; reason: string }) => {
        if (info.reason === "idle-settle") {
          debugLog(`[Node] Idle settle for buyer ${info.buyerPeerId.slice(0, 12)}... — settling channel (keeping open)`);
          void spm.settleSession(info.buyerPeerId, { settleOnly: true });
        } else if (info.reason === "idle-timeout") {
          debugLog(`[Node] Idle timeout for buyer ${info.buyerPeerId.slice(0, 12)}... — closing channel`);
          void spm.settleSession(info.buyerPeerId, { cleanupOnFailure: true });
        }
      });
    }

    // Start DHT
    this._dht = new DHTNode(this._createDHTConfig(dhtPort, bootstrapNodes));
    await this._dht.start();

    // Create ConnectionManager and start listening
    this._connectionManager = await ConnectionManager.init(undefined, {
      requireSecureTransport: this._config.requireSecureTransport,
    });
    this._connectionManager.setLocalIdentity(identity);
    this._connectionManager.on("error", (err: Error) => {
      debugWarn(`[ConnectionManager] ${err.message}`);
    });
    await this._connectionManager.startListening({
      peerId: identity.peerId,
      port: signalingPort,
      host: "0.0.0.0",
    });

    // Resolve actual bound port (important when port 0 is used for OS-assigned)
    const actualSignalingPort = this._connectionManager.getListeningPort() ?? signalingPort;
    const actualDhtPort = this._dht.getPort();

    // NAT traversal: automatically map ports via UPnP/NAT-PMP
    this._nat = new NatTraversal();
    const natResult = await this._nat.mapPorts([
      { port: actualSignalingPort, protocol: "TCP" },
      { port: actualDhtPort, protocol: "UDP" },
    ]);

    if (natResult.success) {
      this.emit("nat:mapped", natResult);
    } else {
      debugWarn("[NAT] UPnP/NAT-PMP mapping failed — seller may not be reachable from the internet");
      debugWarn("[NAT] Ensure port forwarding is configured manually, or peers on the same LAN can still connect");
      this.emit("nat:failed");
    }

    // Set up announcer for providers
    if (this._providers.length > 0) {
      const extraCapabilities = [
        ...(this._connectionManager.supportsWebRtc ? [CONNECTION_CAPABILITY_WEBRTC_V1] : []),
        ...(this._config.capabilities ?? []),
      ];
      const announcerConfig: AnnouncerConfig = {
        identity,
        dht: this._dht,
        providers: this._providers.map((p) => ({
          provider: p.name,
          services: p.services,
          ...(p.serviceCategories ? { serviceCategories: { ...p.serviceCategories } } : {}),
          ...(p.serviceApiProtocols ? { serviceApiProtocols: { ...p.serviceApiProtocols } } : {}),
          ...(p.serviceUnitBillingModels ? { serviceUnitBillingModels: { ...p.serviceUnitBillingModels } } : {}),
          ...(p.serviceCapabilities ? { serviceCapabilities: { ...p.serviceCapabilities } } : {}),
          maxConcurrency: p.maxConcurrency,
          isAvailable: () => this._advertisingPausedReason === null && p.healthCheckAvailable !== false,
          pricing: {
            defaults: {
              inputUsdPerMillion: p.pricing.defaults.inputUsdPerMillion,
              outputUsdPerMillion: p.pricing.defaults.outputUsdPerMillion,
            },
            ...(p.pricing.services ? { services: { ...p.pricing.services } } : {}),
          },
        })),
        ...(this._config.displayName ? { displayName: this._config.displayName } : {}),
        ...(this._config.publicAddress ? { publicAddress: this._config.publicAddress } : {}),
        ...(this._config.verifications ? { verifications: this._config.verifications } : {}),
        ...(extraCapabilities.length > 0 ? { capabilities: extraCapabilities } : {}),
        region: "unknown",
        pricing: new Map(
          this._providers.map((p) => [
            p.name,
            {
              defaults: {
                inputUsdPerMillion: p.pricing.defaults.inputUsdPerMillion,
                outputUsdPerMillion: p.pricing.defaults.outputUsdPerMillion,
              },
              ...(p.pricing.services ? { services: { ...p.pricing.services } } : {}),
            },
          ]),
        ),
        reannounceIntervalMs: DEFAULT_DHT_CONFIG.reannounceIntervalMs,
        signalingPort: actualSignalingPort,
        ...(this._channelsClient ? { channelsClient: this._channelsClient } : {}),
        ...(this._stakingClient ? { stakingClient: this._stakingClient, paymentsEnabled: true } : {}),
        ...(this._config.sellerContract ? { sellerContract: this._config.sellerContract } : {}),
        ...(this._depositRelayer ? { relaysSweeps: true } : {}),
      };
      this._announcer = new PeerAnnouncer(announcerConfig);
      this._announcer.startPeriodicAnnounce();

      // Serve metadata on the signaling port (HTTP requests are auto-detected)
      this._connectionManager!.setMetadataProvider(
        () => this._announcer?.getLatestMetadata() ?? null,
      );
    }

    const sellerFreeTierLimiter = this._config.freeTier
      ? new SellerFreeTierLimiter(this._config.freeTier, this._metering)
      : null;
    if (sellerFreeTierLimiter) {
      debugLog(`[Node] Seller free tier enabled: ${sellerFreeTierLimiter.describe()}`);
      if (!this._metering) {
        debugWarn('[Node] Seller free-tier limits are using in-memory accounting because metering storage is unavailable; counters reset on restart.');
      }
    }

    // Create seller request handler
    this._sellerHandler = new SellerRequestHandler({
      identity,
      providers: this._providers,
      provers: this._provers,
      sellerPaymentManager: this._sellerPaymentManager,
      sellerFreeUsageManager: this._sellerFreeUsageManager,
      sellerFreeTierLimiter,
      sessionTracker: this._sessionTracker,
      channelsClient: this._channelsClient,
      announcer: this._announcer,
      maxUploadBodyBytes: this._config.maxUploadBodyBytes,
      ...(this._config.payments?.reserveEstimateOverdraftUsdc != null
        ? { reserveEstimateOverdraftUsdc: BigInt(this._config.payments.reserveEstimateOverdraftUsdc) }
        : {}),
      emit: (event, ...args) => this.emit(event, ...args),
    });

    // Listen for incoming connections
    this._connectionManager.on("connection", (conn: PeerConnection) => {
      this._handleIncomingConnection(conn);
    });

    debugLog(`[Node] Seller ready — announcing ${this._providers.length} provider(s)`);
  }

  private async _startBuyer(bootstrapNodes: Array<{ host: string; port: number }>): Promise<void> {
    const identity = this._identity!;
    const dhtPort = this._config.dhtPort ?? 0;
    debugLog(`[Node] Starting buyer — DHT port=${dhtPort}`);

    const dataDir = this._config.dataDir ?? join(homedir(), ".antseed");
    this._initializeVerificationStorage(dataDir);
    await this._initializePayments(dataDir);

    // Start DHT with ephemeral port
    this._dht = new DHTNode(this._createDHTConfig(dhtPort, bootstrapNodes));
    await this._dht.start();

    // Create ConnectionManager for outbound connections
    this._connectionManager = await ConnectionManager.init(undefined, {
      requireSecureTransport: this._config.requireSecureTransport,
    });
    this._connectionManager.setLocalIdentity(identity);
    this._connectionManager.on("error", (err: Error) => {
      debugWarn(`[ConnectionManager] ${err.message}`);
    });

    // Create PeerLookup with HttpMetadataResolver
    const metadataResolver = new HttpMetadataResolver({
      timeoutMs: this._config.metadataFetchTimeoutMs ?? 1500,
      maxConcurrent: 24,
    });
    const lookupConfig: LookupConfig = {
      dht: this._dht,
      metadataResolver,
      requireValidSignature: DEFAULT_LOOKUP_CONFIG.requireValidSignature,
      allowStaleMetadata: DEFAULT_LOOKUP_CONFIG.allowStaleMetadata,
      maxAnnouncementAgeMs: DEFAULT_LOOKUP_CONFIG.maxAnnouncementAgeMs,
      maxClientServerClockSkewMs: DEFAULT_LOOKUP_CONFIG.maxClientServerClockSkewMs,
      maxResults: DEFAULT_LOOKUP_CONFIG.maxResults,
      maxFindAllDhtDurationMs: DEFAULT_LOOKUP_CONFIG.maxFindAllDhtDurationMs,
    };
    this._peerLookup = new PeerLookup(lookupConfig);

    // Initialize buyer-side payment manager if payments config is provided
    const payments = this._config.payments;
    if (payments?.enabled && payments.rpcUrl && payments.depositsAddress && payments.channelsAddress && payments.usdcAddress) {
      const paymentsDir = join(dataDir, "payments");
      // Create shared ChannelStore for both buyer and seller payment managers
      if (!this._channelStore) {
        try {
          this._channelStore = new ChannelStore(paymentsDir);
          debugLog("[Node] ChannelStore initialized (buyer)");
        } catch (err) {
          debugWarn(`[Node] ChannelStore unavailable: ${err instanceof Error ? err.message : err}`);
        }
      }
      if (this._channelStore) {
        const buyerPaymentConfig: BuyerPaymentConfig = {
          rpcUrl: payments.rpcUrl,
          ...(payments.fallbackRpcUrls ? { fallbackRpcUrls: payments.fallbackRpcUrls } : {}),
          depositsContractAddress: payments.depositsAddress,
          channelsContractAddress: payments.channelsAddress,
          usdcAddress: payments.usdcAddress,
          identityRegistryAddress: payments.identityRegistryAddress ?? '',
          chainId: payments.chainId ?? 8453,
          defaultAuthDurationSecs: payments.defaultAuthDurationSecs ?? 900, // 15 min — seller must call reserve() promptly
          maxPerRequestUsdc: BigInt(payments.maxPerRequestUsdc ?? "500000"),  // $0.50 default — covers most LLM requests
          maxReserveAmountUsdc: BigInt(payments.maxReserveAmountUsdc ?? "1000000"),  // $1.00 default per session (matches FIRST_SIGN_CAP)
          disableMetadataV2Services: payments.disableMetadataV2Services ?? false,
          attribution: payments.attribution,
          dataDir: paymentsDir,
        };
        this._buyerPaymentManager = new BuyerPaymentManager(identity, buyerPaymentConfig, this._channelStore, this._sellerAddressResolver ?? undefined);
        // Re-emit per-request spend so callers can attribute it to whatever
        // issued the request — the node only knows the seller and requestId.
        this._buyerPaymentManager.setSpendListener((event) => this.emit('payment:spend', event));
        debugLog(`[Node] Buyer payment manager initialized (wallet=${identity.wallet.address.slice(0, 10)}... chainId=${buyerPaymentConfig.chainId} deposits=${buyerPaymentConfig.depositsContractAddress.slice(0, 10)}...)`);

        // Create negotiator that wraps the BPM with 402 handling and per-request auth
        this._buyerNegotiator = new BuyerPaymentNegotiator(
          identity,
          this._buyerPaymentManager,
          this._depositsClient,
          this._channelsClient,
          this._channelStore,
          {
            isChainReachable: () => this._rpcHealth?.reachable ?? true,
            onChainReadFailure: () => this._rpcHealth?.reportFailure(),
          },
          this,
          this._sellerAddressResolver ?? undefined,
          this._buyerFreeUsageManager,
        );
        debugLog(`[Node] Buyer payment negotiator initialized`);
      }
    }

    // Create buyer request handler
    this._buyerHandler = new BuyerRequestHandler(
      {
        requestTimeoutMs: this._config.requestTimeoutMs,
        maxStreamBufferBytes: this._config.maxStreamBufferBytes,
        maxStreamDurationMs: this._config.maxStreamDurationMs,
      },
      {
        localPeerId: identity.peerId,
        negotiator: this._buyerNegotiator,
        freeUsageManager: this._buyerFreeUsageManager,
        verificationStorage: this._verificationStorage,
        verificationSampler: this._verificationSampler,
        getConnection: (peer) => this._getOrCreateConnection(peer as PeerInfo),
        getMux: (peerId, conn) => this._getOrCreateMux(peerId, conn as PeerConnection),
        getVerificationMux: (peerId, conn) => this._getOrCreateVerificationMux(peerId, conn as PeerConnection),
        registerPaymentMux: (peerId, pmux) => this._paymentMuxes.set(peerId, pmux),
      },
    );

    debugLog(`[Node] Buyer ready — DHT running on port ${this._dht!.getPort()}`);
  }

  private _handleIncomingConnection(conn: PeerConnection): void {
    debugLog(`[Node] Incoming connection from ${conn.remotePeerId.slice(0, 12)}...`);
    const buyerPeerId = conn.remotePeerId;

    const logTransport = (): void => {
      debugLog(`[Node] Connection with ${conn.remotePeerId.slice(0, 12)}... open via ${conn.transportDescription}`);
    };
    if (conn.state === ConnectionState.Open || conn.state === ConnectionState.Authenticated) {
      logTransport();
    } else {
      const onState = (state: ConnectionState): void => {
        if (state === ConnectionState.Open) {
          conn.off("stateChange", onState);
          logTransport();
        }
      };
      conn.on("stateChange", onState);
    }

    // Create PaymentMux alongside ProxyMux (seller-side)
    const paymentMux = new PaymentMux(conn);
    const verificationMux = new VerificationMux(conn);
    if (this._sellerPaymentManager) {
      const spm = this._sellerPaymentManager;
      paymentMux.onSpendingAuth((payload) => {
        void spm.handleSpendingAuth(buyerPeerId, payload, paymentMux)
          .then((status) => {
            if (status === 'rejected') {
              debugWarn(`[Node] SpendingAuth rejected for buyer ${buyerPeerId.slice(0, 12)}... — notifying via payment:auth-rejected event`);
              this.emit('payment:auth-rejected', { buyerPeerId, reason: 'invalid_or_non_monotonic' });
            }
          })
          .catch((err) => {
            debugWarn(`[Node] SpendingAuth handler error for ${buyerPeerId.slice(0, 12)}...: ${err instanceof Error ? err.message : err}`);
          });
      });
      paymentMux.onCloseChannelRequest((payload) => {
        void spm.handleCloseChannelRequest(buyerPeerId, payload, paymentMux)
          .then((result) => {
            paymentMux.sendCloseChannelResult(result);
            if (result.status === 'closed') {
              this.emit('payment:channel-closed', {
                buyerPeerId,
                channelId: result.channelId,
                txHash: result.txHash,
                finalAmount: result.finalAmount,
              });
            }
          })
          .catch((err) => {
            const message = err instanceof Error ? err.message : String(err);
            debugWarn(`[Node] CloseChannelRequest handler error for ${buyerPeerId.slice(0, 12)}...: ${message}`);
            paymentMux.sendCloseChannelResult({
              version: 1,
              channelId: payload.channelId,
              status: 'rejected',
              code: 'close_failed',
              reason: message,
            });
          });
      });
    } else {
      paymentMux.onSpendingAuth(() => {
        debugWarn(`[Node] SpendingAuth rejected — SellerPaymentManager not configured`);
      });
      paymentMux.onCloseChannelRequest((payload) => {
        paymentMux.sendCloseChannelResult({
          version: 1,
          channelId: payload.channelId,
          status: 'rejected',
          code: 'unsupported',
          reason: 'This peer has no payment manager configured',
        });
      });
    }
    if (this._sellerFreeUsageManager) {
      const freeUsage = this._sellerFreeUsageManager;
      paymentMux.onFreeUsageOpen((payload) => {
        freeUsage.handleOpen(buyerPeerId, payload, paymentMux);
      });
      paymentMux.onFreeUsageAuth((payload) => {
        freeUsage.handleAuth(buyerPeerId, payload, paymentMux);
      });
    } else {
      paymentMux.onFreeUsageOpen(() => {
        debugWarn(`[Node] FreeUsageOpen ignored — SellerFreeUsageManager not configured`);
      });
      paymentMux.onFreeUsageAuth(() => {
        debugWarn(`[Node] FreeUsageAuth ignored — SellerFreeUsageManager not configured`);
      });
    }
    this._paymentMuxes.set(buyerPeerId, paymentMux);
    this._verificationMuxes.set(buyerPeerId, verificationMux);

    // Deposit-sweep relaying (seller side, opt-out)
    const sweepMux = new SweepMux(conn);
    if (this._depositRelayer) {
      const relayer = this._depositRelayer;
      sweepMux.onSweepRequest((payload) => {
        void relayer.handleSweepRequest(buyerPeerId, payload, sweepMux).catch((err) => {
          debugWarn(`[Node] Sweep relay handler error for ${buyerPeerId.slice(0, 12)}...: ${err instanceof Error ? err.message : err}`);
        });
      });
    }
    this._sweepMuxes.set(buyerPeerId, sweepMux);

    const { mux } = this._sellerHandler!.handleConnection(conn, buyerPeerId, paymentMux, verificationMux);

    this._muxes.set(buyerPeerId, mux);
    this._wireConnection(conn, buyerPeerId);
    this.emit("connection", conn);
  }

  private async _initializePayments(dataDir: string): Promise<void> {
    const payments = this._config.payments;
    if (!payments || !payments.enabled) {
      return;
    }

    const fallbackRpcUrls = payments.fallbackRpcUrls;
    const paymentsDir = join(dataDir, "payments");

    // Shared store for paid and free channel accounting.
    if (!this._channelStore) {
      try {
        this._channelStore = new ChannelStore(paymentsDir);
        debugLog("[Node] ChannelStore initialized");
      } catch (err) {
        debugWarn(`[Node] ChannelStore unavailable: ${err instanceof Error ? err.message : err}`);
      }
    }

    // Background RPC reachability: a down RPC at startup must not disable
    // payments for the session — signing is off-chain. Call sites consult
    // `reachable` to skip best-effort on-chain reads until the first success.
    if (payments.rpcUrl && !this._rpcHealth) {
      this._rpcHealth = new RpcHealthMonitor({
        rpcUrls: [payments.rpcUrl, ...(payments.fallbackRpcUrls ?? [])],
      });
      this._rpcHealth.onReady(() => {
        debugLog("[Node] Chain RPC reachable — on-chain reads enabled");
        this.emit("payments:rpc-ready");
      });
      this._rpcHealth.start();
    }

    // Initialize DepositsClient
    if (payments.rpcUrl && payments.depositsAddress && payments.usdcAddress) {
      this._depositsClient = new DepositsClient({
        rpcUrl: payments.rpcUrl,
        ...(fallbackRpcUrls ? { fallbackRpcUrls } : {}),
        contractAddress: payments.depositsAddress,
        usdcAddress: payments.usdcAddress,
        ...(payments.chainId ? { evmChainId: payments.chainId } : {}),
      });
      debugLog(`[Node] DepositsClient initialized (contract=${payments.depositsAddress.slice(0, 10)}...)`);
    }

    // Initialize ChannelsClient
    if (payments.rpcUrl && payments.channelsAddress) {
      this._channelsClient = new ChannelsClient({
        rpcUrl: payments.rpcUrl,
        ...(fallbackRpcUrls ? { fallbackRpcUrls } : {}),
        contractAddress: payments.channelsAddress,
        ...(payments.chainId ? { evmChainId: payments.chainId } : {}),
      });
      debugLog(`[Node] ChannelsClient initialized (contract=${payments.channelsAddress.slice(0, 10)}...)`);

      const channelsClientRef = this._channelsClient;
      const isOperatorAbi = ["function isOperator(address) view returns (bool)"];
      const SELLER_CONTRACTS_MAX = 256;
      const sellerContracts = new Map<string, EthersContract>();
      this._sellerAddressResolver = new SellerAddressResolver({
        isOperator: async (sellerContract: string, peerAddress: string) => {
          let contract = sellerContracts.get(sellerContract);
          if (contract) {
            sellerContracts.delete(sellerContract);
            sellerContracts.set(sellerContract, contract);
          } else {
            contract = new EthersContract(sellerContract, isOperatorAbi, channelsClientRef!.provider);
            if (sellerContracts.size >= SELLER_CONTRACTS_MAX) {
              const oldest = sellerContracts.keys().next().value;
              if (oldest !== undefined) sellerContracts.delete(oldest);
            }
            sellerContracts.set(sellerContract, contract);
          }
          return await contract.getFunction("isOperator")(peerAddress) as boolean;
        },
      });
      debugLog(`[Node] SellerAddressResolver initialized`);
    }

    // Initialize FreeUsageClient
    if (payments.rpcUrl && payments.freeUsageAddress) {
      this._freeUsageClient = new FreeUsageClient({
        rpcUrl: payments.rpcUrl,
        ...(fallbackRpcUrls ? { fallbackRpcUrls } : {}),
        contractAddress: payments.freeUsageAddress,
        ...(payments.chainId ? { evmChainId: payments.chainId } : {}),
      });
      debugLog(`[Node] FreeUsageClient initialized (contract=${payments.freeUsageAddress.slice(0, 10)}...)`);

      if (this._identity) {
        const freeUsageConfig = {
          rpcUrl: payments.rpcUrl,
          ...(fallbackRpcUrls ? { fallbackRpcUrls } : {}),
          freeUsageContractAddress: payments.freeUsageAddress,
          chainId: payments.chainId ?? 8453,
        };
        this._buyerFreeUsageManager = new BuyerFreeUsageManager(
          this._identity,
          {
            chainId: freeUsageConfig.chainId,
            freeUsageContractAddress: freeUsageConfig.freeUsageContractAddress,
            defaultAuthDurationSecs: payments.defaultAuthDurationSecs ?? 900,
            disableMetadataV2Services: payments.disableMetadataV2Services ?? false,
            attribution: payments.attribution,
          },
          this._sellerAddressResolver ?? undefined,
          this._channelStore ?? undefined,
        );
        if (this._config.role === 'seller') {
          this._sellerFreeUsageManager = new SellerFreeUsageManager(this._identity, freeUsageConfig);
        }
      }
    }

    // Initialize StakingClient
    if (payments.rpcUrl && payments.stakingAddress && payments.usdcAddress) {
      this._stakingClient = new StakingClient({
        rpcUrl: payments.rpcUrl,
        ...(fallbackRpcUrls ? { fallbackRpcUrls } : {}),
        contractAddress: payments.stakingAddress,
        usdcAddress: payments.usdcAddress,
        ...(payments.chainId ? { evmChainId: payments.chainId } : {}),
      });
      debugLog(`[Node] StakingClient initialized (contract=${payments.stakingAddress.slice(0, 10)}...)`);
    }
    if (this._channelsClient && payments.stakingAddress && payments.channelsAddress) {
      this._trustSignalsClient = new TrustSignalsClient(this._channelsClient.provider, {
        sellerRegistry: payments.stakingAddress,
        channels: payments.channelsAddress,
        ...(payments.sellerPoolsAddress ? { sellerPools: payments.sellerPoolsAddress } : {}),
        ...(payments.usageAccountingAddress ? { usageAccounting: payments.usageAccountingAddress } : {}),
        ...(payments.washTradingRegistryAddress ? { washTradingRegistry: payments.washTradingRegistryAddress } : {}),
      });
      debugLog(`[Node] TrustSignalsClient initialized (pools=${Boolean(payments.sellerPoolsAddress)} usage=${Boolean(payments.usageAccountingAddress)} wash=${Boolean(payments.washTradingRegistryAddress)})`);
    }

    // Initialize IdentityClient (ERC-8004 IdentityRegistry)
    if (payments.rpcUrl && payments.identityRegistryAddress) {
      this._identityClient = new IdentityClient({
        rpcUrl: payments.rpcUrl,
        ...(fallbackRpcUrls ? { fallbackRpcUrls } : {}),
        contractAddress: payments.identityRegistryAddress,
        ...(payments.chainId ? { evmChainId: payments.chainId } : {}),
      });
      debugLog(`[Node] IdentityClient initialized (contract=${payments.identityRegistryAddress.slice(0, 10)}...)`);
    }

    // Initialize SellerPaymentManager for seller role
    if (this._config.role === 'seller' && this._identity && this._channelStore &&
        payments.rpcUrl && payments.channelsAddress) {
      const sellerConfig: SellerPaymentConfig = {
        rpcUrl: payments.rpcUrl,
        ...(fallbackRpcUrls ? { fallbackRpcUrls } : {}),
        channelsContractAddress: payments.channelsAddress,
        chainId: payments.chainId ?? 8453,
        dataDir: paymentsDir,
        ...(payments.minBudgetPerRequest ? { minBudgetPerRequest: payments.minBudgetPerRequest } : {}),
        ...(payments.minSettleDelta ? { minSettleDelta: payments.minSettleDelta } : {}),
        ...(payments.serveWhileClosePending !== undefined
          ? { serveWhileClosePending: payments.serveWhileClosePending }
          : {}),
      };
      this._sellerPaymentManager = new SellerPaymentManager(this._identity, sellerConfig, this._channelStore);
      debugLog(`[Node] SellerPaymentManager initialized`);

      // Deposit-sweep relayer (opt-out — ON by default when the chain has a relay)
      const relayerConfig = this._config.relayer;
      if (relayerConfig?.enabled !== false && payments.depositRelayAddress && payments.usdcAddress) {
        this._depositRelayer = new DepositRelayer(this._identity, {
          rpcUrl: payments.rpcUrl,
          ...(fallbackRpcUrls ? { fallbackRpcUrls } : {}),
          relayAddress: payments.depositRelayAddress,
          usdcAddress: payments.usdcAddress,
          evmChainId: payments.chainId ?? 8453,
          ...(relayerConfig?.minProfitBaseUnits !== undefined
            ? { minProfitBaseUnits: BigInt(relayerConfig.minProfitBaseUnits) }
            : {}),
          ...(relayerConfig?.maxInFlight !== undefined ? { maxInFlight: relayerConfig.maxInFlight } : {}),
          ...(relayerConfig?.maxPerPeerPerMinute !== undefined
            ? { maxPerPeerPerMinute: relayerConfig.maxPerPeerPerMinute }
            : {}),
        });
        debugLog(`[Node] DepositRelayer initialized (relay=${payments.depositRelayAddress.slice(0, 10)}...)`);
      }

      // Startup recovery: validate hydrated channels against on-chain state, then check timeouts
      await this._sellerPaymentManager.validateHydratedChannels();
      await this._sellerPaymentManager.checkTimeouts();

      // Initialize CloseRequested polling cursor to current block
      try {
        this._closeRequestedFromBlock = await this._sellerPaymentManager.channelsClient.getBlockNumber();
      } catch {
        this._closeRequestedFromBlock = 0;
      }

      // Start periodic timeout checker + CloseRequested poller (every 60s)
      this._timeoutCheckerInterval = setInterval(() => {
        void this._sellerPaymentManager?.checkTimeouts();
        if (this._sellerPaymentManager) {
          void this._sellerPaymentManager.pollCloseRequested(this._closeRequestedFromBlock).then((nextBlock) => {
            this._closeRequestedFromBlock = nextBlock;
          });
        }
      }, 60_000);
      if (typeof (this._timeoutCheckerInterval as { unref?: () => void }).unref === "function") {
        (this._timeoutCheckerInterval as { unref: () => void }).unref();
      }
    }

    if (!this._metering) {
      // Metering storage is only initialized for sellers — buyers don't need it.
      if (this._config.role === 'seller') {
        debugWarn("[Node] Payments enabled but metering storage is unavailable; skipping balance manager wiring");
      }
      return;
    }

    this._balanceManager = new BalanceManager();
    await this._balanceManager.load(paymentsDir).catch((err) => {
      debugWarn(`[Node] Failed to load payment balances: ${err instanceof Error ? err.message : err}`);
    });
  }

  private _initializeVerificationStorage(dataDir: string): void {
    if (this._verificationStorage) return;
    try {
      this._verificationStorage = new VerificationStorage(join(dataDir, "verification.db"));
      this._verificationSampler = new VerificationSampler(
        this._config.verification?.samplesDir ?? join(dataDir, "verification_samples"),
        {
          sampleRate: this._config.verification?.sampleRate,
          maxSampleBytes: this._config.verification?.maxSampleBytes,
        },
      );
      debugLog("[Node] Verification storage initialized");
    } catch (err) {
      debugWarn(`[Node] Verification storage unavailable: ${err instanceof Error ? err.message : err}`);
    }
  }

  private async _getOrCreateConnection(peer: PeerInfo): Promise<PeerConnection> {
    if (!this._connectionManager || !this._identity) {
      throw buyerFault("Node not started", "node-not-started");
    }

    const existing = this._connectionManager.getConnection(peer.peerId);
    const peerCapabilities = new Set(peer.capabilities ?? peer.metadata?.capabilities ?? []);
    this._peerCapabilities.set(peer.peerId, peerCapabilities);
    let endpointChanged = false;

    // Check if the peer's endpoint has changed (e.g. IP rotation).
    // Only applies to outbound connections where we registered the endpoint;
    // inbound connections (peer connected to us) have no registered endpoint
    // and are not subject to pinned-peer routing.
    if (existing && peer.publicAddress) {
      const currentEndpoint = ConnectionManager.resolvePeerEndpoint(peer.peerId);
      const { host: newHost, port: newPort } = parsePeerAddress(peer.publicAddress);
      if (currentEndpoint && (currentEndpoint.host !== newHost || currentEndpoint.port !== newPort)) {
        debugLog(`[Node] Peer ${peer.peerId.slice(0, 12)}... endpoint changed from ${currentEndpoint.host}:${currentEndpoint.port} to ${newHost}:${newPort}, reconnecting`);
        existing.close();
        this._peerCapabilities.set(peer.peerId, peerCapabilities);
        endpointChanged = true;
      }
    }

    if (
      existing && !endpointChanged &&
      existing.state !== ConnectionState.Closed &&
      existing.state !== ConnectionState.Failed
    ) {
      debugLog(`[Node] Reusing existing connection to ${peer.peerId.slice(0, 12)}... (state=${existing.state})`);
      // If still connecting, wait for it to reach Open or Authenticated
      if (existing.state === ConnectionState.Connecting) {
        debugLog(`[Node] Waiting for connection to open...`);
        await new Promise<void>((resolve, reject) => {
          const onState = (state: ConnectionState): void => {
            if (state === ConnectionState.Open || state === ConnectionState.Authenticated) {
              existing.off("stateChange", onState);
              resolve();
            } else if (state === ConnectionState.Failed || state === ConnectionState.Closed) {
              existing.off("stateChange", onState);
              reject(new Error(`Connection to ${peer.peerId} failed`));
            }
          };
          existing.on("stateChange", onState);
        });
      }
      return existing;
    }

    // Register the peer endpoint so ConnectionManager can resolve it
    if (peer.publicAddress) {
      const { host, port } = parsePeerAddress(peer.publicAddress);
      this._connectionManager.registerPeerEndpoint(peer.peerId, { host, port });
      debugLog(`[Node] Connecting to ${peer.peerId.slice(0, 12)}... at ${host}:${port}`);
    } else {
      debugWarn(`[Node] Peer ${peer.peerId.slice(0, 12)}... has no public address`);
    }

    const connConfig: ConnectionConfig = {
      remotePeerId: peer.peerId,
      isInitiator: true,
      remoteCapabilities: [...peerCapabilities],
    };

    const conn = this._connectionManager.createConnection(connConfig);

    // Wait for connection to open
    await new Promise<void>((resolve, reject) => {
      const onState = (state: ConnectionState): void => {
        debugLog(`[Node] Connection state: ${state}`);
        if (state === ConnectionState.Open || state === ConnectionState.Authenticated) {
          conn.off("stateChange", onState);
          resolve();
        } else if (state === ConnectionState.Failed || state === ConnectionState.Closed) {
          conn.off("stateChange", onState);
          reject(new Error(`Connection to ${peer.peerId} failed`));
        }
      };
      conn.on("stateChange", onState);
    });

    debugLog(`[Node] Connected to ${peer.peerId.slice(0, 12)}... via ${conn.transportDescription}`);
    this._peerCapabilities.set(peer.peerId, peerCapabilities);
    this._wireConnection(conn, peer.peerId);
    return conn;
  }

  private _getOrCreateMux(peerId: PeerId, conn: PeerConnection): ProxyMux {
    const existing = this._muxes.get(peerId);
    if (existing) {
      return existing;
    }

    const mux = new ProxyMux(conn, {
      maxUploadBodyBytes: this._config.maxUploadBodyBytes,
    });
    this._muxes.set(peerId, mux);
    return mux;
  }

  private _getOrCreateVerificationMux(peerId: PeerId, conn: PeerConnection): VerificationMux {
    const existing = this._verificationMuxes.get(peerId);
    if (existing) {
      return existing;
    }

    const mux = new VerificationMux(conn);
    this._verificationMuxes.set(peerId, mux);
    return mux;
  }

  private _getOrCreateSweepMux(peerId: PeerId, conn: PeerConnection): SweepMux {
    const existing = this._sweepMuxes.get(peerId);
    if (existing) {
      return existing;
    }

    const mux = new SweepMux(conn);
    // Buyer side: surface relayer progress reports as node events.
    mux.onSweepReceipt((payload: SweepReceiptPayload) => {
      this.emit('sweep:receipt', { peerId, payload });
    });
    this._sweepMuxes.set(peerId, mux);
    return mux;
  }

  /**
   * Update the referrer / client attribution appended to every buyer-signed
   * settlement metadata blob (see NodePaymentsConfig.attribution). Takes
   * effect on the next signed auth; nothing on-chain is touched here.
   */
  setBuyerAttribution(attribution: UsageAttribution | undefined): void {
    this._buyerPaymentManager?.setAttribution(attribution);
    this._buyerFreeUsageManager?.setAttribution(attribution);
  }

  /**
   * Offer a signed deposit-sweep request to connected relayers ONE AT A TIME.
   * Broadcasting to everyone makes relayers race the same EIP-3009 nonce and
   * the losers burn gas on reverted transactions; offering sequentially gives
   * each relayer an uncontested window. Candidates are shuffled so no single
   * relayer always gets first refusal. A relayer that reports 'rejected' (or
   * stays silent past `perPeerTimeoutMs`) forfeits its turn; 'submitted' or
   * 'confirmed' ends the round. Progress still arrives as 'sweep:receipt'
   * events, and the wire protocol is unchanged — relayers need no upgrade.
   */
  async dispatchSweepRequest(
    payload: SweepRequestPayload,
    opts?: { perPeerTimeoutMs?: number },
  ): Promise<{ offered: number; accepted: boolean }> {
    if (!this._connectionManager) {
      throw new Error('Node not started');
    }
    const perPeerTimeoutMs = opts?.perPeerTimeoutMs ?? DEFAULT_SWEEP_OFFER_TIMEOUT_MS;

    const candidates: Array<{ peerId: PeerId; conn: PeerConnection }> = [];
    for (const peerId of this._muxes.keys()) {
      const capabilities = this._peerCapabilities.get(peerId);
      if (!capabilities?.has(CONNECTION_CAPABILITY_RELAYS_SWEEPS_V1)) continue;
      const conn = this._connectionManager.getConnection(peerId);
      if (!conn) continue;
      if (conn.state !== ConnectionState.Open && conn.state !== ConnectionState.Authenticated) continue;
      candidates.push({ peerId, conn });
    }
    for (let i = candidates.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j]!, candidates[i]!];
    }

    const wantNonce = payload.nonce.toLowerCase();
    let offered = 0;
    for (const { peerId, conn } of candidates) {
      // Stop offering when the authorization is too close to expiry for a
      // relayer to safely land it (mirrors the relayer's own guard).
      const nowSecs = Math.floor(Date.now() / 1000);
      if (nowSecs >= payload.validBefore - MIN_SWEEP_DISPATCH_VALIDITY_SECS) break;
      try {
        this._getOrCreateSweepMux(peerId, conn).sendSweepRequest(payload);
      } catch (err) {
        debugWarn(`[Node] Failed to offer sweep request to ${peerId.slice(0, 12)}...: ${err instanceof Error ? err.message : err}`);
        continue;
      }
      offered++;
      const receipt = await this._waitForSweepReceipt(peerId, wantNonce, perPeerTimeoutMs);
      if (receipt && (receipt.status === 'submitted' || receipt.status === 'confirmed')) {
        return { offered, accepted: true };
      }
      // 'rejected' or silence — pass the opportunity to the next relayer.
    }
    return { offered, accepted: false };
  }

  /** Resolve with the first 'sweep:receipt' from `peerId` for `authNonce`
   *  (lowercased), or null after `timeoutMs`. */
  private _waitForSweepReceipt(
    peerId: PeerId,
    authNonce: string,
    timeoutMs: number,
  ): Promise<SweepReceiptPayload | null> {
    return new Promise((resolve) => {
      const listener = (event: { peerId: string; payload: SweepReceiptPayload }): void => {
        if (event.peerId !== peerId) return;
        if (event.payload.authNonce.toLowerCase() !== authNonce) return;
        cleanup();
        resolve(event.payload);
      };
      const timer = setTimeout(() => {
        cleanup();
        resolve(null);
      }, timeoutMs);
      const cleanup = (): void => {
        clearTimeout(timer);
        this.off('sweep:receipt', listener);
      };
      this.on('sweep:receipt', listener);
    });
  }

  /**
   * Broadcast a signed deposit-sweep request to all currently connected peers.
   * Relayers submit it on-chain permissionlessly; progress reports arrive as
   * 'sweep:receipt' events. Returns the number of peers the request was sent to.
   * Prefer {@link dispatchSweepRequest} — simultaneous broadcast makes relayers
   * race each other and losers burn gas on reverted transactions.
   */
  broadcastSweepRequest(payload: SweepRequestPayload): number {
    if (!this._connectionManager) {
      throw new Error('Node not started');
    }
    let sent = 0;
    for (const peerId of this._muxes.keys()) {
      const capabilities = this._peerCapabilities.get(peerId);
      if (!capabilities?.has(CONNECTION_CAPABILITY_RELAYS_SWEEPS_V1)) continue;
      const conn = this._connectionManager.getConnection(peerId);
      if (!conn) continue;
      if (conn.state !== ConnectionState.Open && conn.state !== ConnectionState.Authenticated) continue;
      try {
        this._getOrCreateSweepMux(peerId, conn).sendSweepRequest(payload);
        sent++;
      } catch (err) {
        debugWarn(`[Node] Failed to send sweep request to ${peerId.slice(0, 12)}...: ${err instanceof Error ? err.message : err}`);
      }
    }
    return sent;
  }

  private _resolvePublicAddress(result: LookupResult): string {
    const metadataPublicAddress = result.metadata.publicAddress?.trim();
    if (metadataPublicAddress && parsePublicAddress(metadataPublicAddress) !== null) {
      return metadataPublicAddress;
    }
    return `${result.host}:${result.port}`;
  }

  private _lookupResultToPeerInfo(result: LookupResult): PeerInfo {
    const displayName = sanitizePeerDisplayName(result.metadata.displayName);
    const providers = result.metadata.providers.map((p) => p.provider);
    const firstProvider = result.metadata.providers[0];
    const providerPricingEntries: NonNullable<PeerInfo["providerPricing"]> = {};
    const providerServiceCategoryEntries: NonNullable<PeerInfo["providerServiceCategories"]> = {};
    const providerServiceApiProtocolEntries: NonNullable<PeerInfo["providerServiceApiProtocols"]> = {};
    const providerServiceUnitBillingModelEntries: NonNullable<PeerInfo["providerServiceUnitBillingModels"]> = {};
    const providerServiceCapabilityEntries: NonNullable<PeerInfo["providerServiceCapabilities"]> = {};

    for (const providerAnnouncement of result.metadata.providers) {
      const provName = providerAnnouncement.provider;
      const serviceEntries: Record<string, TokenPricingUsdPerMillion> = {};
      for (const service of providerAnnouncement.services) {
        serviceEntries[service] =
          providerAnnouncement.servicePricing?.[service] ?? providerAnnouncement.defaultPricing;
      }

      const existing = providerPricingEntries[provName];
      if (existing) {
        // Merge services from duplicate provider names
        Object.assign(existing.services ?? {}, serviceEntries);
        if (!existing.services && Object.keys(serviceEntries).length > 0) {
          existing.services = serviceEntries;
        }
      } else {
        providerPricingEntries[provName] = {
          defaults: {
            inputUsdPerMillion: providerAnnouncement.defaultPricing.inputUsdPerMillion,
            outputUsdPerMillion: providerAnnouncement.defaultPricing.outputUsdPerMillion,
            ...(providerAnnouncement.defaultPricing.cachedInputUsdPerMillion != null
              ? { cachedInputUsdPerMillion: providerAnnouncement.defaultPricing.cachedInputUsdPerMillion }
              : {}),
          },
          ...(Object.keys(serviceEntries).length > 0 ? { services: serviceEntries } : {}),
        };
      }

      if (providerAnnouncement.serviceCategories && Object.keys(providerAnnouncement.serviceCategories).length > 0) {
        const existingCats = providerServiceCategoryEntries[provName];
        const newEntries = Object.fromEntries(
          Object.entries(providerAnnouncement.serviceCategories)
            .map(([service, categories]) => [service, [...categories]]),
        );
        if (existingCats) {
          Object.assign(existingCats.services, newEntries);
        } else {
          providerServiceCategoryEntries[provName] = { services: newEntries };
        }
      }

      if (providerAnnouncement.serviceApiProtocols && Object.keys(providerAnnouncement.serviceApiProtocols).length > 0) {
        const existingProtos = providerServiceApiProtocolEntries[provName];
        const newEntries = Object.fromEntries(
          Object.entries(providerAnnouncement.serviceApiProtocols)
            .map(([service, protocols]) => [service, [...protocols]]),
        );
        if (existingProtos) {
          Object.assign(existingProtos.services, newEntries);
        } else {
          providerServiceApiProtocolEntries[provName] = { services: newEntries };
        }
      }

      if (providerAnnouncement.serviceUnitBillingModels && Object.keys(providerAnnouncement.serviceUnitBillingModels).length > 0) {
        const existingBillingModels = providerServiceUnitBillingModelEntries[provName];
        const newEntries: ServiceUnitBillingModelsV1 = { ...providerAnnouncement.serviceUnitBillingModels };
        if (existingBillingModels) {
          Object.assign(existingBillingModels.services, newEntries);
        } else {
          providerServiceUnitBillingModelEntries[provName] = { services: newEntries };
        }
      }

      if (providerAnnouncement.serviceCapabilities && Object.keys(providerAnnouncement.serviceCapabilities).length > 0) {
        const existingCapabilities = providerServiceCapabilityEntries[provName];
        const newEntries = { ...providerAnnouncement.serviceCapabilities };
        if (existingCapabilities) {
          Object.assign(existingCapabilities.services, newEntries);
        } else {
          providerServiceCapabilityEntries[provName] = { services: newEntries };
        }
      }
    }

    const hasProviderPricing = Object.keys(providerPricingEntries).length > 0;
    const hasProviderServiceCategories = Object.keys(providerServiceCategoryEntries).length > 0;
    const hasProviderServiceApiProtocols = Object.keys(providerServiceApiProtocolEntries).length > 0;
    const hasProviderServiceUnitBillingModels = Object.keys(providerServiceUnitBillingModelEntries).length > 0;
    const hasProviderServiceCapabilities = Object.keys(providerServiceCapabilityEntries).length > 0;

    return {
      peerId: result.metadata.peerId,
      displayName,
      // `metadata.timestamp` is signed by the seller and can reflect the
      // seller's wall clock, not this buyer's. Freshness validation in
      // PeerLookup already handles seller/buyer clock skew using the HTTP Date
      // header. After acceptance, store the buyer-local observation time so
      // downstream cache TTLs (buyer.state.json hydration, desktop online
      // badges, carry-forward windows) compare timestamps from the same clock.
      lastSeen: result.metadata.resolvedAtMs ?? Date.now(),
      metadata: result.metadata,
      providers,
      ...(result.metadata.capabilities && result.metadata.capabilities.length > 0
        ? { capabilities: [...result.metadata.capabilities] }
        : {}),
      publicAddress: this._resolvePublicAddress(result),
      ...(hasProviderPricing ? { providerPricing: providerPricingEntries } : {}),
      ...(hasProviderServiceCategories ? { providerServiceCategories: providerServiceCategoryEntries } : {}),
      ...(hasProviderServiceApiProtocols ? { providerServiceApiProtocols: providerServiceApiProtocolEntries } : {}),
      ...(hasProviderServiceUnitBillingModels ? { providerServiceUnitBillingModels: providerServiceUnitBillingModelEntries } : {}),
      ...(hasProviderServiceCapabilities ? { providerServiceCapabilities: providerServiceCapabilityEntries } : {}),
      defaultInputUsdPerMillion: firstProvider?.defaultPricing.inputUsdPerMillion,
      defaultOutputUsdPerMillion: firstProvider?.defaultPricing.outputUsdPerMillion,
      defaultCachedInputUsdPerMillion: firstProvider?.defaultPricing.cachedInputUsdPerMillion,
      maxConcurrency: firstProvider?.maxConcurrency,
      currentLoad: firstProvider?.currentLoad,
      // channelCount/ghostCount are taken from seller-announced metadata as a
      // starting value. `discoverPeers`' verifyOne then reads the contract
      // directly and overwrites these fields with the authoritative values
      // (and populates volume + lastSettled, which sellers never announce).
      onChainChannelCount: result.metadata.onChainChannelCount,
      onChainGhostCount: result.metadata.onChainGhostCount,
    };
  }

  private _warnIfFreeUsageMeteringUnavailable(): void {
    if (this._sellerFreeUsageManager || !this._hasFreePricedService()) return;
    const missingAddress = !this._config.payments?.freeUsageAddress;
    debugWarn(
      `[Node] Zero-priced service advertised but AntseedFreeUsage is not configured` +
      `${missingAddress ? ' (payments.freeUsageAddress missing)' : ''}. ` +
      `Free requests will be served without on-chain usage proofs.`,
    );
  }

  private _hasFreePricedService(): boolean {
    for (const provider of this._providers) {
      if (provider.services.length === 0 && this._isZeroPricing(provider.pricing.defaults)) return true;
      for (const service of provider.services) {
        const servicePricing = provider.pricing.services?.[service] ?? provider.pricing.defaults;
        if (this._isZeroPricing(servicePricing)) return true;
      }
    }
    return false;
  }

  private _isZeroPricing(pricing: { inputUsdPerMillion: number; outputUsdPerMillion: number; cachedInputUsdPerMillion?: number }): boolean {
    const cachedPrice = pricing.cachedInputUsdPerMillion ?? pricing.inputUsdPerMillion;
    return pricing.inputUsdPerMillion === 0
      && pricing.outputUsdPerMillion === 0
      && cachedPrice === 0;
  }
}

function parsePeerAddress(address: string): { host: string; port: number } {
  const parts = address.split(":");
  return { host: parts[0]!, port: parseInt(parts[1] ?? "6882", 10) };
}

/**
 * Predicate used by `discoverPeers(service)` to filter the enumerated peer
 * list against an optional service hint. Matches case-insensitively against
 * either a provider name (e.g. `openai`) or any service name announced in
 * the peer's signed metadata across all of its providers. Returns true when
 * `service` is empty/whitespace so the caller can skip the filter.
 */
function peerOffersService(peer: PeerInfo, service: string): boolean {
  const needle = service.trim().toLowerCase();
  if (needle.length === 0) return true;
  for (const provider of peer.providers) {
    if (provider.trim().toLowerCase() === needle) return true;
  }
  if (peer.providerPricing) {
    for (const entry of Object.values(peer.providerPricing)) {
      if (!entry.services) continue;
      for (const serviceName of Object.keys(entry.services)) {
        if (serviceName.trim().toLowerCase() === needle) return true;
      }
    }
  }
  return false;
}
