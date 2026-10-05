/**
 * Wire contract between the ANTS dashboard server and its web client. Every
 * on-chain amount is a decimal string in base units (ANTS: 18 decimals, USDC:
 * 6 decimals) so the JSON survives without bigint support. The same shapes
 * are printed by the CLI's `--json` flags.
 */

export type ProtocolPhase = 'legacy' | 'deployed' | 'active';

export interface DisplaySource {
  source: 'indexer' | 'chain';
  indexedBlock?: number;
  indexedAt?: number;
  error?: string;
}

export interface EpochInfo {
  current: number;
  /** First recognized-usage epoch (gate `effectiveEpoch`), null before the stack is deployed. */
  effective: number | null;
  genesis: number;
  epochDuration: number;
  nextBoundaryAt: number;
  secondsToBoundary: number;
}

export interface WalletSummary {
  address: string;
  ants: string;
  eth: string;
  signingWalletEth?: string;
  transfersEnabled: boolean;
  whitelisted: boolean;
  canTransfer: boolean;
  totalActiveStake: string;
  positionCount: number;
  agentId: number;
  sellerBound: boolean;
}

export interface NetworkSummary {
  totalActiveStake: string;
  totalPowerWeight: string;
  epochEmission: string;
  stakerBudget: string;
  usageBuyerBudget: string;
  usageSellerBudget: string;
  antsTotalSupply: string;
  antsMaxSupply: string;
}

export interface OverviewView {
  networkSource?: DisplaySource;
  phase: ProtocolPhase;
  chainId: string;
  evmChainId: number;
  rpcUrl: string;
  addresses: Record<string, string>;
  epoch: EpochInfo;
  wallet: WalletSummary;
  network: NetworkSummary | null;
  notices: string[];
}

export type PositionState = 'pending' | 'active' | 'matured' | 'closed' | 'withdrawn';

export interface PositionView {
  id: number;
  /** Why a closed position closed and what replaced it (indexer-sourced rows only). */
  closedBy?: 'split' | 'merge' | 'move' | 'withdraw' | null;
  replacementIds?: number[];
  agentId: number;
  owner: string;
  amount: string;
  weightAmount: string;
  stakeStartEpoch: number;
  stakeEndEpoch: number;
  closedAtEpoch: number;
  withdrawn: boolean;
  state: PositionState;
  withdrawableEpoch: number;
  changePending: boolean;
  maxLocked: boolean;
  /** Max-lock state from the next epoch; differs from `maxLocked` while an enable/disable is pending. */
  maxLockedNext: boolean;
  /** On-chain early-exit slash for a withdrawal now; null while a change is pending (projected value is in `projectedSlashBps`). */
  slashBps: number | null;
  projectedSlashBps: number;
  slashedAmount: string;
  returnedAmount: string;
  pendingReward: string | null;
  power?: string | null;
  nextPower?: string | null;
  epochsRemaining: number;
}

export interface PoolConfigView {
  minStakeEpochs: number;
  maxStakeEpochs: number;
  stakeActivationDelay: number;
  maxSlashBps: number;
  minEarlyExitSlashBps: number;
  restakedRewardWeightBonusBps: number;
  moveWeightPenaltyBps: number;
}

export type DataSource = 'indexer' | 'chain' | 'local';

export interface PositionsView {
  rewardSource?: { indexedBlock?: number; indexedAt?: number; error?: string };
  displaySource?: DisplaySource;
  currentEpoch: number;
  config: PoolConfigView;
  positions: PositionView[];
  totals: { activeStake: string; pendingStake: string; pendingRewards: string | null; open: number };
  /** Where closed positions came from; 'chain' means only open positions are listed. */
  historySource: DataSource;
}

export interface EpochAmount { epoch: number; amount: string; claimed?: boolean; }

export interface LegacySellerPayout {
  destination: 'wallet' | 'locked' | 'unknown';
  recipient: string | null;
}

