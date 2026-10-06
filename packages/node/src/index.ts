// Main facade
export {
  AntseedNode,
  type NodeConfig,
  type NodePaymentsConfig,
  type NodeRelayerConfig,
  type RequestStreamCallbacks,
  type RequestStreamResponseMetadata,
  type BuyerUsageTotals,
  type BuyerUsageChannelPoint,
  type BuyerUsageServicePoint,
  type BuyerChannelSummary,
} from './node.js';
export type { Provider, ProviderStreamCallbacks } from './interfaces/seller-provider.js';
export {
  ModelHealthChecker,
  DEFAULT_HEALTH_CHECK_INTERVAL_MS,
  DEFAULT_HEALTH_CHECK_FAILURE_THRESHOLD,
  DEFAULT_HEALTH_CHECK_PROBE_TIMEOUT_MS,
  type ModelHealthCheckerConfig,
  type ModelHealthEvent,
  type ModelHealthTarget,
  type ServiceHealthSnapshot,
} from './health/model-health-checker.js';
export {
  GasHealthMonitor,
  DEFAULT_GAS_CHECK_INTERVAL_MS,
  DEFAULT_MIN_GAS_BALANCE_WEI,
  type GasHealthMonitorConfig,
  type GasHealthEvent,
  type GasHealthSnapshot,
} from './health/gas-health-monitor.js';
// Re-exported so CLI callers can format/parse gas balances without depending
// on ethers directly.
export { formatEther, parseEther } from 'ethers';
export type { Router } from './interfaces/buyer-router.js';

// Types (re-export everything)
export * from './types/index.js';
export * from './billing/index.js';
export { canonicalModelKey, preferredModelDisplayName, sameCanonicalModel } from './model-identity.js';
export {
  compareNetworkServiceOfferPrice,
  selectLowestPricedCanonicalOffers,
  selectLowestPricedNetworkServiceOffer,
} from './discovery/service-catalog.js';

// Fault attribution — lets consumers tell a dead peer from a broken buyer.
export {
  AntseedRequestError,
  buyerFault,
  peerFault,
  faultAttributionOf,
  faultCodeOf,
  type FaultAttribution,
  type AntseedErrorCode,
} from './errors.js';
export { adaptPeerFaultErrorResponse } from '@antseed/buyer-core';

