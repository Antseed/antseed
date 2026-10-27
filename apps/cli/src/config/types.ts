import type {
  FreeTierDelegation,
  ServiceApiProtocol,
  ServiceCapabilities,
  UnitBillingModelV1,
} from '@antseed/node';
import type { ModelRoutingPreferences } from '@antseed/node/model-routing';
import type { VerifierCLIConfig } from '../verifier/config-schema.js';

export type {
  VerifierAntseedReferenceRouteConfig,
  VerifierCLIConfig,
  VerifierContrastModelConfig,
  VerifierContrastSelectionConfig,
  VerifierModelPricingConfig,
  VerifierReferenceEndpointConfig,
  VerifierReferenceModelConfig,
  VerifierReferenceProviderConfig,
  VerifierUpstreamConfig,
} from '../verifier/config-schema.js';

/**
 * Dual token pricing in USD per 1M tokens.
 */
export interface TokenPricingUsdPerMillion {
  inputUsdPerMillion: number;
  outputUsdPerMillion: number;
  cachedInputUsdPerMillion?: number;
}

/**
 * Hierarchical pricing used for BUYER max-willing-to-pay rules only.
 * Seller pricing has moved to `seller.providers[name].services[id]`.
 */
export interface HierarchicalPricingConfig {
  defaults: TokenPricingUsdPerMillion;
}

/**
 * One service offered by a seller under a given provider.
 */
export interface SellerServiceConfig {
  /**
   * Upstream model identifier the provider plugin will forward requests to.
   * When omitted, the service ID itself is used verbatim. Example: service
   * `"deepseek-v3.1"` with upstreamModel `"deepseek-ai/DeepSeek-V3.1"`.
   */
  upstreamModel?: string;
  /** Normie-friendly tags announced in peer metadata (e.g. "chat", "coding"). */
  categories?: string[];
  /**
   * Pricing override for this specific service. If absent, the provider's
   * defaults are used.
   */
  pricing?: TokenPricingUsdPerMillion;
  /** Model capability hints announced to buyers for this service. */
  capabilities?: ServiceCapabilities;
  /** Per-protocol non-token billing models for this service. */
  unitBillingModels?: Partial<Record<ServiceApiProtocol, UnitBillingModelV1>>;
  /**
   * This service's own free-tier program, with its own counters, in place of
   * `seller.freeTier`. On a zero-priced service, set `stakersOnly` to offer it
   * only to stakers. On a priced service it is a free allowance: requests it
   * covers are served free, the rest are paid at the listed price.
   */
  freeTier?: SellerFreeTierCLIConfig;
  /** `false`: kept in the config but not offered (the seller starts without it). Default: offered. */
  enabled?: boolean;
}

/**
 * Per-provider seller configuration.
 */
export interface SellerProviderConfig {
  /** Plugin name or npm package that powers this provider (e.g. "openai", "@antseed/provider-openai"). */
  plugin: string;
  /** Optional upstream API base URL override (e.g. "https://api.together.ai"). */
  baseUrl?: string;
  /**
   * Name of the environment variable holding this provider's API key.
   * Allows multiple providers on the same peer to use different credentials.
   * Example: `"ZAI_API_KEY"` reads `process.env.ZAI_API_KEY` and injects it
   * as `OPENAI_API_KEY` into the plugin config. When omitted, the plugin's
   * default env var (`OPENAI_API_KEY`) is used.
   */
  apiKeyEnv?: string;
  /**
   * Rewrite request paths before forwarding upstream. Keys are exact incoming
   * paths, values are their replacements.
   * Example: `{ "/v1/chat/completions": "/v4/chat/completions" }`
   */
  pathRewrite?: Record<string, string>;
  /**
   * Backup upstreams for this provider's services, tried in order when the
   * main upstream fails before the buyer receives anything (network error,
   * timeout, auth or credit failure, missing model, rate limit or quota, or a
   * server error). Buyers still get the service they asked for, so the
   * service stays advertised while any upstream is healthy.
   * Supported by the `openai` plugin.
   */
  fallbackUpstreams?: SellerFallbackUpstreamConfig[];
  /** Fallback pricing used by services that don't set their own `pricing`. */
  defaults?: TokenPricingUsdPerMillion;
  /** Services offered under this provider, keyed by announced service ID. */
  services: Record<string, SellerServiceConfig>;
}