export interface RewardsView {
  /** Before browser wallet connection, only the originating buyer account is read. */
  scope?: 'buyer' | 'all';
  historySource?: DataSource;
  currentEpoch: number;
  firstRewardedEpoch: number | null;
  staker: { total: string | null; positions: Array<{ id: number; agentId: number; amount: string; closed: boolean }>; source?: { indexedBlock?: number; indexedAt?: number; error?: string }; };
  sellerUsage: { total: string; agentId: number; epochs: EpochAmount[]; claimable: boolean };
  buyerUsage: { total: string; epochs: EpochAmount[]; operator: string | null; claimable: boolean; recipient: string | null };
  legacy: { seller: string; buyer: string; contract: string | null; buyerClaimable: boolean; sellerPayout?: LegacySellerPayout };
  locked: { locked: string; claimable: string; policy: string | null; pool: string | null };
  total: string | null;
}

/** One epoch's settled USDC volume for a seller (6 decimals). */
export interface EpochVolume { epoch: number; usdc: string; }

/** Explorer-sourced seller profile (Antscan); null fields when the explorer has no record. */
export interface SellerProfile {
  fetchedAt?: number;
  stale?: boolean;
  name: string | null;
  providers: string[];
  modelsServed: number | null;
  uniqueBuyers: number | null;
  requestCount: string | null;
  lifetimeVolumeUsdc: string | null;
  ghostRate: number | null;
  lastSettledAt: number | null;
}

export interface SellerModelsView {
  fetchedAt: number;
  catalogStatus: 'live' | 'stale' | 'unavailable';
  catalogUpdatedAt: number | null;
  offerings: Array<{ id: string; name: string; provider: string; categories: string[]; inputUsdPerMillion: number | null; outputUsdPerMillion: number | null }>;
  usageStatus: 'available' | 'unavailable';
  usageError: string | null;
  period: { epoch: number; from: number; to: number } | null;
  totals: { settledVolumeUsdc: string; attributedVolumeUsdc: string; unattributedVolumeUsdc: string | null; excessAttributedVolumeUsdc: string } | null;
  usage: Array<{ serviceId: string; name: string; requests: string; inputTokens: string; outputTokens: string; volumeUsdc: string }>;
}

export interface PoolYield {
  reward?: string | null;
  power?: string | null;
  minLockEpochs?: number | null;
  maxLockEpochs?: number | null;
  epoch: number;
  startsAt: number;
  endsAt: number;
  apr: number | null;
  apy: number | null;
  status: 'settled' | 'estimated' | 'unavailable';
}
/** One indexed epoch of a seller pool: stake, power, settled volume and the staker emission it earned. */
export interface PoolEpochPoint {
  epoch: number;
  activeStake: string;
  weight: string;
  volumeUsdc: string;
  requests: string;
  /** Staker emission for the epoch; settled once a claim finalises it, otherwise the indexer's running figure. */
  emission: string;
  settled: boolean;
}

export interface PoolView {
  displaySource?: DisplaySource;
  /** Per-epoch history (oldest first) for charts; present on the single-pool endpoint when the indexer is reachable. */
  history?: PoolEpochPoint[];
  openPositions?: number;
  totalPositions?: number;
  stakers?: number | null;
  yield?: PoolYield;
  statsUpdatedAt?: number;
  volumeStatus?: 'available' | 'unavailable' | 'stale';
  agentId: number;
  seller: string | null;
  profile: SellerProfile | null;
  hasPool: boolean;
  /** Whether a seller binding exists so `stake` into this agent will succeed. */
  stakeable: boolean;
  activeStake: string;
  /** Pool power (weight) this epoch. */
  weight: string;
  /** Pool power as a share of all pools' power this epoch. */
  powerShareBps: number;
  securityShareBps: number;
  /** Settled USDC volume: current epoch first, then previous epochs. */
  volumes: EpochVolume[];
  usagePoints: string;
  weightedUsagePoints: string;
  lastEpochUsagePoints: string;
  /** Last epoch's staker emission for the pool; estimated from usage until a claim settles it. */
  lastEpochEmission: string | null;
  lastEpochEmissionSettled: boolean;
  /** Staker ANTS per 1,000 units of pool power last epoch (estimated until settled; null with no usage). */
  lastEpochRewardPer1kPower: string | null;
  /** Projected staker ANTS per 1,000 units of pool power this epoch from current usage. */
  projectedRewardPer1kPower: string | null;
  /** Stake in open positions that activates at a later epoch (indexer-sourced; absent from chain-only rows). */
  pendingStake?: string;
  yourStake: string;
  /** Your stake in this pool whose activation epoch is still ahead. */
  yourPendingStake: string;
  /** Your power in this pool this epoch (sum of your positions' weight). */
  yourPower: string;
  /** Your power as a share of the pool's power. */
  yourPoolShareBps: number;
  yourPositionIds: number[];
}