// Submodule re-exports (commonly used)
export {
  loadOrCreateIdentity,
  identityFromPrivateKeyHex,
  type Identity,
  type IdentityStore,
  FileIdentityStore,
  hexToBytes,
  bytesToHex,
} from './p2p/identity.js';
export { DHTNode, DEFAULT_DHT_CONFIG } from './discovery/dht-node.js';
export { MAX_SERVICES_PER_PROVIDER, MAX_SERVICE_NAME_LENGTH } from './discovery/metadata-validator.js';
export { OFFICIAL_BOOTSTRAP_NODES, mergeBootstrapNodes, toBootstrapConfig } from './discovery/bootstrap.js';
export {
  WELL_KNOWN_SERVICE_CATEGORIES,
  WELL_KNOWN_SERVICE_API_PROTOCOLS,
  SERVICE_CAPABILITY_MODALITIES,
  MAX_CAPABILITY_TOKEN_COUNT,
  MAX_CAPABILITY_SUPPORTED_PARAMETERS,
  MAX_CAPABILITY_PARAMETER_LENGTH,
  validateServiceCapabilityFields,
  type DomainVerificationClaim,
  type DomainVerificationMethod,
  type GithubVerificationClaim,
  type ServiceApiProtocol,
  type ServiceCapabilities,
  type ServiceCapabilityModality,
  type PeerMetadata,
  type PeerVerifications,
  type ProviderAnnouncement,
} from './discovery/peer-metadata.js';
export {
  DOMAIN_VERIFICATION_TXT_PREFIX,
  DOMAIN_VERIFICATION_TXT_NAME_PREFIX,
  DOMAIN_VERIFICATION_WELL_KNOWN_PATH,
  DOMAIN_VERIFICATION_WELL_KNOWN_TYPE,
  buildDomainVerificationTxtValue,
  buildDomainVerificationWellKnownProof,
  verifyDomainVerificationClaim,
  verifyPeerMetadataDomains,
  type DomainVerificationAttemptResult,
  type DomainVerificationOptions,
  type DomainVerificationResult,
} from './discovery/domain-verification.js';
export {
  GITHUB_VERIFICATION_PROOF_FILE,
  GITHUB_VERIFICATION_PROOF_TYPE,
  buildGithubVerificationProof,
  buildGithubVerificationProofUrl,
  verifyGithubVerificationClaim,
  verifyPeerMetadataGithub,
  type GithubVerificationOptions,
  type GithubVerificationResult,
} from './discovery/github-verification.js';
export {
  collectPeerVerificationLinks,
  isGithubName,
  isGithubRepository,
  type PeerVerificationLink,
} from './discovery/verification-links.js';
export { MetadataServer, type MetadataServerConfig } from './discovery/metadata-server.js';
export { parseVerifierCapabilities, normalizeAdvertisedVerifierIds, advertisesTeeSupport } from './discovery/verifier-capabilities.js';
export { parsePublicAddress, MAX_PUBLIC_ADDRESS_LENGTH, type ParsedPublicAddress } from './discovery/public-address.js';
export { sanitizePeerDisplayName } from './discovery/display-name.js';
export {
  buildNetworkServiceOffers,
  inferServiceProtocol,
  resolveServiceProtocol,
  type CatalogServiceCapabilities,
  type CatalogServiceProtocol,
  type NetworkServiceCatalogPeer,
  type NetworkServiceOffer,
} from './discovery/service-catalog.js';
export { MeteringStorage } from './metering/storage.js';
export type { FreeTierConsumption } from './metering/storage.js';
export { BalanceManager } from './payments/balance-manager.js';
export {
  computeCostUsdc,
  estimateTokensFromBytes,
  estimateTokensFromText,
  type ServicePricing,
} from './payments/pricing.js';
export { DepositsClient, type DepositsClientConfig, type BuyerBalanceInfo } from './payments/evm/deposits-client.js';
export {
  DepositRelayClient,
  type DepositRelayClientConfig,
  type SweepParams,
  type SweepProfitEstimate,
  type SweepEventConfirmation,
} from './payments/evm/deposit-relay-client.js';
export { DepositRelayer, type DepositRelayerConfig, type SweepHandleResult } from './payments/deposit-relayer.js';
export { ChannelsClient, type ChannelsClientConfig, type ChannelInfo, type AgentStats } from './payments/evm/channels-client.js';
export {
  FreeUsageClient,
  type FreeUsageClientConfig,
  type FreeUsageChannelInfo,
  type FreeUsageAgentStats,
} from './payments/evm/free-usage-client.js';
export { IdentityClient, type IdentityClientConfig } from './payments/evm/identity-client.js';
export { StakingClient, type StakingClientConfig } from './payments/evm/staking-client.js';
export { EmissionsClient, type EmissionsClientConfig, type EmissionsEpochParams } from './payments/evm/emissions-client.js';
export { RegistryClient, type RegistryClientConfig } from './payments/evm/registry-client.js';
export { UsageAccountingClient, type UsageAccountingClientConfig } from './payments/evm/usage-accounting-client.js';
export { UsageRewardsClient, type UsageRewardsClientConfig } from './payments/evm/usage-rewards-client.js';
export { SellerPoolsClient, estimateEarlyExit, positionState, projectedEarlyExitSlashBps, type SellerPoolsClientConfig, type SellerPoolPosition, type EarlyExitEstimate, type SellerPoolConfig, type PositionPowerSegment, type PositionState } from './payments/evm/seller-pools-client.js';
export { SellerPoolsRewardsClient, type SellerPoolsRewardsClientConfig } from './payments/evm/seller-pools-rewards-client.js';
export { SellerRegistryClient, SellerRegistrationVerificationError, type SellerRegistryClientConfig } from './payments/evm/seller-registry-client.js';
export { pendingEpochRewards, claimEpochRewards, claimBuyerEpochRewards, previewPoolRewards, claimPoolRewards, type RewardTransactionRecorder } from './payments/reward-claims.js';
export { PositionInitClient, type PositionInitClientConfig } from './payments/evm/position-init-client.js';
export { EmissionsGateClient, GATE_MINTERS, gateMinterId, type EmissionsGateClientConfig, type GateMinter } from './payments/evm/emissions-gate-client.js';
export { WashTradingRegistryClient, validateSellerProofArtifact, sellerProofId, type WashTradingRegistryClientConfig, type WashTradingSellerStatus, type WashTradingProofStatus, type WashTradingRegistryConfig, type SellerProofArtifact, type SellerProofSubmissionStep, type BlockAuthenticationChunk, type BlockReference } from './payments/evm/wash-trading-registry-client.js';
export { PointsPolicyRegistryClient, type PointsPolicyRegistryClientConfig } from './payments/evm/points-policy-registry-client.js';
export { SellerRewardsPoolClient, type SellerRewardsPoolClientConfig } from './payments/evm/seller-rewards-pool-client.js';
export {
  ContractStackMismatchError,
  legacyEpochs,
  newEpochs,
  resolveContractStack,
  resolveLegacyContractAddresses,
  type ContractStackAddresses,
  type ContractStackMode,
  type ContractStackResolution,
  type ContractStackRpcOptions,
} from './payments/contract-stack.js';
export { RpcHealthMonitor, probeRpcEndpoint } from './payments/rpc-health.js';
export type { RpcHealthState, RpcHealthStatus, RpcHealthMonitorOptions } from './payments/rpc-health.js';
export { ANTSTokenClient, type ANTSTokenClientConfig } from './payments/evm/ants-token-client.js';
export {
  StatsClient,
  type StatsClientConfig,
  type DecodedMetadataRecorded,
} from './payments/evm/stats-client.js';
export { signData, verifySignature, signUtf8, verifyUtf8 } from './p2p/identity.js';
export {
  getDebugFilters,
  shouldEmitDebugLine,
} from './utils/debug.js';
export {
  signSpendingAuth,
  signReserveAuth,
  signFreeUsageOpen,
  signFreeUsageAuth,
  signSetOperator,
  buildReceiveAuthorization,
  makeChannelsDomain,
  makeDepositsDomain,
  makeFreeUsageDomain,
  makeUsdcDomain,
  SPENDING_AUTH_TYPES,
  RESERVE_AUTH_TYPES,
  FREE_USAGE_OPEN_TYPES,
  FREE_USAGE_AUTH_TYPES,
  SET_OPERATOR_TYPES,
  RECEIVE_WITH_AUTHORIZATION_TYPES,
  computeMetadataHash,
  encodeMetadata,
  computeFreeUsageMetadataHash,
  encodeFreeUsageMetadata,
  getServiceMetadataId,
  computeChannelId,
  computeFreeUsageChannelId,
  FREE_USAGE_CHANNEL_DOMAIN,
  ZERO_METADATA,
  ZERO_METADATA_HASH,
  ZERO_FREE_USAGE_METADATA,
  ZERO_FREE_USAGE_METADATA_HASH,
} from './payments/evm/signatures.js';
export type {
  SpendingAuthMessage,
  ReserveAuthMessage,
  SetOperatorMessage,
  FreeUsageOpenMessage,
  FreeUsageAuthMessage,
  ReceiveAuthorizationMessage,
  SignedReceiveAuthorization,
  SpendingAuthMetadata,
  SpendingAuthServiceMetadata,
  FreeUsageMetadata,
  FreeUsageServiceMetadata,
} from './payments/evm/signatures.js';
export { NatTraversal, type NatMapping, type NatTraversalResult } from './p2p/nat-traversal.js';
export { BuyerPaymentManager } from './payments/buyer-payment-manager.js';
export type { BuyerSpendEvent, BuyerSpendListener } from './payments/buyer-payment-manager.js';
export type { BuyerPaymentConfig } from './payments/buyer-payment-manager.js';
export { BuyerFreeUsageManager } from './payments/buyer-free-usage-manager.js';
export type { BuyerFreeUsageConfig } from './payments/buyer-free-usage-manager.js';
export { SellerFreeUsageManager } from './payments/seller-free-usage-manager.js';
export type { SellerFreeUsageConfig } from './payments/seller-free-usage-manager.js';
export { SellerFreeTierLimiter, DEFAULT_FREE_TIER_WINDOW_MS, normalizeRemoteIp } from './payments/seller-free-tier-limiter.js';
export type { SellerFreeTierConfig, FreeTierDecision } from './payments/seller-free-tier-limiter.js';
export { SellerPaymentManager } from './payments/seller-payment-manager.js';
export type { SellerPaymentConfig } from './payments/seller-payment-manager.js';
export { ChannelStore } from './payments/channel-store.js';
export type { StoredChannel, StoredReceipt } from './payments/channel-store.js';
export { getChainConfig, resolveChainConfig, DEFAULT_CHAIN_ID, CHAIN_CONFIGS } from './payments/chain-config.js';
export type { ChainConfig, RecognizedUsageDeployment } from './payments/chain-config.js';
export { formatUsdc, parseUsdc } from './payments/usdc-utils.js';
export { ProxyMux } from './proxy/proxy-mux.js';
export { SweepMux, type SweepMessageHandler } from './p2p/sweep-mux.js';
export { encodeSweepRequest, decodeSweepRequest, encodeSweepReceipt, decodeSweepReceipt } from './p2p/sweep-codec.js';
export {
  VerificationMux,
  VerificationSampler,
  VerificationStorage,
  createResponseAuthPayload,
  verifyResponseAuth,
  hashRequest,
  hashResponse,
  type ResponseAuthSampleInput,
  type StoredResponseAuth,
  type StoredVerificationSample,
  type VerificationSampleConfig,
} from './verification/index.js';
export { resolveProvider } from './proxy/provider-detection.js';
export {
  detectRequestServiceApiProtocol,
  createStreamingAdapter,
  inferProviderDefaultServiceApiProtocols,
  selectTargetProtocolForRequest,
  transformRequest,
  transformResponse,
  type TargetProtocolSelection,
  type ServiceApiRequestTransformOptions,
  type ServiceApiRequestTransformResult,
  type ServiceApiResponseTransformOptions,
  type ServiceApiStreamTransformOptions,
  type StreamingResponseAdapter,
} from './proxy/service-api-adapter.js';
export { DefaultRouter, type DefaultRouterConfig } from './routing/default-router.js';
export {
  DEFAULT_MODEL_ROUTING_PREFERENCES,
  chooseBestModelRoute,
  isModelRouteCoolingDown,
  isModelRouteEligible,
  isModelRoutePeerAllowed,
  modelRouteReputationScore,
  modelRouteTotalPrice,
  rankModelRoutes,
  scoreModelRoute,
  type ModelRouteCandidate,
  type ModelRoutingPreferences,
  type ScoredModelRoute,
} from './routing/model-route-ranking.js';