/**
 * A backup upstream for a seller provider. It must serve the same models: a
 * request fails over only to the model the buyer asked for, never another.
 */
export interface SellerFallbackUpstreamConfig {
  /** Upstream API base URL (e.g. "https://openrouter.ai/api"). */
  baseUrl: string;
  /** Environment variable holding this upstream's API key. Omit to reuse the provider's key. */
  apiKeyEnv?: string;
  /** Path rewrites for this upstream. Defaults to the provider's `pathRewrite`. */
  pathRewrite?: Record<string, string>;
  /**
   * Services this upstream serves, keyed by announced service ID, with the
   * model name to send here when it differs from the provider's
   * `upstreamModel`. Omit to serve every service of the provider.
   */
  services?: Record<string, { upstreamModel?: string }>;
}

export type DomainVerificationMethod = 'dns-txt' | 'https-well-known';

export interface DomainVerificationConfig {
  /** Domain name to prove, without scheme, path, or port. */
  domain: string;
  /** Accepted proof transports. Omit to let clients try every supported method. */
  methods?: DomainVerificationMethod[];
}

export interface GithubVerificationConfig {
  /** GitHub username to prove. */
  username: string;
  /**
   * Public repository holding `antseed.json` at its root. Defaults to the
   * profile repository `<username>/<username>` when omitted.
   */
  repository?: string;
}

export interface VerificationConfig {
  /** Domain ownership claims. */
  domains?: DomainVerificationConfig[];
  /** GitHub account ownership claims. */
  github?: GithubVerificationConfig[];
}

export interface BuyerVerificationConfig {
  /** Random sample rate for storing full response-auth evidence, from 0 to 1. */
  sampleRate?: number;
  /** Maximum combined encoded request + response bytes per sample. */
  maxSampleBytes?: number;
}

/**
 * Periodic model health self-check settings for the seller.
 */
export interface SellerHealthCheckCLIConfig {
  /** Enable periodic 1-token probes of every advertised service. Default: true. */
  enabled?: boolean;
  /** Milliseconds between probe sweeps. Default: 300000 (5 minutes). */
  intervalMs?: number;
  /** Consecutive probe failures before a service is unadvertised. Default: 3. */
  failureThreshold?: number;
}

/**
 * Periodic seller-wallet gas balance check settings.
 */
export interface SellerGasCheckCLIConfig {
  /** Enable periodic ETH balance checks while payments are enabled. Default: true. */
  enabled?: boolean;
  /** Milliseconds between balance checks. Default: 60000 (1 minute). */
  intervalMs?: number;
  /** Minimum wallet balance in ETH before advertising is paused. Default: 0.00005. */
  minBalanceEth?: number;
}

/** `seller.alerts` in config.json: where the seller sends its own alerts. */
export interface SellerAlertsCLIConfig {
  /** A Telegram bot (create one with @BotFather) posting to a chat the bot was added to. */
  telegram?: {
    /** Env var holding the bot token, so the token stays out of config.json. Default: ANTSEED_ALERTS_TELEGRAM_TOKEN. */
    botTokenEnv?: string;
    /** Can be left out here and saved from the dashboard or `antseed seller alerts set` instead. */
    chatId?: string;
  };
  /** POSTs JSON `{ text, content, seller, event }` (Slack and Discord incoming webhooks read `text` / `content`). */
  webhook?: { url: string };
  /** Alert when no request arrives for this many minutes. Off when unset. */
  idleMinutes?: number;
  /**
   * Minimum minutes between two sends of the same alert, also across a recovery
   * (a flapping model alerts once per cooldown). 0 sends every one. Default: 30.
   */
  cooldownMinutes?: number;
  /**
   * Warn when an upstream whose account check reports its balance (Venice video, fal, …) holds
   * less than this many USD. 0 turns it off. Default: 5.
   */
  lowBalanceUsd?: number;
  /** Lowest severity that is sent. Default: warning. */
  minSeverity?: 'info' | 'warning' | 'critical';
}

