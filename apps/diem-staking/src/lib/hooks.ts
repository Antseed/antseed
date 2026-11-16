
import { useEffect, useMemo, useState } from 'react';
import { useAccount, useReadContract, useReadContracts } from 'wagmi';
import type { Address } from 'viem';

import { DIEM_TOKEN, DIEM_STAKING_PROXY, isAddressSet } from './addresses';
import { DIEM_STAKING_PROXY_ABI, DIEM_TOKEN_ABI } from './abi';
import { computeEpochClock, type EpochClock } from './epoch';
import { DIEM_CHAIN_ID } from './network';

// First Staked event on the deployed proxy: tx
// 0x02dd13f8d519d7ac81eceaacd40c3e485f76b2a7f584b094fb7e816b44f822a4
// at block 45265606, Apr-27-2026 20:09:19 UTC. Hardcoded so the page does not
// need a separate eth_getLogs round-trip just to learn the pool's birth date.
const POOL_GENESIS_UNIX = 1_777_320_559;

const POLL_MS = 12_000; // a bit above Base's 2s block time × a few blocks
const DEXSCREENER_TOKEN_URL = `https://api.dexscreener.com/latest/dex/tokens/${DIEM_TOKEN}`;

async function fetchDiemPriceFromCoinGecko(): Promise<number | null> {
  try {
    const r = await fetch(
      `https://api.coingecko.com/api/v3/simple/token_price/base?contract_addresses=${DIEM_TOKEN}&vs_currencies=usd`,
    );
    const data = (await r.json()) as Record<string, { usd?: number }> | null;
    const p = data?.[DIEM_TOKEN.toLowerCase()]?.usd;
    if (typeof p === 'number' && p > 0) return p;
  } catch {
  }

  try {
    const r = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=diem&vs_currencies=usd');
    const data = (await r.json()) as { diem?: { usd?: number } } | null;
    const p = data?.diem?.usd;
    if (typeof p === 'number' && p > 0) return p;
  } catch {
  }

  return null;
}

async function fetchDiemPriceFromDexScreener(): Promise<number | null> {
  try {
    const r = await fetch(DEXSCREENER_TOKEN_URL);
    const data = (await r.json()) as {
      pairs?: Array<{
        chainId?: string;
        priceUsd?: string;
        liquidity?: { usd?: number };
        baseToken?: { address?: string };
        quoteToken?: { address?: string };
      }>;
    } | null;

    const token = DIEM_TOKEN.toLowerCase();
    const pairs = (data?.pairs ?? [])
      .filter((pair) => pair.chainId === 'base')
      // DexScreener's `priceUsd` is the USD price of the pair's base token.
      // Only use pairs where DIEM is the base token; otherwise we'd read the
      // other token's price when DIEM is the quote token.
      .filter((pair) => pair.baseToken?.address?.toLowerCase() === token)
      .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0));

    for (const pair of pairs) {
      const price = Number(pair.priceUsd);
      if (Number.isFinite(price) && price > 0) return price;
    }
  } catch {
  }
  return null;
}

export function useProxyDeployed(): boolean {
  return isAddressSet(DIEM_STAKING_PROXY);
}


export function useDiemPrice(): number | null {
  const [price, setPrice] = useState<number | null>(null);
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const nextPrice = await fetchDiemPriceFromCoinGecko() ?? await fetchDiemPriceFromDexScreener();
      if (!cancelled && nextPrice != null) setPrice(nextPrice);
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  return price;
}


export function useEpochClock(): EpochClock {
  const [clock, setClock] = useState<EpochClock>(() => computeEpochClock(Math.floor(Date.now() / 1000)));
  useEffect(() => {
    const id = setInterval(() => {
      setClock(computeEpochClock(Math.floor(Date.now() / 1000)));
    }, 1000);
    return () => clearInterval(id);
  }, []);
  return clock;
}


export interface PoolStats {
  totalStaked: bigint | null;
  stakerCount: number | null;
  totalUsdcDistributedEver: bigint | null;
  maxTotalStake: bigint | null;
  firstRewardEpoch: number | null;
  syncedRewardEpoch: number | null;
  finalizedRewardEpoch: number | null;
  diemCooldownSecs: number | null;
  minUnstakeBatchOpenSecs: number | null;
  flushableAt: number | null;
  isLoading: boolean;
}

