import { useCallback, useEffect, useState } from 'react';
import { useAccount, usePublicClient, useWriteContract } from 'wagmi';
import { formatUnits, parseAbi, type Address, type Hex } from 'viem';
import type { PaymentConfig } from '../types';
import { getColony, signColonyLink, type ColonyState } from '../api';
import { getErrorMessage, usePaymentNetwork } from '../payment-network';
import { formatColonyAnts, formatUsd, truncateAddress } from '../utils/format';
import { ConnectWalletAction } from './ConnectWalletAction';
import { claimColonyRewards, colonyClaimable, type ColonyClaimCall } from './colony-claim';

/** AntseedColonyPool: linking a worker's earnings to a wallet, and claiming them. */
const COLONY_POOL_ABI = parseAbi([
  'function setPayout(address worker, address payout, uint256 deadline, bytes signature)',
  'function claimUsdc()',
  'function claimAnts(uint256[] epochs)',
  'function claimAntsFor(address worker, uint256[] epochs)',
  'function claimOwedAnts()',
  'function claimEpochEmissions(uint256[] epochs)',
  // Claims wait until ANTS transfers open; the wallet shows this by name.
  'error AntsNotTransferableYet()',
]);

/** What Antseed Colony says about its pool and payout wallet; reloads on demand. */
export function useColony(enabled: boolean): { colony: ColonyState | null; error: string | null; reload: () => Promise<ColonyState | null> } {
  const [colony, setColony] = useState<ColonyState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const reload = useCallback(async () => {
    try {
      const next = await getColony();
      setColony(next);
      setError(null);
      return next;
    } catch (err) {
      setError(getErrorMessage(err, 'Could not reach Antseed Colony. Reopen this page from the app.'));
      return null;
    }
  }, []);
  useEffect(() => { if (enabled) void reload(); }, [enabled, reload]);
  return { colony, error, reload };
}

/** Sends one pool transaction from the connected wallet and waits for it to land. */
type PaymentNetwork = ReturnType<typeof usePaymentNetwork>;

/** Sends one pool transaction on the component's payment network (its own usePaymentNetwork, not a second subscription). */
function usePoolTransaction({ expectedChainId, ensureCorrectNetwork }: Pick<PaymentNetwork, 'expectedChainId' | 'ensureCorrectNetwork'>) {
  const client = usePublicClient({ chainId: expectedChainId });
  const { writeContractAsync } = useWriteContract();
  return useCallback(async (
    pool: string,
    call: { functionName: 'setPayout'; args: readonly [Address, Address, bigint, Hex] } | ColonyClaimCall,
  ): Promise<Hex> => {
    await ensureCorrectNetwork();
    const hash = await writeContractAsync({ address: pool as Address, abi: COLONY_POOL_ABI, chainId: expectedChainId, ...call } as Parameters<typeof writeContractAsync>[0]);
    const receipt = await client!.waitForTransactionReceipt({ hash });
    if (receipt.status !== 'success') throw new Error('The transaction reverted.');
    return hash;
  }, [client, ensureCorrectNetwork, expectedChainId, writeContractAsync]);
}

interface PayColonyProps {
  config: PaymentConfig | null;
  colony: ColonyState | null;
  onDone: (txHash: string | null) => void;
}

/**
 * Links the Mac's earnings to the connected wallet: the Mac app signs the
 * link for this wallet, and the wallet submits it (AntseedColonyPool.setPayout),
 * which also moves what the Mac already earned.
 */