/** One free-tier program: base limits and the staked tiers above them. */
export interface SellerFreeTierCLIConfig {
  /** Maximum zero-priced requests accepted from one buyer address per window. */
  maxRequestsPerAddress?: number;
  /** Maximum zero-priced requests accepted from one remote IP per window (IPv6 grouped by /64). */
  maxRequestsPerIp?: number;
  /** Sliding-window duration in milliseconds. Default: 86400000 (24 hours). */
  windowMs?: number;
  /**
   * Larger allowances for buyers staked on this seller, by staking power
   * (ANTS × epochs of lock remaining). Default: 10k/50k/200k ANTS locked for a
   * year earn 5×, 20× and unlimited. `[]` turns staked tiers off.
   */
  stakeTiers?: SellerFreeTierStakeTierCLIConfig[];
  /**
   * Serve only buyers whose stake reaches a tier. The base limits are still
   * required: they are the allowance the tier multipliers apply to.
   */
  stakersOnly?: boolean;
}

export interface SellerFreeTierStakeTierCLIConfig {
  /** Minimum staking power in ANTS-epochs, e.g. 520000 = 10k ANTS locked for 52 weeks. */
  minPower: number;
  /** Multiplier on the base allowance, or "unlimited". */
  multiplier: number | 'unlimited';
}

/**
 * Seller-specific configuration within the Antseed config.
 */
export interface SellerCLIConfig {
  /** Reserve floor in messages per hour to keep for yourself */
  reserveFloor: number;
  /** Maximum number of concurrent buyer connections */
  maxConcurrentBuyers: number;
  /**
   * Per-provider configuration: upstream base URL, defaults, and the services
   * offered under each provider. The set of keys here also determines which
   * services this peer announces.
   */
  providers: Record<string, SellerProviderConfig>;
  /**
   * Ant agent configuration. Can be:
   * - A string path to a single agent directory (applies to all services)
   * - A record mapping service IDs to agent directory paths (per-service agents).
   *   Use `"*"` key as a fallback for unmatched services.
   *
   * Each directory must contain an `agent.json` manifest.
   * Relative paths are resolved from the config file's directory.
   */
  agentDir?: string | Record<string, string>;
  /** Publicly reachable seller address override announced in metadata, e.g. "peer.example.com:6882". */
  publicAddress?: string;
  /** Optional external ownership claims announced in signed peer metadata. */
  verifications?: VerificationConfig;
  /** Maximum upload body size (bytes) accepted from buyers per request. Default: 64 MiB. */
  maxUploadBodyBytes?: number;
  /**
   * Verifier SDK ids this seller advertises and runs provers for (first is the
   * default). Chosen in `antseed seller setup`; overridden at launch by
   * `--verifiers` or the ANTSEED_VERIFIER_SDKS env var.
   */
  verifiers?: string[];
  /**
   * Periodic model health self-checks. Enabled by default; failing services
   * are unadvertised until they recover. Set `enabled: false` to opt out.
   */
  healthCheck?: SellerHealthCheckCLIConfig;
  /**
   * Periodic seller-wallet ETH balance checks (payments mode only). Enabled by
   * default; when the wallet cannot fund on-chain settlement the seller stops
   * advertising until it is funded again. Set `enabled: false` to opt out.
   */
  gasCheck?: SellerGasCheckCLIConfig;
  /**
   * Seller-wide free-tier program for zero-priced services. A service with its
   * own `providers.<p>.services.<s>.freeTier` uses that instead.
   */
  freeTier?: SellerFreeTierCLIConfig;
  /**
   * Alerts the seller sends itself (Telegram, webhook) when a model is withdrawn,
   * gas runs low, it restarts after a crash or goes idle. Off until a channel is set.
   */
  alerts?: SellerAlertsCLIConfig;
  /**
   * ISO country codes whose IPs are refused on connect (best effort: VPNs get
   * through). Default: CU, IR, KP, SY, RU. Set `[]` to opt out.
   */
  restrictedCountries?: string[];
  /** Free-usage on-chain record batching: flush after N auths or N ms (default 16 / 900000). */
  freeUsage?: { recordBatchSize?: number; recordFlushIntervalMs?: number };
}