export function usePoolStats(): PoolStats {
  const deployed = useProxyDeployed();
  const { data, isLoading } = useReadContracts({
    allowFailure: true,
    contracts: [
      { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'totalStaked', chainId: DIEM_CHAIN_ID },
      { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'stakerCount', chainId: DIEM_CHAIN_ID },
      { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'totalUsdcDistributedEver', chainId: DIEM_CHAIN_ID },
      { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'maxTotalStake', chainId: DIEM_CHAIN_ID },
      { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'firstRewardEpoch', chainId: DIEM_CHAIN_ID },
      { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'syncedRewardEpoch', chainId: DIEM_CHAIN_ID },
      { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'finalizedRewardEpoch', chainId: DIEM_CHAIN_ID },
      { address: DIEM_TOKEN,         abi: DIEM_TOKEN_ABI,         functionName: 'cooldownDuration', chainId: DIEM_CHAIN_ID },
      { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'minUnstakeBatchOpenSecs', chainId: DIEM_CHAIN_ID },
      { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'flushableAt', chainId: DIEM_CHAIN_ID },
    ],
    query: { enabled: deployed, refetchInterval: POLL_MS },
  });

  if (!deployed || !data) {
    return {
      totalStaked: null,
      stakerCount: null,
      totalUsdcDistributedEver: null,
      maxTotalStake: null,
      firstRewardEpoch: null,
      syncedRewardEpoch: null,
      finalizedRewardEpoch: null,
      diemCooldownSecs: null,
      minUnstakeBatchOpenSecs: null,
      flushableAt: null,
      isLoading,
    };
  }
  const flushableAtRaw = data[9]?.result != null ? Number(data[9].result) : null;
  return {
    totalStaked: data[0]?.result ?? null,
    stakerCount: data[1]?.result != null ? Number(data[1].result) : null,
    totalUsdcDistributedEver: data[2]?.result ?? null,
    maxTotalStake: data[3]?.result ?? null,
    firstRewardEpoch: data[4]?.result != null ? Number(data[4].result) : null,
    syncedRewardEpoch: data[5]?.result != null ? Number(data[5].result) : null,
    finalizedRewardEpoch: data[6]?.result != null ? Number(data[6].result) : null,
    diemCooldownSecs: data[7]?.result != null ? Number(data[7].result) : null,
    minUnstakeBatchOpenSecs: data[8]?.result != null ? Number(data[8].result) : null,
    flushableAt: flushableAtRaw && flushableAtRaw > 0 ? flushableAtRaw : null,
    isLoading,
  };
}


export interface UserStats {
  walletDiem: bigint | null;
  stakedDiem: bigint | null;
  pendingUsdc: bigint | null;
  pendingAnts: bigint | null;
  claimableAntsEpochs: number[];
  hasMoreClaimableAntsEpochs: boolean;
  userLastClaimedEpoch: number | null;
  isLoading: boolean;
}

export function useUserStats(): UserStats {
  const { address } = useAccount();
  const deployed = useProxyDeployed();
  const enabled = deployed && !!address;

  const { data: simple, isLoading: loadingSimple } = useReadContracts({
    allowFailure: true,
    contracts: enabled
      ? [
          { address: DIEM_TOKEN,         abi: DIEM_TOKEN_ABI,         functionName: 'balanceOf', args: [address!], chainId: DIEM_CHAIN_ID },
          { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'staked',    args: [address!], chainId: DIEM_CHAIN_ID },
          { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'earnedUsdc', args: [address!], chainId: DIEM_CHAIN_ID },
          { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'userLastClaimedEpoch', args: [address!], chainId: DIEM_CHAIN_ID },
        ]
      : [],
    query: { enabled, refetchInterval: POLL_MS },
  });

  const userLastClaimedEpoch = simple?.[3]?.result != null ? Number(simple[3].result) : null;
  const { pendingAnts, claimableEpochs, hasMoreClaimableEpochs, isLoading: loadingAnts } = usePendingAnts(
    address ?? null,
    userLastClaimedEpoch,
  );

  if (!enabled) {
    return {
      walletDiem: null,
      stakedDiem: null,
      pendingUsdc: null,
      pendingAnts: null,
      claimableAntsEpochs: [],
      hasMoreClaimableAntsEpochs: false,
      userLastClaimedEpoch: null,
      isLoading: loadingSimple,
    };
  }
  return {
    walletDiem: simple?.[0]?.result ?? null,
    stakedDiem: simple?.[1]?.result ?? null,
    pendingUsdc: simple?.[2]?.result ?? null,
    pendingAnts,
    claimableAntsEpochs: claimableEpochs,
    hasMoreClaimableAntsEpochs: hasMoreClaimableEpochs,
    userLastClaimedEpoch,
    isLoading: loadingSimple || loadingAnts,
  };
}

