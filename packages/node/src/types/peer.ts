import type { PeerMetadata } from "../discovery/peer-metadata.js";
import type { DomainVerificationResult } from "../discovery/domain-verification.js";
import type { GithubVerificationResult } from "../discovery/github-verification.js";

// PeerId primitives moved to @antseed/protocol.
export { toPeerId, peerIdToAddress, type PeerId } from '@antseed/protocol/peer-id';
import type { PeerId } from '@antseed/protocol/peer-id';

export type { TokenPricingUsdPerMillion } from '@antseed/protocol/peer-metadata';
export type {
  ProviderPricingMatrixEntry,
  ProviderServiceCategoryMatrixEntry,
  ProviderServiceApiProtocolMatrixEntry,
  ProviderServiceUnitBillingModelMatrixEntry,
  ProviderServiceCapabilityMatrixEntry,
} from '@antseed/protocol/peer-pricing';
import type {
  ProviderPricingMatrixEntry,
  ProviderServiceCategoryMatrixEntry,
  ProviderServiceApiProtocolMatrixEntry,
  ProviderServiceUnitBillingModelMatrixEntry,
  ProviderServiceCapabilityMatrixEntry,
} from '@antseed/protocol/peer-pricing';

import type { TrustBreakdown } from '../reputation/trust-score.js';

export interface PeerVerificationResults {
  /** Buyer-collected public history for verified identities (GitHub portfolio, domain registration). */
  identityHistory?: import('../reputation/identity-history.js').IdentityHistoryEvidence;
  /** True when every announced external claim verified successfully. */
  verified: boolean;
  /** Buyer-local time when the latest verification pass completed. */
  checkedAtMs: number;
  /** Domain ownership verification results, one per announced domain claim. */
  domains: DomainVerificationResult[];
  /** GitHub account ownership verification results, one per announced GitHub claim. */
  github: GithubVerificationResult[];
}

/** Information about a known peer. */
export interface PeerInfo {
  /** Unique peer identifier (EVM address, 40 hex chars). */
  peerId: PeerId;
  /** Human-readable label, optional. */
  displayName?: string;
  /** Last known STUN-resolved public address. */
  publicAddress?: string;
  /** Last seen timestamp (Unix ms). */
  lastSeen: number;
  /**
   * Last timestamp (Unix ms) at which the buyer successfully reached this peer
   * over the transport (e.g. a completed request). Decoupled from `lastSeen`,
   * which reflects DHT announcements, so a peer known to be alive survives
   * transient DHT staleness.
   */
  lastReachedAt?: number;
  /** LLM providers this peer is offering (empty if buyer-only). */
  providers: string[];
  /** Protocol capabilities announced by the peer. */
  capabilities?: string[];
  /** Seller-reported reputation score (0-100). */
  reputationScore?: number;
  /** Provider/service-aware pricing map announced by seller. */
  providerPricing?: Record<string, ProviderPricingMatrixEntry>;
  /** Provider/service category tags announced by seller. */
  providerServiceCategories?: Record<string, ProviderServiceCategoryMatrixEntry>;
  /** Provider/service API protocols announced by seller. */
  providerServiceApiProtocols?: Record<string, ProviderServiceApiProtocolMatrixEntry>;
  /** Provider/service/protocol unit billing models announced by seller. */
  providerServiceUnitBillingModels?: Record<string, ProviderServiceUnitBillingModelMatrixEntry>;
  /** Provider/service model capability hints announced by seller. */
  providerServiceCapabilities?: Record<string, ProviderServiceCapabilityMatrixEntry>;
  /** Deterministic fallback default input price (USD per 1M tokens). */
  defaultInputUsdPerMillion?: number;
  /** Deterministic fallback default output price (USD per 1M tokens). */
  defaultOutputUsdPerMillion?: number;
  /** Deterministic fallback default cached input price (USD per 1M tokens). */
  defaultCachedInputUsdPerMillion?: number;
  /** Maximum concurrent requests the peer can handle. */
  maxConcurrency?: number;
  /** Current number of requests the peer is handling. */
  currentLoad?: number;
  /** On-chain ERC-8004 agent ID, resolved through the seller registry. */
  onChainAgentId?: number;
  /** Buyer-computed trust score (0-100). See `computeTrustScore`. */
  onChainReputationScore?: number;
  /** Parts that make up `onChainReputationScore`. */
  trust?: TrustBreakdown;
  /** Local sybil-risk heuristic in [0, 1]. Display-only; not part of the trust score. */
  onChainSybilRisk?: number;
  /** Sybil signals that fired for this peer. */
  onChainSybilFlags?: string[];
  /** Lifetime settled channel count from `AntseedChannels`. */
  onChainChannelCount?: number;
  /** Lifetime ghost (timed-out, unsettled) channel count from `AntseedChannels`. */
  onChainGhostCount?: number;
  /** Lifetime settled volume in micro-USDC from `AntseedChannels`. */
  onChainTotalVolumeUsdcMicros?: number;
  /** Unix seconds of the most recent settlement. */
  onChainLastSettledAtSec?: number;
  /** Unix seconds when the seller first staked on the legacy USDC staking contract, when known. */
  onChainStakedAtSec?: number;
  /** Current recognized-usage epoch at the time of the read. */
  onChainUsageEpoch?: number;
  /** Seller pool's share of all pools' recognized-usage points in the previous epoch, in basis points. */
  onChainUsageShareBps?: number;
  /** Recognized usage points (micro-USDC) credited to the seller in the previous epoch. */
  onChainUsageLastEpochUsdcMicros?: number;
  /** ANTS actively staked in the seller's pool this epoch (whole ANTS). */
  onChainPoolStakeAnts?: number;
  /** Seller pool's share of total network staking power this epoch, in basis points. */
  onChainPoolPowerShareBps?: number;
  /** True when `AntseedWashTradingRegistry.isProvenWashTrader` is set for the seller. */
  onChainWashFlagged?: boolean;
  /** Proven wash share of the seller's volume, in basis points. */
  onChainWashShareBps?: number;
  /**
   * Unix ms when the buyer last refreshed on-chain stats for this peer.
   * Used to throttle repeat chain reads across discovery cycles.
   */
  onChainStatsFetchedAt?: number;
  /** Full peer metadata, if available (set after metadata resolution). */
  metadata?: PeerMetadata;
  /** Buyer-computed results for external ownership claims announced in metadata. */
  verificationResults?: PeerVerificationResults;
}