/**
 * Buyer-specific configuration within the Antseed config.
 */
export interface BuyerCLIConfig {
  /** Buyer max willing-to-pay rules in USD per 1M tokens */
  maxPricing: HierarchicalPricingConfig;
  /** Minimum peer reputation score (0-100) */
  minPeerReputation: number;
  /** Model-only auto-routing preferences shared by the proxy and Desktop. */
  routingPreferences: ModelRoutingPreferences;
  /** Local proxy listen port */
  proxyPort: number;
  /** How often the buyer refreshes its peer list from the DHT in the background (ms) */
  peerRefreshIntervalMs: number;
  /** Timeout in ms for each HTTP metadata fetch during peer discovery */
  metadataFetchTimeoutMs: number;
  /** Timeout in ms while waiting for a non-streaming response or initial stream response. */
  requestTimeoutMs: number;
  /** Maximum total duration in ms for a streaming response. Default: 30 minutes. */
  maxStreamDurationMs: number;
  /** Disable per-service attribution in buyer-signed metadata v2. */
  disableMetadataV2Services: boolean;
  /**
   * Automatically sweep incoming hot-wallet USDC into the deposits balance
   * while the buyer daemon runs (gasless, via the relayer network).
   * Default: true. `false` limits sweeping to explicit requests
   * (`antseed deposit`, the desktop deposit view, `antseed buyer sweep`).
   */
  autoSweep?: boolean;
  /** Buyer-side response-auth evidence sampling settings. */
  verification?: BuyerVerificationConfig;
  /**
   * Seller verification by verifier SDKs (e.g. TEE attestation). The
   * `buyer start` flags `--no-verifier`, `--verifiers` and
   * `--require-verifier` override it.
   */
  verifier?: BuyerVerifierConfig;
  /**
   * Stakers' signed consent to count their ANTS stake toward these buyer
   * identities on sellers' staked free tiers. Added by
   * `antseed buyer free-tier share`; each identity sends only its own.
   */
  freeTierDelegations?: FreeTierDelegation[];
}

export interface BuyerVerifierConfig {
  /** Verify sellers at all. Default: true. */
  enabled?: boolean;
  /** Ordered verifier SDK ids to verify with; empty uses the seller's trusted default. */
  prefer?: string[];
  /** Refuse to route to a seller no verifier verifies. Default: false. */
  require?: boolean;
}

/**
 * Payment configuration within the Antseed config.
 */