const MAX_EPOCHS_PREVIEW = 16;

function usePendingAnts(
  user: Address | null,
  userLastClaimedEpoch: number | null,
): { pendingAnts: bigint | null; claimableEpochs: number[]; hasMoreClaimableEpochs: boolean; isLoading: boolean } {
  const { firstRewardEpoch, finalizedRewardEpoch } = usePoolStats();

  const epochsToRead = useMemo(() => {
    if (user == null || userLastClaimedEpoch == null || firstRewardEpoch == null || finalizedRewardEpoch == null) return [];
    const from = Math.max(userLastClaimedEpoch, firstRewardEpoch);
    const to = Math.min(finalizedRewardEpoch, from + MAX_EPOCHS_PREVIEW);
    const out: number[] = [];
    for (let e = from; e < to; e++) out.push(e);
    return out;
  }, [user, userLastClaimedEpoch, firstRewardEpoch, finalizedRewardEpoch]);

  const hasMoreClaimableEpochs = useMemo(() => {
    if (user == null || userLastClaimedEpoch == null || firstRewardEpoch == null || finalizedRewardEpoch == null) return false;
    const from = Math.max(userLastClaimedEpoch, firstRewardEpoch);
    return from + MAX_EPOCHS_PREVIEW < finalizedRewardEpoch;
  }, [user, userLastClaimedEpoch, firstRewardEpoch, finalizedRewardEpoch]);

  const { data: pendingData, isLoading: loadingPending } = useReadContracts({
    allowFailure: true,
    contracts: epochsToRead.map((e) => ({
      address: DIEM_STAKING_PROXY,
      abi: DIEM_STAKING_PROXY_ABI,
      functionName: 'pendingAntsForEpoch' as const,
      chainId: DIEM_CHAIN_ID,
      args: [user!, e] as const,
    })),
    query: { enabled: epochsToRead.length > 0, refetchInterval: POLL_MS },
  });

  const { data: claimedData, isLoading: loadingClaimed } = useReadContracts({
    allowFailure: true,
    contracts: epochsToRead.map((e) => ({
      address: DIEM_STAKING_PROXY,
      abi: DIEM_STAKING_PROXY_ABI,
      functionName: 'userEpochClaimed' as const,
      chainId: DIEM_CHAIN_ID,
      args: [user!, e] as const,
    })),
    query: { enabled: epochsToRead.length > 0, refetchInterval: POLL_MS },
  });

  const pendingAnts = useMemo<bigint | null>(() => {
    if (user == null) return null;
    if (epochsToRead.length === 0) return 0n;
    if (!pendingData) return null;
    let sum = 0n;
    for (const r of pendingData) {
      if (typeof r.result === 'bigint') sum += r.result;
    }
    return sum;
  }, [user, epochsToRead.length, pendingData]);

  const claimableEpochs = useMemo<number[]>(() => {
    if (user == null || epochsToRead.length === 0 || !claimedData) return [];
    return epochsToRead.filter((_, i) => claimedData[i]?.result !== true);
  }, [user, epochsToRead, claimedData]);

  return { pendingAnts, claimableEpochs, hasMoreClaimableEpochs, isLoading: loadingPending || loadingClaimed };
}


export type UnstakeState =
  | { status: 'none' }
  | { status: 'queued'; batchId: number; amount: bigint; waitingForPriorBatch: boolean }
  | { status: 'cooling'; batchId: number; amount: bigint; unlockAt: number }
  | { status: 'claimable'; batchId: number; amount: bigint };

