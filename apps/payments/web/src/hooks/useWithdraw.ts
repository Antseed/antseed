import { useCallback, useEffect, useState } from 'react';
import { useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseUnits } from 'viem';
import { DEPOSITS_ABI } from '@antseed/wallet-config/abis';
import type { PaymentConfig } from '../types';
import { getErrorMessage, usePaymentNetwork } from '../payment-network';

export interface UseWithdrawResult {
  /** Sends `withdraw(buyer, parseUnits(amount, 6))` from the connected wallet. */
  run: (buyer: string, amount: string) => Promise<void>;
  running: boolean;
  success: boolean;
  error: string | null;
  reset: () => void;
  txHash: string | undefined;
}

/**
 * Submits AntseedDeposits.withdraw() through the connected wallet (wagmi).
 *
 * The deposits contract requires `msg.sender == buyers[buyer].operator` and
 * sends the withdrawn USDC to `msg.sender`. So the connected wallet must be
 * the authorized operator for the buyer — typically that's the wallet the
 * user authorized via setOperator.
 */
export function useWithdraw(config: PaymentConfig | null, onSuccess?: () => void): UseWithdrawResult {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { expectedChainId, ensureCorrectNetwork } = usePaymentNetwork(config);

  const { writeContract, data: txHash, reset: resetWrite } = useWriteContract();
  const { isSuccess } = useWaitForTransactionReceipt({ hash: txHash, chainId: expectedChainId });

  useEffect(() => {
    if (isSuccess && running) {
      setRunning(false);
      onSuccess?.();
    }
  }, [isSuccess, running, onSuccess]);

  const run = useCallback(async (buyer: string, amount: string) => {
    if (!config?.depositsContractAddress) {
      setError('Payments contract is not configured.');
      return;
    }
    if (!/^0x[0-9a-fA-F]{40}$/.test(buyer)) {
      setError('Invalid buyer address.');
      return;
    }
    const parsed = Number(amount);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      setError('Enter a valid amount.');
      return;
    }

    let units: bigint;
    try {
      units = parseUnits(amount, 6);
    } catch {
      setError('Invalid amount.');
      return;
    }
    if (units <= 0n) {
      setError('Enter a valid amount.');
      return;
    }

    setError(null);
    setRunning(true);
    resetWrite();

    try {
      await ensureCorrectNetwork();
      writeContract({
        address: config.depositsContractAddress as `0x${string}`,
        abi: DEPOSITS_ABI,
        functionName: 'withdraw',
        chainId: expectedChainId,
        args: [buyer as `0x${string}`, units],
      }, {
        onError: (err) => {
          setRunning(false);
          setError(getErrorMessage(err));
        },
      });
    } catch (err) {
      setRunning(false);
      setError(getErrorMessage(err, 'Failed to withdraw'));
    }
  }, [config, ensureCorrectNetwork, expectedChainId, writeContract, resetWrite]);

  const reset = useCallback(() => {
    setError(null);
    setRunning(false);
    resetWrite();
  }, [resetWrite]);

  return { run, running, success: isSuccess, error, reset, txHash };
}
