// Every write the site makes. Each one is a plain contract call the user signs
// in their own wallet; nothing is sent without an explicit click.
import { useCallback, useState } from 'react';
import { decodeEventLog, parseUnits, type Address, type Hash } from 'viem';
import { useAccount, useSwitchChain, useWriteContract } from 'wagmi';
import { useQueryClient } from '@tanstack/react-query';
import { ABI, CHAIN, CONTRACTS, publicClient } from './chain';
import { MAX_LOCK_EPOCHS } from './points';

export type ActionStep = { label: string; state: 'todo' | 'now' | 'done' };

export function useWallet() {
  const { address, chainId, isConnected } = useAccount();
  return { address: address?.toLowerCase() as Address | undefined, onBase: chainId === CHAIN.id, isConnected };
}

export function useActions() {
  const { writeContractAsync } = useWriteContract();
  const { switchChainAsync } = useSwitchChain();
  const { chainId } = useAccount();
  const queryClient = useQueryClient();
  const [steps, setSteps] = useState<ActionStep[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastTx, setLastTx] = useState<Hash | null>(null);

  const run = useCallback(
    async (labels: string[], body: (advance: () => void, send: typeof sendAndWait) => Promise<void>) => {
      setError(null);
      setBusy(true);
      let i = 0;
      setSteps(labels.map((label, k) => ({ label, state: k === 0 ? 'now' : 'todo' })));
      const advance = () => {
        i += 1;
        setSteps(labels.map((label, k) => ({ label, state: k < i ? 'done' : k === i ? 'now' : 'todo' })));
      };
      try {
        if (chainId !== CHAIN.id) await switchChainAsync({ chainId: CHAIN.id });
        await body(advance, sendAndWait);
        setSteps(labels.map((label) => ({ label, state: 'done' })));
        await queryClient.invalidateQueries();
      } catch (e) {
        const msg = (e as { shortMessage?: string; message?: string }).shortMessage ?? (e as Error).message ?? 'Transaction failed';
        setError(msg.includes('User rejected') ? 'You cancelled the transaction in your wallet.' : msg);
        setSteps((s) => s.map((x) => (x.state === 'now' ? { ...x, state: 'todo' } : x)));
        throw e;
      } finally {
        setBusy(false);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chainId, switchChainAsync, queryClient],
  );

  async function sendAndWait(request: Parameters<typeof writeContractAsync>[0]) {
    const hash = await writeContractAsync(request);
    setLastTx(hash);
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error('The transaction reverted on Base.');
    return receipt;
  }

  function positionIdFrom(receipt: Awaited<ReturnType<typeof sendAndWait>>): bigint | null {
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== CONTRACTS.sellerPools.toLowerCase()) continue;
      try {
        const ev = decodeEventLog({ abi: ABI.sellerPools, data: log.data, topics: log.topics });
        if (ev.eventName === 'StakeCreated') return ev.args.positionId;
      } catch {
        /* other event */
      }
    }
    return null;
  }

  /** Claim finished buyer epochs. The connected wallet must be the buyer's operator. */
  const claimBuyer = (buyer: Address, epochs: number[]) =>
    run(epochs.map((e) => `Claim epoch ${e}`), async (advance, send) => {
      for (const e of epochs) {
        await send({ address: CONTRACTS.usageRewards, abi: ABI.usageRewards, functionName: 'claimBuyerReward', args: [buyer, BigInt(e)] });
        advance();
      }
    });

  /** Mint finished buyer rewards straight into a stake. Works before ANTS transfers open. */
  const stakeRewards = (buyer: Address, epochs: number[], agentId: string, lockEpochs: number, maxLock: boolean) =>
    run([...epochs.map((e) => `Stake epoch ${e} rewards`), ...(maxLock ? ['Turn on max lock'] : [])], async (advance, send) => {
      const created: bigint[] = [];
      for (const e of epochs) {
        const receipt = await send({
          address: CONTRACTS.usageRewards,
          abi: ABI.usageRewards,
          functionName: 'stakeBuyerReward',
          args: [buyer, BigInt(e), BigInt(agentId), BigInt(maxLock ? MAX_LOCK_EPOCHS : lockEpochs)],
        });
        const id = positionIdFrom(receipt);
        if (id !== null) created.push(id);
        advance();
      }
      if (maxLock) {
        for (const id of created) {
          await send({ address: CONTRACTS.sellerPools, abi: ABI.sellerPools, functionName: 'enableMaxLock', args: [id] });
        }
        advance();
      }
    });

  /** Stake ANTS from the wallet balance (needs ANTS transfers to be open). */
  const stakeWallet = (owner: Address, agentId: string, amountAnts: string, lockEpochs: number, maxLock: boolean, allowance: bigint) => {
    const amount = parseUnits(amountAnts, 18);
    const needsApprove = allowance < amount;
    return run([...(needsApprove ? ['Approve ANTS'] : []), 'Stake', ...(maxLock ? ['Turn on max lock'] : [])], async (advance, send) => {
      if (needsApprove) {
        await send({ address: CONTRACTS.ants, abi: ABI.ants, functionName: 'approve', args: [CONTRACTS.sellerPools, amount] });
        advance();
      }
      const receipt = await send({
        address: CONTRACTS.sellerPools,
        abi: ABI.sellerPools,
        functionName: 'stake',
        args: [BigInt(agentId), amount, BigInt(maxLock ? MAX_LOCK_EPOCHS : lockEpochs)],
        account: owner,
      });
      advance();
      const id = positionIdFrom(receipt);
      if (maxLock && id !== null) {
        await send({ address: CONTRACTS.sellerPools, abi: ABI.sellerPools, functionName: 'enableMaxLock', args: [id] });
        advance();
      }
    });
  };

  const claimStaker = (positionId: string, recipient: Address) =>
    run(['Claim staking rewards'], async (advance, send) => {
      await send({ address: CONTRACTS.sellerPoolsRewards, abi: ABI.sellerPoolsRewards, functionName: 'claimStakerRewards', args: [BigInt(positionId), recipient] });
      advance();
    });

  const enableMaxLock = (positionId: string) =>
    run(['Turn on max lock'], async (advance, send) => {
      await send({ address: CONTRACTS.sellerPools, abi: ABI.sellerPools, functionName: 'enableMaxLock', args: [BigInt(positionId)] });
      advance();
    });

  return { steps, busy, error, lastTx, claimBuyer, stakeRewards, stakeWallet, claimStaker, enableMaxLock, reset: () => { setSteps([]); setError(null); } };
}