export interface PoolsView {
  displaySource?: DisplaySource;
  currentEpoch: number;
  firstRewardedEpoch: number | null;
  totalActiveStake: string;
  totalPowerWeight: string;
  /** Network settled USDC volume for the same epochs as each pool's `volumes`. */
  networkVolumes: EpochVolume[];
  stakerBudget: string;
  yourTotalPower: string;
  /** Your power as a share of all pools' power. */
  yourNetworkShareBps: number;
  /** Your stake across pools that activates at a later epoch. */
  yourPendingStake: string;
  /** Antscan has not caught up with your latest transaction; your personal pool figures are omitted until it does. */
  walletSyncing?: boolean;
  explorer: string | null;
  /** 'indexer' = full pool statistics from the explorer; 'chain' = only the pools this wallet stakes in, read live. */
  source: DataSource;
  sourceError: string | null;
  pools: PoolView[];
}

export interface UsageEpochView {
  epoch: number;
  buyerPoints: string;
  weightedBuyerPoints: string;
  sellerPoints: string;
  agentId: number;
  totalBuyerPoints: string;
  totalSellerPoints: string;
  totalPoolPoints: string;
  totalWeightedPoolPoints: string;
}

export interface UsageView {
  currentEpoch: number;
  firstRewardedEpoch: number | null;
  epochs: UsageEpochView[];
  totals: { buyerPoints: string; buyerWeightedPoints: string; networkBuyerPoints: string; networkSellerPoints: string };
  pointsPolicy: string | null;
  poolWeightPolicy: string | null;
  minimumAccountedPoolPower: string | null;
  /** Per-epoch rows come from the indexer; without one the list is empty. */
  source: DataSource;
  sourceError: string | null;
}

/** `shareBps` is a share of the epoch emission in `EmissionsView.shareDenominator` units (100,000 = 100%). */
export interface MinterView { name: string; id: string; controller: string; shareBps: number; editable: boolean; epochBudget: string; }

export interface NetworkStakerConfig {
  minShareBps: number;
  maxShareBps: number;
  stakeShareTarget: string;
}

export interface NetworkUsageConfig {
  buyerMinShareBps: number;
  buyerMaxShareBps: number;
  sellerMinShareBps: number;
  sellerMaxShareBps: number;
  volumeShareTarget: string;
}

export interface NetworkSnapshot {
  chainId: string;
  evmChainId: number;
  blockNumber: number;
  blockTimestamp: number;
  fetchedAt: number;
  activation: 'active' | 'not-active' | 'unverified';
  epoch: EpochInfo;
  shareDenominator: number;
  initialEmission: string;
  halvingInterval: number;
  emission: string | null;
  nextEmission: string | null;
  cumulativeScheduled: string | null;
  totalSupply: string | null;
  maxSupply: string | null;
  totalActiveStake: string | null;
  totalPowerWeight: string | null;
  usageVolume: string | null;
  buckets: Array<{ name: string; id: string; controller: string | null; budget: string | null; nextBudget: string | null }>;
  budgets: { staker: string | null; buyer: string | null; seller: string | null };
  stakerConfig: NetworkStakerConfig | null;
  nextStakerConfig: NetworkStakerConfig | null;
  scaledStakeTarget: string | null;
  usageConfig: NetworkUsageConfig | null;
  nextUsageConfig: NetworkUsageConfig | null;
  contracts: Record<string, string>;
  errors: string[];
}

