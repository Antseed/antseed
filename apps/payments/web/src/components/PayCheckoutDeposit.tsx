import { useEffect, useRef, useState } from 'react';
import {
  useAccount,
  useReadContract,
  useWaitForTransactionReceipt,
  useWriteContract,
} from 'wagmi';
import { formatUnits, parseUnits } from 'viem';
import { DEPOSITS_ABI, ERC20_ABI } from '@antseed/wallet-config/abis';
import type { BalanceData, PaymentConfig } from '../types';
import { getErrorMessage, usePaymentNetwork } from '../payment-network';
import { formatUsd, parseUsd, truncateAddress } from '../utils/format';
import { ConnectWalletAction } from './ConnectWalletAction';

const MIN_FIRST_DEPOSIT = 1; // USDC — matches AntseedDeposits.MIN_BUYER_DEPOSIT

function safeParseUsdc(value: string): bigint {
  try {
    return parseUnits(value || '0', 6);
  } catch {
    return 0n;
  }
}

interface PayCheckoutDepositProps {
  config: PaymentConfig | null;
  balance: BalanceData | null;
  buyerAddress: string | null;
  amount: string;
  onDeposited: (txHash: string | null) => void;
}

type Step = 'idle' | 'approving' | 'checking-allowance' | 'depositing';

/**
 * Checkout-style deposit: one primary "Pay" button that runs the whole
 * approve → deposit sequence automatically, with a two-step progress
 * indicator when an approval is needed. Purpose-built for the standalone
 * payment page — no chips, no target override, no amount field (the amount
 * lives in the page's order summary).
 */
