// Payment types
export type {
  PaymentMethod,
  ChainId,
  WalletInfo,
  TransactionType,
  Transaction,
  PaymentConfig,
  CryptoPaymentConfig,
} from './types.js';

// Balance tracking (local transaction history)
export { BalanceManager } from './balance-manager.js';
export type { UnifiedBalance } from './balance-manager.js';

// Base EVM client
export { BaseEvmClient } from './evm/base-evm-client.js';

// Deposits client (buyer deposits + seller payouts)
export { DepositsClient } from './evm/deposits-client.js';
export type { DepositsClientConfig, BuyerBalanceInfo } from './evm/deposits-client.js';

// Channels client (reserve, settle, timeout)
export { ChannelsClient } from './evm/channels-client.js';
export type { ChannelsClientConfig, ChannelInfo, AgentStats, CloseRequestedEvent } from './evm/channels-client.js';

// Free usage client (zero-price signed usage)
export { FreeUsageClient } from './evm/free-usage-client.js';
export type { FreeUsageClientConfig, FreeUsageChannelInfo, FreeUsageAgentStats } from './evm/free-usage-client.js';

// Identity client (ERC-8004 IdentityRegistry)
export { IdentityClient } from './evm/identity-client.js';
export type { IdentityClientConfig } from './evm/identity-client.js';

// Staking client (seller staking, token rate, slashing)
export { StakingClient } from './evm/staking-client.js';
export type { StakingClientConfig } from './evm/staking-client.js';

export {
  signSpendingAuth,
  signReserveAuth,
  signFreeUsageOpen,
  signFreeUsageAuth,
  signSetOperator,
  makeChannelsDomain,
  makeDepositsDomain,
  makeFreeUsageDomain,
  SPENDING_AUTH_TYPES,
  RESERVE_AUTH_TYPES,
  FREE_USAGE_OPEN_TYPES,
  FREE_USAGE_AUTH_TYPES,
  SET_OPERATOR_TYPES,
  computeMetadataHash,
  encodeMetadata,
  computeFreeUsageMetadataHash,
  encodeFreeUsageMetadata,
  getServiceMetadataId,
  METADATA_VERSION,
  FREE_USAGE_METADATA_VERSION,
  computeChannelId,
  computeFreeUsageChannelId,
  FREE_USAGE_CHANNEL_DOMAIN,
  ZERO_METADATA,
  ZERO_METADATA_HASH,
  ZERO_FREE_USAGE_METADATA,
  ZERO_FREE_USAGE_METADATA_HASH,
} from './evm/signatures.js';
export type {
  SpendingAuthMessage,
  ReserveAuthMessage,
  SetOperatorMessage,
  FreeUsageOpenMessage,
  FreeUsageAuthMessage,
  SpendingAuthMetadata,
  SpendingAuthServiceMetadata,
  FreeUsageMetadata,
  FreeUsageServiceMetadata,
} from './evm/signatures.js';

// ANTS token
export { ANTSTokenClient } from './evm/ants-token-client.js';
export type { ANTSTokenClientConfig } from './evm/ants-token-client.js';