export interface EmissionsView {
  currentEpoch: number;
  effectiveEpoch: number | null;
  genesis: number;
  epochDuration: number;
  halvingInterval: number;
  initialEmission: string;
  currentRate: string;
  cumulativeThroughCurrent: string;
  shareDenominator: number;
  minters: MinterView[];
  emissionsReserve: string | null;
  legacyEscrow: string | null;
  /** Share values below use `shareDenominator` units of the epoch emission, not basis points. */
  dynamicStaker: { minShareBps: number; maxShareBps: number; stakeShareTarget: string } | null;
  dynamicUsage: { buyerMinShareBps: number; buyerMaxShareBps: number; sellerMinShareBps: number; sellerMaxShareBps: number; volumeShareTarget: string } | null;
  legacy: { contract: string; sellerPct: number; buyerPct: number; reservePct: number; teamPct: number; currentEpoch: number } | null;
}

export interface VerificationView {
  registry: {
    address: string; verifier: string; verifierHash: string; blockhashStore: string; sellerProgramVKey: string;
    periodStartBlock: number; periodEndBlock: number; thresholdBps: number;
  } | null;
  seller: {
    seller: string; provenWashVolume: string; totalSellerVolume: string; provenWashShareBps: number;
    evidenceDigest: string; isProvenWashTrader: boolean;
  } | null;
  policies: Array<{ address: string; washTradingRegistry: string | null }>;
  pointsPolicy: string | null;
  enforced: boolean;
}

export interface ProofStatusView {
  proofId: string; staged: boolean; finalized: boolean;
  authenticatedBlockReferenceCount: number; authenticatedBlockChunkCount: number;
}

export interface SellerView {
  address: string;
  agentId: number;
  identityRegistered: boolean;
  registryBound: boolean;
  eligible: boolean;
  legacyStake: string;
  legacyEligibilityEnabled: boolean | null;
  minPoolStake: string | null;
  poolActiveStake: string;
  starter: {
    contract: string | null; initialized: boolean; remaining: string; amount: string; endEpoch: number;
    legacyEligible: boolean; expired: boolean; claimable: boolean;
  } | null;
}

export interface JobStep { at: number; label: string; hash?: string; }
export interface JobView {
  id: string;
  kind: string;
  /** Signing wallet that started the job (browser sessions; absent for local-signer runs). */
  owner?: string;
  status: 'running' | 'done' | 'failed';
  steps: JobStep[];
  result?: unknown;
  error?: string;
  startedAt: number;
  finishedAt?: number;
}

// ── action payloads ────────────────────────────────────────────────────
export interface StakeRequest { agentId: number; amount: string; epochs: number; }
export interface MoveRequest { positionIds: number[]; toAgentId: number; }
export interface SplitRequest { positionId: number; amount: string; }
export interface MergeRequest { positionIds: number[]; }
export interface ExtendRequest { positionId: number; epochs: number; }
export interface MaxLockRequest { positionId: number; enable: boolean; }
export interface WithdrawRequest { positionIds: number[]; acceptSlashing: boolean; maxSlashedAmount?: string; }
export type RewardBucket = 'staker' | 'seller' | 'buyer' | 'legacy' | 'locked';
export interface ClaimRequest { buckets: RewardBucket[]; recipient?: string; scope?: 'buyer' | 'wallet'; expectedLegacySellerRecipient?: string; }
export interface RestakeRequest { positionIds?: number[]; epochs: number; }
export interface StakeUsageRequest { side: 'seller' | 'buyer'; epochs: number; stakeAgentId?: number; }
/** Restake staker + seller usage (+ buyer usage when operator) rewards in one job; `targetAgentId` moves the new positions into that pool. */
export interface CompoundRequest { includeBuyer?: boolean; epochs: number; targetAgentId?: number; stakeAgentId?: number; }
export interface SubmitProofRequest { artifact: unknown; }