export function PayCheckoutDeposit({ config, balance, buyerAddress, amount, onDeposited }: PayCheckoutDepositProps) {
  const { address, isConnected } = useAccount();
  const walletConnected = isConnected && Boolean(address);
  const [step, setStep] = useState<Step>('idle');
  const [error, setError] = useState<string | null>(null);
  const autoDepositFired = useRef(false);

  const {
    expectedChainId,
    targetChainName,
    wrongChain,
    isSwitchingChain,
    ensureCorrectNetwork,
  } = usePaymentNetwork(config);

  const currentTotal = parseUsd(balance?.total);
  const creditLimit = parseUsd(balance?.creditLimit);
  const remainingCreditLimit = balance ? Math.max(0, creditLimit - currentTotal) : Infinity;
  const minDeposit = currentTotal === 0 ? MIN_FIRST_DEPOSIT : 0;

  const depositTarget = buyerAddress ?? address;
  const amountNum = amount ? Number.parseFloat(amount) : 0;
  const usdcAmount = safeParseUsdc(amount);

  const { data: walletUsdcRaw, refetch: refetchWalletUsdc, isLoading: walletUsdcLoading } = useReadContract({
    address: config?.usdcContractAddress as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'balanceOf',
    chainId: expectedChainId,
    args: [address as `0x${string}`],
    query: { enabled: walletConnected && !!config && !!address },
  });
  const walletUsdcBalance = walletUsdcRaw === undefined ? null : Number.parseFloat(formatUnits(walletUsdcRaw, 6));
  const walletUsdcKnown = walletUsdcBalance !== null && Number.isFinite(walletUsdcBalance);

  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: config?.usdcContractAddress as `0x${string}`,
    abi: ERC20_ABI,
    functionName: 'allowance',
    chainId: expectedChainId,
    args: [address as `0x${string}`, config?.depositsContractAddress as `0x${string}`],
    query: { enabled: walletConnected && !!config && !!address },
  });
  const allowanceKnown = allowance !== undefined;
  const hasAllowance = allowanceKnown && usdcAmount > 0n && allowance >= usdcAmount;
  const needsApproval = allowanceKnown && usdcAmount > 0n && allowance < usdcAmount;

  let validationError: string | null = null;
  if (amount !== '' && balance) {
    if (!Number.isFinite(amountNum) || amountNum <= 0) {
      validationError = 'Enter a valid amount above';
    } else if (!/^\d+(\.\d{0,6})?$/.test(amount.trim())) {
      validationError = 'USDC supports up to 6 decimal places';
    } else if (amountNum < minDeposit) {
      validationError = `Minimum first deposit is ${minDeposit} USDC`;
    } else if (amountNum > remainingCreditLimit) {
      validationError = remainingCreditLimit <= 0
        ? 'You have reached your credit limit'
        : `You can add up to $${formatUsd(remainingCreditLimit)} more.`;
    } else if (walletUsdcKnown && amountNum > walletUsdcBalance) {
      validationError = `Your wallet holds $${formatUsd(walletUsdcBalance)} USDC — not enough for this payment.`;
    }
  }
  const isValidAmount = amount !== '' && !validationError && amountNum > 0;

  const { writeContract: writeApprove, data: approveTxHash, reset: resetApprove } = useWriteContract();
  const { isSuccess: approveConfirmed } = useWaitForTransactionReceipt({
    hash: approveTxHash,
    chainId: expectedChainId,
    query: { enabled: step === 'approving' && !!approveTxHash },
  });

  const { writeContract: writeDeposit, data: depositTxHash, reset: resetDeposit } = useWriteContract();
  const { isSuccess: depositConfirmed } = useWaitForTransactionReceipt({
    hash: depositTxHash,
    chainId: expectedChainId,
    query: { enabled: step === 'depositing' && !!depositTxHash },
  });

  function fireDeposit() {
    if (!config || !depositTarget) return;
    setStep('depositing');
    writeDeposit(
      {
        address: config.depositsContractAddress as `0x${string}`,
        abi: DEPOSITS_ABI,
        functionName: 'deposit',
        chainId: expectedChainId,
        args: [depositTarget as `0x${string}`, usdcAmount],
      },
      {
        onError: (err) => {
          setStep('idle');
          setError(getErrorMessage(err));
        },
      },
    );
  }

  // Approval confirmed → verify the allowance actually updated, then chain
  // straight into the deposit so the user only pressed "Pay" once.
  useEffect(() => {
    if (step !== 'approving' || !approveConfirmed) return;
    setStep('checking-allowance');
    void refetchAllowance();
  }, [step, approveConfirmed, refetchAllowance]);

  useEffect(() => {
    if (step !== 'checking-allowance' || !hasAllowance || autoDepositFired.current) return;
    autoDepositFired.current = true;
    fireDeposit();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, hasAllowance]);

  useEffect(() => {
    if (step !== 'depositing' || !depositConfirmed) return;
    setStep('idle');
    onDeposited(depositTxHash ?? null);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [depositConfirmed, step]);

  async function handlePay() {
    if (!address || !isValidAmount || !config || !depositTarget) return;
    setError(null);
    autoDepositFired.current = false;

    try {
      await ensureCorrectNetwork();
    } catch (err) {
      setError(getErrorMessage(err, `Please switch your wallet to ${targetChainName}.`));
      return;
    }

    resetApprove();
    resetDeposit();

    const walletResult = await refetchWalletUsdc();
    const latestWalletUsdc = walletResult.data === undefined
      ? null
      : Number.parseFloat(formatUnits(walletResult.data, 6));
    if (latestWalletUsdc === null || !Number.isFinite(latestWalletUsdc)) {
      setError('Could not check your wallet USDC balance. Please try again.');
      return;
    }
    if (amountNum > latestWalletUsdc) {
      setError(`Your wallet holds $${formatUsd(latestWalletUsdc)} USDC — not enough for this payment.`);
      return;
    }

    const allowanceResult = await refetchAllowance();
    const latestAllowance = allowanceResult.data;
    if (latestAllowance === undefined) {
      setError('Could not check your USDC approval. Please try again.');
      return;
    }

    if (latestAllowance >= usdcAmount) {
      fireDeposit();
      return;
    }

    setStep('approving');
    writeApprove(
      {
        address: config.usdcContractAddress as `0x${string}`,
        abi: ERC20_ABI,
        functionName: 'approve',
        chainId: expectedChainId,
        args: [config.depositsContractAddress as `0x${string}`, usdcAmount],
      },
      {
        onError: (err) => {
          setStep('idle');
          setError(getErrorMessage(err));
        },
      },
    );
  }

  /* ── Not connected: one big connect CTA ── */
  if (!walletConnected) {
    return (
      <div className="pc-pay">
        <ConnectWalletAction className="pc-pay-button" label="Connect wallet to pay" />
        <p className="pc-pay-fineprint">
          MetaMask, Coinbase Wallet, Rainbow or any WalletConnect-compatible wallet.
        </p>
      </div>
    );
  }

  const isWorking = step !== 'idle';
  const showSteps = needsApproval || step === 'approving' || step === 'checking-allowance' || step === 'depositing';
  const stepOneDone = hasAllowance || step === 'depositing';
  const stepOneActive = step === 'approving' || step === 'checking-allowance';

  const payLabel = (() => {
    if (isSwitchingChain) return `Switching to ${targetChainName}…`;
    if (wrongChain) return `Switch to ${targetChainName}`;
    if (step === 'approving') return 'Approve in your wallet…';
    if (step === 'checking-allowance') return 'Confirming approval…';
    if (step === 'depositing') return 'Confirm in your wallet…';
    if (!walletUsdcKnown || walletUsdcLoading) return 'Checking wallet…';
    return `Pay $${isValidAmount ? formatUsd(amountNum) : '0.00'} USDC`;
  })();

  return (
    <div className="pc-pay">
      <div className="pc-pay-wallet">
        <span className="pc-pay-wallet-label">Paying from</span>
        <code className="pc-pay-wallet-addr">{truncateAddress(address ?? '')}</code>
        <span className="pc-pay-wallet-balance">
          {walletUsdcKnown ? `$${formatUsd(walletUsdcBalance)} USDC` : '…'}
        </span>
      </div>

      {showSteps && (
        <ol className="pc-pay-steps" aria-label="Payment steps">
          <li className={`pc-pay-step${stepOneDone ? ' pc-pay-step--done' : stepOneActive ? ' pc-pay-step--active' : ''}`}>
            <span className="pc-pay-step-dot">{stepOneDone ? '✓' : '1'}</span>
            Approve USDC
          </li>
          <li className={`pc-pay-step${step === 'depositing' ? ' pc-pay-step--active' : ''}`}>
            <span className="pc-pay-step-dot">2</span>
            Confirm payment
          </li>
        </ol>
      )}

      {(error || (amount !== '' && validationError)) && (
        <div className="pc-pay-error" role="alert">{error ?? validationError}</div>
      )}

      <button
        type="button"
        className="pc-pay-button"
        onClick={() => void handlePay()}
        disabled={isWorking || isSwitchingChain || (!wrongChain && !isValidAmount)}
      >
        {isWorking && <span className="pc-pay-spinner" aria-hidden="true" />}
        {payLabel}
      </button>

      <p className="pc-pay-fineprint">
        {needsApproval
          ? "You'll confirm two transactions in your wallet: a one-time USDC approval, then the payment."
          : "You'll confirm one transaction in your wallet."}{' '}
        Network fees are paid in ETH on Base.
      </p>
    </div>
  );
}
