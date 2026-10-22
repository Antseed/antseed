// The few things Antscan can't answer: this epoch's buyer/provider pots,
// exact claimable amounts, token balance/allowance — plus every write.
import { createPublicClient, fallback, http, parseAbi, type Address } from 'viem';
import { base } from 'viem/chains';
import { DEPLOYED_CONTRACT_ADDRESSES } from '@antseed/contract-addresses';

const mainnet = DEPLOYED_CONTRACT_ADDRESSES['base-mainnet'];

export const CHAIN = base;

export const CONTRACTS = {
  ants: mainnet.antsTokenAddress as Address,
  deposits: mainnet.depositsContractAddress as Address,
  usageAccounting: mainnet.usageAccountingAddress as Address,
  usageRewards: mainnet.usageRewardsAddress as Address,
  sellerPools: mainnet.sellerPoolsAddress as Address,
  sellerPoolsRewards: mainnet.sellerPoolsRewardsAddress as Address,
} as const;

// Same RPC fallback order as apps/diem-staking and apps/payments.
export const RPC_URLS = [
  'https://base-rpc.publicnode.com',
  'https://base.gateway.tenderly.co',
  'https://base-public.nodies.app',
  'https://mainnet.base.org',
];

export const publicClient = createPublicClient({
  chain: base,
  transport: fallback(RPC_URLS.map((url) => http(url))),
  batch: { multicall: true },
});

export const ABI = {
  ants: parseAbi([
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address owner, address spender) view returns (uint256)',
    'function approve(address spender, uint256 amount) returns (bool)',
    'function transfersEnabled() view returns (bool)',
  ]),
  deposits: parseAbi([
    // Buyer rewards go to the buyer's operator (the user's own wallet), never the hot wallet.
    'function getOperator(address buyer) view returns (address)',
  ]),
  usageRewards: parseAbi([
    'function usageEpochBudgets(uint256 epoch) view returns (uint256 buyerBudget, uint256 sellerBudget)',
    'function pendingBuyerReward(address buyer, uint256 epoch) view returns (uint256)',
    'function buyerEpochClaimed(address buyer, uint256 epoch) view returns (bool)',
    'function claimBuyerReward(address buyer, uint256 epoch)',
    // Mints the reward straight into a stake position: works before ANTS transfers open.
    'function stakeBuyerReward(address buyer, uint256 epoch, uint256 stakeAgentId, uint256 stakeEpochs) returns (uint256)',
  ]),
  sellerPools: parseAbi([
    'function poolWeightAtEpoch(uint256 agentId, uint256 epoch) view returns (uint256)',
    'function stake(uint256 agentId, uint256 amount, uint256 stakeEpochs) returns (uint256)',
    'function enableMaxLock(uint256 positionId)',
    'event StakeCreated(uint256 indexed positionId, address indexed staker, uint256 indexed agentId, uint256 amount, uint256 weightAmount, uint256 stakeStartEpoch, uint256 stakeEndEpoch)',
  ]),
  sellerPoolsRewards: parseAbi([
    'function pendingStakerReward(uint256 positionId, uint256 epoch) view returns (uint256)',
    'function claimStakerRewards(uint256 positionId, address recipient)',
    'function restakeStakerRewards(uint256 positionId, uint256 stakeEpochs) returns (uint256)',
  ]),
} as const;

export async function readTransfersEnabled(): Promise<boolean> {
  return publicClient.readContract({ address: CONTRACTS.ants, abi: ABI.ants, functionName: 'transfersEnabled' });
}

/** The wallet allowed to claim or stake this buyer's rewards (zero address = none set). */
export async function readOperator(buyer: Address): Promise<Address> {
  return publicClient.readContract({ address: CONTRACTS.deposits, abi: ABI.deposits, functionName: 'getOperator', args: [buyer] });
}

export async function readUsagePots(epoch: number): Promise<{ buyerPot: bigint; sellerPot: bigint }> {
  const [buyerPot, sellerPot] = await publicClient.readContract({
    address: CONTRACTS.usageRewards,
    abi: ABI.usageRewards,
    functionName: 'usageEpochBudgets',
    args: [BigInt(epoch)],
  });
  return { buyerPot, sellerPot };
}

/** Buyer pot per epoch, one multicall. */
export async function readBuyerPots(epochs: number[]): Promise<Map<number, bigint>> {
  const results = await publicClient.multicall({
    contracts: epochs.map((e) => ({
      address: CONTRACTS.usageRewards,
      abi: ABI.usageRewards,
      functionName: 'usageEpochBudgets' as const,
      args: [BigInt(e)] as const,
    })),
    allowFailure: true,
  });
  const out = new Map<number, bigint>();
  results.forEach((r, i) => out.set(epochs[i]!, r.status === 'success' ? (r.result as readonly [bigint, bigint])[0] : 0n));
  return out;
}

export async function readNextWeekWeight(agentId: string, epoch: number): Promise<bigint> {
  return publicClient.readContract({
    address: CONTRACTS.sellerPools,
    abi: ABI.sellerPools,
    functionName: 'poolWeightAtEpoch',
    args: [BigInt(agentId), BigInt(epoch + 1)],
  });
}

/** Claimable buyer ANTS per finished epoch, read in one multicall. */
export async function readPendingBuyer(address: Address, epochs: number[]): Promise<Map<number, bigint>> {
  const results = await publicClient.multicall({
    contracts: epochs.map((e) => ({
      address: CONTRACTS.usageRewards,
      abi: ABI.usageRewards,
      functionName: 'pendingBuyerReward' as const,
      args: [address, BigInt(e)] as const,
    })),
    allowFailure: true,
  });
  const out = new Map<number, bigint>();
  results.forEach((r, i) => out.set(epochs[i]!, r.status === 'success' ? (r.result as bigint) : 0n));
  return out;
}

export async function readPendingStaker(positionIds: string[], epochs: number[]): Promise<Map<string, bigint>> {
  const calls = positionIds.flatMap((id) =>
    epochs.map((e) => ({
      address: CONTRACTS.sellerPoolsRewards,
      abi: ABI.sellerPoolsRewards,
      functionName: 'pendingStakerReward' as const,
      args: [BigInt(id), BigInt(e)] as const,
    })),
  );
  const results = await publicClient.multicall({ contracts: calls, allowFailure: true });
  const out = new Map<string, bigint>();
  positionIds.forEach((id, i) => {
    let sum = 0n;
    epochs.forEach((_, j) => {
      const r = results[i * epochs.length + j];
      if (r?.status === 'success') sum += r.result as bigint;
    });
    out.set(id, sum);
  });
  return out;
}

export async function readAntsBalance(address: Address): Promise<{ balance: bigint; allowance: bigint }> {
  const [balance, allowance] = await publicClient.multicall({
    contracts: [
      { address: CONTRACTS.ants, abi: ABI.ants, functionName: 'balanceOf', args: [address] },
      { address: CONTRACTS.ants, abi: ABI.ants, functionName: 'allowance', args: [address, CONTRACTS.sellerPools] },
    ],
    allowFailure: false,
  });
  return { balance, allowance };
}