export type { AntseedPlugin, AntseedProviderPlugin, AntseedRouterPlugin, AntseedVerifierPlugin, Prover, VerifyContext, VerifyResult, ClaimResult, SellerRequest, SellerResponse, PluginConfigKey, ConfigField } from './interfaces/plugin.js'
export { ANTSEED_ATTEST_PATH } from './interfaces/plugin.js'

// Reputation
export { UptimeTracker } from './reputation/uptime-tracker.js';
export {
  computeTrustScore, historyCurve, trustScore, shareCurve, SHARE_CURVE_RANGE,
  TRUST_HISTORY_CHANNEL_TARGET, TRUST_HISTORY_VOLUME_USDC_MICROS_TARGET, TRUST_WEIGHTS,
  type TrustBreakdown,
} from './reputation/trust-score.js';
export {
  IdentityHistoryCollector, scoreIdentityHistory,
  IDENTITY_HISTORY_VERSION, IDENTITY_HISTORY_TTL_MS, IDENTITY_GITHUB_MAX_POINTS, IDENTITY_DOMAIN_MAX_POINTS,
  type IdentityHistoryEvidence, type IdentityHistory, type IdentityScore,
} from './reputation/identity-history.js';
export { TrustSignalsClient, type TrustSignals, type TrustSignalsAddresses } from './payments/evm/trust-signals-client.js';
export {
  MISSING_CACHED_INPUT_PRICE_REPUTATION_MULTIPLIER,
  compareEffectiveModelReputation,
  effectiveModelReputationScore,
  normalizedModelReputationScore,
  type ModelReputationSource,
} from './reputation/model-reputation.js';
export {
  buildSybilContext,
  computeOnChainSybilRisk,
  SYBIL_WEIGHT_SUBFLOOR_TICKET,
  SYBIL_WEIGHT_BURN_RATE,
  SYBIL_WEIGHT_NARROW_CUSTOM,
  SYBIL_WEIGHT_YOUNG_HIGH_VOL,
  SYBIL_SUBFLOOR_TICKET_USDC,
  SYBIL_SUBFLOOR_MIN_CHANNELS,
  SYBIL_BURN_RATE_THRESHOLD,
  SYBIL_BURN_RATE_SATURATION,
  SYBIL_YOUNG_MAX_DAYS,
  SYBIL_YOUNG_CHANNEL_FLOOR,
  SYBIL_YOUNG_CHANNEL_SATURATION,
  SYBIL_ADVERTISED_CHEAP_INPUT_USD_PER_MILLION,
  type SybilContext,
  type SybilRiskResult,
  type SybilFlag,
} from './reputation/sybil-risk.js';
export type { UptimeWindow, PeerUptimeRecord } from './reputation/uptime-tracker.js';
export { ReportManager } from './reputation/report-manager.js';
export type { PeerReport, ReportReason, ReportEvidence, ReportStatus } from './types/report.js';
export { RatingManager } from './reputation/rating-manager.js';
export type { PeerRating, RatingDimension, AggregateRating } from './types/rating.js';

// Plugin config & loading
export { encryptValue, decryptValue, deriveMachineKey, generateSalt } from './config/encryption.js'
export {
  loadPluginConfig,
  savePluginConfig,
  addInstance,
  removeInstance,
  getInstance,
  getInstances,
  updateInstanceConfig,
} from './config/plugin-config-manager.js'
export {
  loadPluginModule,
  loadAllPlugins,
  type LoadedProvider,
  type LoadedRouter,
} from './config/plugin-loader.js'
