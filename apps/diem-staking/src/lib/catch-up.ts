// Reward-epoch backlog recovery for DiemStakingProxy, kept free of React and
// wagmi so it can be tested directly.
//
// Every write except flush and claimUnstakeBatch runs updateRewards, which
// syncs the pool's finalized epochs and then captures the wallet's points up
// to the new synced epoch. Either step reverts with BacklogTooLarge() past
// MAX_EPOCHS_PER_CAPTURE, so a wallet that stays locked without touching the
// contract for too long is stuck until it calls catchUpPoints.

// Epochs a single catch-up transaction processes. The contract has no cap on
// catchUpPoints; this keeps gas well inside a block for long backlogs, and the
// notice reappears with the rest once the transaction lands.
export const MAX_CATCH_UP_EPOCHS_PER_TX = 48;

export type CatchUpKind = 'user' | 'pool';

export type CatchUpState =
  | { status: 'none' }
  | { status: 'needed'; kind: CatchUpKind; epochsBehind: number; epochsThisTx: number };

export interface BacklogReading {
  /** MAX_EPOCHS_PER_CAPTURE() */
  cap: number;
  /** syncBacklog().remaining: finalized epochs the pool has not synced. */
  poolBehind: number;
  /** userPointsBacklog(wallet).remaining: synced epochs the wallet has not captured. */
  userBehind: number;
  /** The wallet has DIEM locked. Without a stake, point capture is skipped. */
  hasStake: boolean;
}

export function planCatchUp({ cap, poolBehind, userBehind, hasStake }: BacklogReading): CatchUpState {
  // A wallet with a stake is limited by the sum: the pool syncs first, then
  // its points are captured up to the new synced epoch. catchUpPoints(n) also
  // syncs up to n pool epochs before moving the wallet up to n epochs, so
  // n = the sum clears both. Without a stake only the pool sync can revert.
  const kind: CatchUpKind = hasStake ? 'user' : 'pool';
  const epochsBehind = hasStake ? userBehind + poolBehind : poolBehind;
  if (epochsBehind <= cap) return { status: 'none' };
  return {
    status: 'needed',
    kind,
    epochsBehind,
    epochsThisTx: Math.min(epochsBehind, MAX_CATCH_UP_EPOCHS_PER_TX),
  };
}

export class CatchUpUnconfirmedError extends Error {
  constructor(readonly hash: `0x${string}`, cause: unknown) {
    super(
      `The update was sent (${hash.slice(0, 10)}…) but its confirmation could not be read. ` +
        'Check it in your wallet before sending it again.',
      { cause },
    );
    this.name = 'CatchUpUnconfirmedError';
  }
}

export class CatchUpRevertedError extends Error {
  constructor(readonly hash: `0x${string}`) {
    super(`The update transaction (${hash.slice(0, 10)}…) reverted.`);
    this.name = 'CatchUpRevertedError';
  }
}

export interface CatchUpDeps {
  ensureNetwork: () => Promise<unknown>;
  submit: (kind: CatchUpKind, numEpochs: number) => Promise<`0x${string}`>;
  waitForReceipt: (hash: `0x${string}`) => Promise<{ status: 'success' | 'reverted' }>;
  onConfirming?: (confirming: boolean) => void;
}

/**
 * Switch to Base, submit, and resolve only once the transaction is mined
 * successfully. Throws on every failure, so the caller always has an error to
 * show and never treats a submitted-but-unknown transaction as done.
 */
export async function submitCatchUp(
  deps: CatchUpDeps,
  kind: CatchUpKind,
  numEpochs: number,
): Promise<`0x${string}`> {
  await deps.ensureNetwork();
  const hash = await deps.submit(kind, numEpochs);
  deps.onConfirming?.(true);
  try {
    let receipt: { status: 'success' | 'reverted' };
    try {
      receipt = await deps.waitForReceipt(hash);
    } catch (err) {
      throw new CatchUpUnconfirmedError(hash, err);
    }
    if (receipt.status !== 'success') throw new CatchUpRevertedError(hash);
    return hash;
  } finally {
    deps.onConfirming?.(false);
  }
}
