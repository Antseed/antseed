// Write-action hooks — wrap wagmi's useWriteContract for each on-chain call.
// Each hook returns a `run(args)` function the UI invokes on button click,
// plus `isPending` for spinner state and `error` for inline display.

import { useCallback, useState } from 'react';
import { usePublicClient, useWriteContract } from 'wagmi';
import { parseEther, maxUint256 } from 'viem';

import { DIEM_TOKEN, DIEM_STAKING_PROXY } from './addresses';
import { DIEM_STAKING_PROXY_ABI, DIEM_TOKEN_ABI } from './abi';
import { DIEM_CHAIN_ID, useDiemNetwork } from './network';

export function useApproveDiem() {
  const { writeContractAsync, isPending, error, reset } = useWriteContract();
  const { ensureDiemNetwork, isSwitchingChain } = useDiemNetwork();
  const run = useCallback(async () => {
    await ensureDiemNetwork();
    return writeContractAsync({
      address: DIEM_TOKEN,
      abi: DIEM_TOKEN_ABI,
      functionName: 'approve',
      chainId: DIEM_CHAIN_ID,
      args: [DIEM_STAKING_PROXY, maxUint256],
    });
  }, [ensureDiemNetwork, writeContractAsync]);
  return { run, isPending: isPending || isSwitchingChain, error, reset };
}

export function useStake() {
  const { writeContractAsync, isPending, error, reset } = useWriteContract();
  const { ensureDiemNetwork, isSwitchingChain } = useDiemNetwork();
  const run = useCallback(
    async (amountDiem: string) => {
      const amt = parseEther(amountDiem);
      await ensureDiemNetwork();
      return writeContractAsync({
        address: DIEM_STAKING_PROXY,
        abi: DIEM_STAKING_PROXY_ABI,
        functionName: 'stake',
        chainId: DIEM_CHAIN_ID,
        args: [amt],
      });
    },
    [ensureDiemNetwork, writeContractAsync],
  );
  return { run, isPending: isPending || isSwitchingChain, error, reset };
}

export function useInitiateUnstake() {
  const { writeContractAsync, isPending, error, reset } = useWriteContract();
  const { ensureDiemNetwork, isSwitchingChain } = useDiemNetwork();
  const run = useCallback(
    async (amountDiem: string) => {
      const amt = parseEther(amountDiem);
      await ensureDiemNetwork();
      return writeContractAsync({
        address: DIEM_STAKING_PROXY,
        abi: DIEM_STAKING_PROXY_ABI,
        functionName: 'initiateUnstake',
        chainId: DIEM_CHAIN_ID,
        args: [amt],
      });
    },
    [ensureDiemNetwork, writeContractAsync],
  );
  return { run, isPending: isPending || isSwitchingChain, error, reset };
}

export function useFlush() {
  const { writeContractAsync, isPending, error, reset } = useWriteContract();
  const { ensureDiemNetwork, isSwitchingChain } = useDiemNetwork();
  const run = useCallback(async () => {
    await ensureDiemNetwork();
    return writeContractAsync({
      address: DIEM_STAKING_PROXY,
      abi: DIEM_STAKING_PROXY_ABI,
      functionName: 'flush',
      chainId: DIEM_CHAIN_ID,
    });
  }, [ensureDiemNetwork, writeContractAsync]);
  return { run, isPending: isPending || isSwitchingChain, error, reset };
}

export function useClaimUnstakeBatch() {
  const { writeContractAsync, isPending, error, reset } = useWriteContract();
  const { ensureDiemNetwork, isSwitchingChain } = useDiemNetwork();
  const run = useCallback(
    async (batchId: number) => {
      await ensureDiemNetwork();
      return writeContractAsync({
        address: DIEM_STAKING_PROXY,
        abi: DIEM_STAKING_PROXY_ABI,
        functionName: 'claimUnstakeBatch',
        chainId: DIEM_CHAIN_ID,
        args: [batchId],
      });
    },
    [ensureDiemNetwork, writeContractAsync],
  );
  return { run, isPending: isPending || isSwitchingChain, error, reset };
}

export function useClaimUsdc() {
  const { writeContractAsync, isPending, error, reset } = useWriteContract();
  const { ensureDiemNetwork, isSwitchingChain } = useDiemNetwork();
  const run = useCallback(async () => {
    await ensureDiemNetwork();
    return writeContractAsync({
      address: DIEM_STAKING_PROXY,
      abi: DIEM_STAKING_PROXY_ABI,
      functionName: 'claimUsdc',
      chainId: DIEM_CHAIN_ID,
    });
  }, [ensureDiemNetwork, writeContractAsync]);
  return { run, isPending: isPending || isSwitchingChain, error, reset };
}

/** Claim ANTS for explicit completed reward epochs. */
export function useClaimAnts() {
  const { writeContractAsync, isPending, error, reset } = useWriteContract();
  const { ensureDiemNetwork, isSwitchingChain } = useDiemNetwork();
  const run = useCallback(
    async (rewardEpochs: number[]) => {
      await ensureDiemNetwork();
      return writeContractAsync({
        address: DIEM_STAKING_PROXY,
        abi: DIEM_STAKING_PROXY_ABI,
        functionName: 'claimAnts',
        chainId: DIEM_CHAIN_ID,
        args: [rewardEpochs],
      });
    },
    [ensureDiemNetwork, writeContractAsync],
  );
  return { run, isPending: isPending || isSwitchingChain, error, reset };
}

/**
 * Clear a reward-epoch backlog that blocks every write. `catchUpPoints`
 * processes the caller's own epochs (and syncs the pool first);
 * `syncRewardEpochs` only syncs the pool, for wallets with nothing locked.
 * Resolves only once the transaction is mined successfully, so the caller can
 * refetch the backlog and offer the next batch without a duplicate submit.
 */
export function useCatchUp() {
  const { writeContractAsync, isPending, error, reset } = useWriteContract();
  const { ensureDiemNetwork, isSwitchingChain } = useDiemNetwork();
  const publicClient = usePublicClient({ chainId: DIEM_CHAIN_ID });
  const [isConfirming, setIsConfirming] = useState(false);
  const [receiptError, setReceiptError] = useState<Error | null>(null);
  const run = useCallback(
    async (kind: 'user' | 'pool', numEpochs: number) => {
      setReceiptError(null);
      await ensureDiemNetwork();
      const hash = await writeContractAsync({
        address: DIEM_STAKING_PROXY,
        abi: DIEM_STAKING_PROXY_ABI,
        functionName: kind === 'user' ? 'catchUpPoints' : 'syncRewardEpochs',
        chainId: DIEM_CHAIN_ID,
        args: [numEpochs],
      });
      if (!publicClient) throw new Error('No Base RPC client available');
      setIsConfirming(true);
      try {
        const receipt = await publicClient.waitForTransactionReceipt({ hash });
        if (receipt.status !== 'success') {
          const err = new Error('Update transaction reverted');
          setReceiptError(err);
          throw err;
        }
        return hash;
      } finally {
        setIsConfirming(false);
      }
    },
    [ensureDiemNetwork, publicClient, writeContractAsync],
  );
  return { run, isPending: isPending || isSwitchingChain || isConfirming, error: error ?? receiptError, reset };
}