// Emissions
export { EmissionsClient } from './evm/emissions-client.js';
export type { EmissionsClientConfig, EmissionsEpochParams } from './evm/emissions-client.js';
export { RegistryClient } from './evm/registry-client.js';
export type { RegistryClientConfig } from './evm/registry-client.js';
export { UsageAccountingClient } from './evm/usage-accounting-client.js';
export type { UsageAccountingClientConfig, UsagePoints, UsageTotals } from './evm/usage-accounting-client.js';
export { UsageRewardsClient } from './evm/usage-rewards-client.js';
export type { UsageRewardsClientConfig, DynamicUsageConfig } from './evm/usage-rewards-client.js';
export { SellerPoolsClient, estimateEarlyExit, positionState, projectedEarlyExitSlashBps } from './evm/seller-pools-client.js';
export type { SellerPoolsClientConfig, SellerPoolPosition, EarlyExitEstimate, SellerPoolConfig, PositionPowerSegment, PositionState } from './evm/seller-pools-client.js';
export { SellerPoolsRewardsClient } from './evm/seller-pools-rewards-client.js';
export type { SellerPoolsRewardsClientConfig, DynamicStakerConfig } from './evm/seller-pools-rewards-client.js';
export { SellerRegistryClient, SellerRegistrationVerificationError } from './evm/seller-registry-client.js';
export type { SellerRegistryClientConfig } from './evm/seller-registry-client.js';
export { pendingEpochRewards, claimEpochRewards, claimBuyerEpochRewards, previewPoolRewards, claimPoolRewards } from './reward-claims.js';
export type { RewardTransactionRecorder } from './reward-claims.js';
export { PositionInitClient } from './evm/position-init-client.js';
export type { PositionInitClientConfig } from './evm/position-init-client.js';
export { EmissionsGateClient, GATE_MINTERS, gateMinterId } from './evm/emissions-gate-client.js';
export type { EmissionsGateClientConfig, GateMinter } from './evm/emissions-gate-client.js';
export { WashTradingRegistryClient, validateSellerProofArtifact, sellerProofId } from './evm/wash-trading-registry-client.js';
export type {
  WashTradingRegistryClientConfig, WashTradingSellerStatus, WashTradingProofStatus, WashTradingRegistryConfig,
  BlockReference, BlockAuthenticationChunk, SellerProofArtifact, SellerProofSubmissionStep,
} from './evm/wash-trading-registry-client.js';
export { PointsPolicyRegistryClient } from './evm/points-policy-registry-client.js';
export type { PointsPolicyRegistryClientConfig } from './evm/points-policy-registry-client.js';
export { SellerRewardsPoolClient } from './evm/seller-rewards-pool-client.js';
export type { SellerRewardsPoolClientConfig } from './evm/seller-rewards-pool-client.js';
export { multicallRead, MULTICALL3_ADDRESS } from './evm/multicall.js';
export type { MulticallRequest } from './evm/multicall.js';
export {
  ContractStackMismatchError,
  legacyEpochs,
  newEpochs,
  resolveContractStack,
  resolveLegacyContractAddresses,
} from './contract-stack.js';
export type {
  ContractStackAddresses,
  ContractStackMode,
  ContractStackResolution,
  ContractStackRpcOptions,
} from './contract-stack.js';

// Channel persistence
export { ChannelStore, CHANNEL_KIND, CHANNEL_ROLE, CHANNEL_STATUS } from './channel-store.js';
export type { ChannelKind, ChannelRole, ChannelStatus, StoredChannel, StoredReceipt } from './channel-store.js';

// Buyer payment manager
export { BuyerPaymentManager } from './buyer-payment-manager.js';
export type { BuyerPaymentConfig, PerRequestAuthResult } from './buyer-payment-manager.js';

// Free usage managers
export { BuyerFreeUsageManager } from './buyer-free-usage-manager.js';
export type { BuyerFreeUsageConfig } from './buyer-free-usage-manager.js';
export { SellerFreeUsageManager } from './seller-free-usage-manager.js';
export type { SellerFreeUsageConfig } from './seller-free-usage-manager.js';
export { SellerFreeTierLimiter, DEFAULT_FREE_TIER_WINDOW_MS, normalizeRemoteIp } from './seller-free-tier-limiter.js';
export type { SellerFreeTierConfig, FreeTierDecision } from './seller-free-tier-limiter.js';

// Buyer payment negotiator (402 handling, SpendingAuth flow, cost tracking)
export { BuyerPaymentNegotiator } from './buyer-payment-negotiator.js';
export type { BuyerNegotiatorConfig, Handle402Result, NegotiationEmitter } from './buyer-payment-negotiator.js';

// Seller payment manager
export { SellerPaymentManager, DEFAULT_MIN_SETTLE_DELTA_STR } from './seller-payment-manager.js';
export type { SellerPaymentConfig } from './seller-payment-manager.js';

// Pricing utilities
export {
  computeCostUsdc,
  estimateCostFromBytes,
  estimateTokensFromBytes,
  isFreeUnitBillingModel,
  validateUnitBillingModelV1,
} from './pricing.js';
export type { ServicePricing } from './pricing.js';

// Readiness checks
export { checkSellerReadiness, checkBuyerReadiness } from './readiness.js';
export type { ReadinessCheck } from './readiness.js';

// Chain RPC reachability (background monitor with retry)
export { RpcHealthMonitor, probeRpcEndpoint } from './rpc-health.js';
export type { RpcHealthState, RpcHealthStatus, RpcHealthMonitorOptions } from './rpc-health.js';