export function useUnstakeState(): { state: UnstakeState; isLoading: boolean } {
  const { address } = useAccount();
  const deployed = useProxyDeployed();

  const { data: clockData, isLoading: loadingClock } = useReadContracts({
    allowFailure: true,
    contracts: deployed
      ? [
          { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'currentUnstakeBatch', chainId: DIEM_CHAIN_ID },
          { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'oldestUnclaimedUnstakeBatch', chainId: DIEM_CHAIN_ID },
        ]
      : [],
    query: { enabled: deployed, refetchInterval: POLL_MS },
  });

  const currentUnstakeBatch = clockData?.[0]?.result != null ? Number(clockData[0].result) : null;
  const oldestUnclaimedUnstakeBatch = clockData?.[1]?.result != null ? Number(clockData[1].result) : null;

  const batchIds = useMemo(() => {
    if (currentUnstakeBatch == null || oldestUnclaimedUnstakeBatch == null) return [];
    const ids: number[] = [];
    for (
      let batch = oldestUnclaimedUnstakeBatch;
      batch <= currentUnstakeBatch && batch < oldestUnclaimedUnstakeBatch + 4;
      batch++
    ) {
      ids.push(batch);
    }
    return ids;
  }, [currentUnstakeBatch, oldestUnclaimedUnstakeBatch]);

  const { data: amtData, isLoading: loadingAmts } = useReadContracts({
    allowFailure: true,
    contracts:
      deployed && address && batchIds.length > 0
        ? batchIds.map((batch) => ({
            address: DIEM_STAKING_PROXY,
            abi: DIEM_STAKING_PROXY_ABI,
            functionName: 'unstakeBatchUserAmount' as const,
            chainId: DIEM_CHAIN_ID,
            args: [batch, address] as const,
          }))
        : [],
    query: { enabled: deployed && !!address && batchIds.length > 0, refetchInterval: POLL_MS },
  });

  const activeBatchIdx = useMemo(() => {
    if (!amtData) return -1;
    for (let i = 0; i < amtData.length; i++) {
      const r = amtData[i]?.result;
      if (typeof r === 'bigint' && r > 0n) return i;
    }
    return -1;
  }, [amtData]);

  const activeBatchId = activeBatchIdx >= 0 ? batchIds[activeBatchIdx] : null;
  const activeAmount =
    activeBatchIdx >= 0 ? (amtData?.[activeBatchIdx]?.result as bigint | undefined) ?? null : null;

  const { data: batchDetail, isLoading: loadingBatchDetail } = useReadContract({
    address: DIEM_STAKING_PROXY,
    abi: DIEM_STAKING_PROXY_ABI,
    functionName: 'unstakeBatches',
    chainId: DIEM_CHAIN_ID,
    args: activeBatchId != null ? [activeBatchId] : undefined,
    query: { enabled: deployed && activeBatchId != null, refetchInterval: POLL_MS },
  });

  const state = useMemo<UnstakeState>(() => {
    if (activeBatchId == null || activeAmount == null || activeAmount === 0n) return { status: 'none' };
    if (!batchDetail) return { status: 'none' };
    const [, unlockAtRaw, , claimed] = batchDetail as readonly [bigint, bigint, number, boolean];
    const unlockAt = Number(unlockAtRaw);
    const now = Math.floor(Date.now() / 1000);

    if (unlockAt === 0) {
      const waitingForPriorBatch = currentUnstakeBatch != null && oldestUnclaimedUnstakeBatch != null && currentUnstakeBatch !== oldestUnclaimedUnstakeBatch;
      return { status: 'queued', batchId: activeBatchId!, amount: activeAmount!, waitingForPriorBatch };
    }
    if (!claimed && now < unlockAt) {
      return { status: 'cooling', batchId: activeBatchId!, amount: activeAmount!, unlockAt };
    }
    if (!claimed && now >= unlockAt) {
      return { status: 'claimable', batchId: activeBatchId!, amount: activeAmount! };
    }
    return { status: 'none' };
  }, [activeBatchId, activeAmount, batchDetail, currentUnstakeBatch, oldestUnclaimedUnstakeBatch]);

  return { state, isLoading: loadingClock || loadingAmts || loadingBatchDetail };
}