export function PayColonyLink({ config, colony, onDone }: PayColonyProps) {
  const { address, isConnected } = useAccount();
  const network = usePaymentNetwork(config);
  const { targetChainName, wrongChain, isSwitchingChain } = network;
  const send = usePoolTransaction(network);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (!isConnected || !address) {
    return (
      <div className="pc-pay">
        <ConnectWalletAction className="pc-pay-button" label="Connect wallet" />
        <p className="pc-pay-fineprint">Connect the wallet you want this Mac's earnings to go to.</p>
      </div>
    );
  }

  const alreadyLinked = Boolean(colony?.payout && colony.payout.toLowerCase() === address.toLowerCase());
  const link = async () => {
    if (!colony?.pool) return;
    setRunning(true);
    setError(null);
    try {
      const authorization = await signColonyLink(address);
      const hash = await send(authorization.pool, {
        functionName: 'setPayout',
        args: [authorization.worker as Address, authorization.payout as Address, BigInt(authorization.deadline), authorization.signature as Hex],
      });
      onDone(hash);
    } catch (err) {
      setError(getErrorMessage(err, 'Linking failed.'));
    } finally {
      setRunning(false);
    }
  };

  const linkLabel = (): string => {
    if (isSwitchingChain) return `Switching to ${targetChainName}…`;
    if (wrongChain) return `Switch to ${targetChainName}`;
    if (running) return 'Confirm in your wallet…';
    return 'Link this wallet';
  };

  return (
    <div className="pc-pay">
      <div className="pc-pay-wallet">
        <span className="pc-pay-wallet-label">Earnings go to</span>
        <code className="pc-pay-wallet-addr">{truncateAddress(address)}</code>
      </div>
      {!colony?.pool && <div className="pc-pay-error" role="alert">Join a pool in Antseed Colony first.</div>}
      {alreadyLinked && <div className="pc-pay-error" role="status">This Mac already pays to this wallet.</div>}
      {error && <div className="pc-pay-error" role="alert">{error}</div>}
      <button
        type="button"
        className="pc-pay-button"
        onClick={() => void link()}
        disabled={running || isSwitchingChain || !colony?.pool || alreadyLinked}
      >
        {running && <span className="pc-pay-spinner" aria-hidden="true" />}
        {linkLabel()}
      </button>
      <p className="pc-pay-fineprint">
        You&apos;ll confirm one transaction. What this Mac already earned moves to this wallet too.
      </p>
    </div>
  );
}

/**
 * Claims what the pool owes the payout wallet (claimColonyRewards). The Mac app
 * works out the epochs; this page only sends the transactions.
 */
export function PayColonyClaim({ config, colony, onDone, reload }: PayColonyProps & { reload: () => Promise<ColonyState | null> }) {
  const { address, isConnected } = useAccount();
  const network = usePaymentNetwork(config);
  const { targetChainName, wrongChain, isSwitchingChain } = network;
  const send = usePoolTransaction(network);
  const [running, setRunning] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!isConnected || !address) {
    return (
      <div className="pc-pay">
        <ConnectWalletAction className="pc-pay-button" label="Connect wallet to claim" />
        <p className="pc-pay-fineprint">Connect the wallet this Mac pays to. The USDC and ANTS are sent to it.</p>
      </div>
    );
  }

  const payout = colony?.payout ?? null;
  const wrongWallet = Boolean(payout && payout.toLowerCase() !== address.toLowerCase());
  // Until ANTS transfers open, only the USDC can be claimed: the pool keeps the ANTS it owes.
  const { usdc, ants, antsOpen, unpulled, nothing } = colonyClaimable(colony);

  const claim = async () => {
    if (!colony?.pool) return;
    setRunning(true);
    setError(null);
    try {
      onDone(await claimColonyRewards(colony, { send, reload, onStep: setStep }));
    } catch (err) {
      setError(getErrorMessage(err, 'Claim failed.'));
      // Some transactions may have gone through (the USDC, say): what is left to claim
      // is read again, so a retry never repeats one that already did.
      await reload();
    } finally {
      setRunning(false);
      setStep(null);
    }
  };

  const claimLabel = (): string => {
    if (isSwitchingChain) return `Switching to ${targetChainName}…`;
    if (wrongChain) return `Switch to ${targetChainName}`;
    if (running) return step ?? 'Confirm in your wallet…';
    if (nothing) return !antsOpen && ants > 0n ? 'ANTS claimable once ANTS transfers open' : 'Nothing to claim yet';
    const antsLabel = antsOpen && ants > 0n ? ` + ${formatColonyAnts(ants)} ANTS` : '';
    return `Claim $${formatUsd(Number(formatUnits(usdc, 6)))} USDC${antsLabel}`;
  };

  return (
    <div className="pc-pay">
      <div className="pc-pay-wallet">
        <span className="pc-pay-wallet-label">Sending to</span>
        <code className="pc-pay-wallet-addr">{truncateAddress(address)}</code>
      </div>
      {!payout && <div className="pc-pay-error" role="alert">Link a wallet to this Mac first.</div>}
      {wrongWallet && payout && (
        <div className="pc-pay-error" role="alert">
          This Mac pays to <strong>{truncateAddress(payout)}</strong>. Connect that wallet to claim.
        </div>
      )}
      {error && <div className="pc-pay-error" role="alert">{error}</div>}
      <button
        type="button"
        className="pc-pay-button"
        onClick={() => void claim()}
        disabled={running || isSwitchingChain || !payout || wrongWallet || nothing}
      >
        {running && <span className="pc-pay-spinner" aria-hidden="true" />}
        {claimLabel()}
      </button>
      <p className="pc-pay-fineprint">
        You&apos;ll confirm one transaction per step: USDC, then ANTS{unpulled.length > 0 ? ' (after pulling the pool’s ANTS for finished epochs)' : ''}.
      </p>
    </div>
  );
}