export interface PaymentsCLIConfig {
  /** Preferred payment method */
  preferredMethod: 'crypto';
  /** Minimum USDC per request in base units (seller). Default: "10000" ($0.01). */
  minBudgetPerRequest?: string;
  /**
   * Minimum unsettled delta (base units) required before the seller's idle
   * settle loop submits a tx. Skips dust settles whose gas cost exceeds the
   * amount. Only applied in idle settle — close() still settles the full
   * amount. Default: "2000" (~$0.002).
   */
  minSettleDelta?: string;
  /** Serve channels whose buyer already requested close on-chain, risking uncollectible work. Default: false. */
  serveWhileClosePending?: boolean;
  /** Optional seller-side slack for estimate-only reserve preflight checks. Unset disables estimate-only rejection. */
  reserveEstimateOverdraftUsdc?: string;
  /**
   * Maximum USDC the buyer authorizes per single request in base units — the
   * per-request overdraft window beyond the buyer's independently-verified
   * cumulative cost. Caps how much a misreporting or malicious seller can
   * extract in one catch-up round trip. Default: "300000" ($0.30), sized to
   * fit a single long-context request on the priciest published models.
   */
  maxPerRequestUsdc?: string;
  /** Maximum total USDC the buyer will reserve in a single SpendingAuth in base units. Default: "1000000" ($1.00). */
  maxReserveAmountUsdc?: string;
  /** Most the buyer pays for one video in base units; a gateway reserves up to this while a video is priced. Default: "5000000" ($5.00). */
  maxVideoRequestUsdc?: string;
  /**
   * Optional on-chain seller contract (e.g. DiemStakingProxy). When set, the
   * peer publishes it in metadata; buyers verify the binding via
   * `sellerContract.isOperator(peerAddress)` on-chain. The peer identity wallet
   * must be an authorized operator on the contract.
   */
  sellerContract?: {
    /** 0x-prefixed contract address. */
    address: string;
  };
  /** Optional crypto settlement settings (Base network) */
  crypto?: {
    /** Chain identifier */
    chainId: 'base-local' | 'base-sepolia' | 'base-mainnet';
    /** Base JSON-RPC URL override (e.g. http://127.0.0.1:8545 for local anvil) */
    rpcUrl?: string;
    /** Additional RPC endpoints tried in order via ethers FallbackProvider. */
    fallbackRpcUrls?: string[];
    /** Deployed AntseedDeposits contract address override */
    depositsContractAddress?: string;
    /** Deployed AntseedChannels contract address override */
    channelsContractAddress?: string;
    /** Deployed AntseedRegistry contract address */
    registryContractAddress?: string;
    /** Deployed AntseedFreeUsage contract address override */
    freeUsageContractAddress?: string;
    /** Deployed AntseedStaking contract address */
    stakingContractAddress?: string;
    /** USDC token contract address override */
    usdcContractAddress?: string;
    /** Deployed AntseedIdentity (ERC-8004 registry) contract address */
    identityRegistryAddress?: string;
    /** Deployed AntseedEmissions contract address */
    emissionsContractAddress?: string;
    /** Deployed AntseedVerification contract address */
    verificationContractAddress?: string;
    /** Deployment block of the verification contract; floor for verifier event scans */
    verificationDeployBlock?: number;
    legacyEmissionsContractAddress?: string;
    legacyStakingContractAddress?: string;
    legacyEmissionsV1ContractAddress?: string;
    antsTokenAddress?: string;
    emissionsGateAddress?: string;
    sellerPoolsAddress?: string;
    sellerRegistryAddress?: string;
    positionInitAddress?: string;
    usageAccountingAddress?: string;
    usageRewardsAddress?: string;
    sellerPoolsRewardsAddress?: string;
    legacyEmissionsEscrowAddress?: string;
    washTradingRegistryAddress?: string;
    pointsPolicyRegistryAddress?: string;
    /** Explorer REST base for seller profiles in `antseed ants`; empty string disables the lookup. */
    explorerApiUrl?: string;
    /** Deployed AntseedDepositRelay contract address (gasless deposit sweeps) */
    depositRelayAddress?: string;
    /** Default lock amount per session in human-readable USDC (e.g. "1" = 1 USDC) */
    defaultLockAmountUSDC?: string;
  };
}

/**
 * Seller-side deposit-sweep relayer configuration. ON by default (opt-out).
 */
export interface RelayerCLIConfig {
  /** Relay buyer deposit sweeps with the seller wallet. Default: true. */
  enabled?: boolean;
  /** Minimum acceptable profit (FEE - estimated gas cost) in USDC base units.
   *  May be negative to relay at a loss (local testing). Default: "0". */
  minProfitBaseUnits?: string;
  /** Max concurrent sweep submissions. Default: 2. */
  maxInFlight?: number;
  /** Max sweep requests accepted per peer per minute. Default: 6. */
  maxPerPeerPerMinute?: number;
}

/**
 * Network configuration within the Antseed config.
 */
export interface NetworkCLIConfig {
  /** Additional bootstrap nodes for DHT discovery (host:port pairs) */
  bootstrapNodes: string[];
}

/**
 * Top-level Antseed configuration structure.
 */
export interface AntseedConfig {
  /** Node identity information (peer ID, display name) */
  identity: {
    displayName: string;
    walletAddress?: string;
  };
  /** Seller mode settings */
  seller: SellerCLIConfig;
  /** Buyer mode settings */
  buyer: BuyerCLIConfig;
  /** Payment settings */
  payments: PaymentsCLIConfig;
  /** Verifier mode settings (model-verification network) */
  verifier?: VerifierCLIConfig;
  /** Seller-side deposit-sweep relayer settings (opt-out, ON by default) */
  relayer?: RelayerCLIConfig;
  /** Network / DHT settings */
  network: NetworkCLIConfig;
  /** Installed plugins */
  plugins?: { name: string; package: string; installedAt: string }[];
}