export function usePoolAgeDays(): { poolAgeDays: number | null; isLoading: boolean } {
  const [nowSecs, setNowSecs] = useState(() => Math.floor(Date.now() / 1000));
  useEffect(() => {
    const id = setInterval(() => setNowSecs(Math.floor(Date.now() / 1000)), 60_000);
    return () => clearInterval(id);
  }, []);
  const elapsedSecs = nowSecs - POOL_GENESIS_UNIX;
  if (elapsedSecs <= 0) return { poolAgeDays: null, isLoading: false };
  return { poolAgeDays: Math.max(elapsedSecs / 86_400, 1 / 24), isLoading: false };
}

export function useDiemAllowance(): { allowance: bigint | null; refetch: () => void } {
  const { address } = useAccount();
  const deployed = useProxyDeployed();
  const enabled = deployed && !!address;
  const { data, refetch } = useReadContract({
    address: DIEM_TOKEN,
    abi: DIEM_TOKEN_ABI,
    functionName: 'allowance',
    chainId: DIEM_CHAIN_ID,
    args: enabled ? [address!, DIEM_STAKING_PROXY] : undefined,
    query: { enabled, refetchInterval: POLL_MS },
  });
  return { allowance: (data as bigint | undefined) ?? null, refetch: () => { void refetch(); } };
}


// Epochs a single catch-up transaction processes. The contract has no cap on
// catchUpPoints; this keeps gas well inside a block for long backlogs, and the
// notice reappears with the rest once the transaction lands.
const MAX_CATCH_UP_EPOCHS_PER_TX = 48;

export type CatchUpState =
  | { status: 'none' }
  | { status: 'needed'; kind: 'user' | 'pool'; epochsBehind: number; epochsThisTx: number };

/**
 * Every write except claimUnstakeBatch reverts with BacklogTooLarge() once the
 * pool or the wallet is more than MAX_EPOCHS_PER_CAPTURE reward epochs behind.
 * A wallet that stays locked without touching the contract for that long is
 * stuck until it calls catchUpPoints; this reports when that is needed.
 */
export function useCatchUpState(stakedDiem: bigint | null): { state: CatchUpState; refetch: () => Promise<unknown> } {
  const { address } = useAccount();
  const deployed = useProxyDeployed();
  const enabled = deployed && !!address;

  const { data, refetch } = useReadContracts({
    allowFailure: true,
    contracts: enabled
      ? [
          { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'MAX_EPOCHS_PER_CAPTURE', chainId: DIEM_CHAIN_ID },
          { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'syncBacklog', chainId: DIEM_CHAIN_ID },
          { address: DIEM_STAKING_PROXY, abi: DIEM_STAKING_PROXY_ABI, functionName: 'userPointsBacklog', args: [address!], chainId: DIEM_CHAIN_ID },
        ]
      : [],
    query: { enabled, refetchInterval: POLL_MS },
  });

  const state = useMemo<CatchUpState>(() => {
    const cap = data?.[0]?.result;
    const pool = data?.[1]?.result;
    const user = data?.[2]?.result;
    if (cap == null || pool == null || user == null) return { status: 'none' };

    const poolBehind = pool[2];
    const hasStake = stakedDiem != null && stakedDiem > 0n;

    // updateRewards syncs the pool first and then captures the wallet's points
    // up to the new synced epoch, so a wallet with a stake is limited by the
    // sum of both backlogs. catchUpPoints(n) also syncs up to n pool epochs
    // before moving the wallet up to n epochs, so n = the sum clears both.
    if (hasStake && user[2] + poolBehind > cap) {
      const epochsBehind = user[2] + poolBehind;
      return {
        status: 'needed',
        kind: 'user',
        epochsBehind,
        epochsThisTx: Math.min(epochsBehind, MAX_CATCH_UP_EPOCHS_PER_TX),
      };
    }
    if (poolBehind > cap) {
      return {
        status: 'needed',
        kind: 'pool',
        epochsBehind: poolBehind,
        epochsThisTx: Math.min(poolBehind, MAX_CATCH_UP_EPOCHS_PER_TX),
      };
    }
    return { status: 'none' };
  }, [data, stakedDiem]);

  return { state, refetch };
}
