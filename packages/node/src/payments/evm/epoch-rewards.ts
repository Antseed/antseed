import { Contract, type Provider } from 'ethers';

/** Epochs to scan, inclusive; `toEpoch` defaults to the latest claimable epoch and `fromEpoch` to 0. */
export interface EpochRange {
  fromEpoch?: number;
  toEpoch?: number;
}

export interface EpochReward {
  epoch: number;
  amount: bigint;
}

/** The latest claimable epoch at `currentEpoch`: one finalized epoch plus the settlement grace epoch before it. */
export function latestClaimableEpoch(currentEpoch: number): number {
  return currentEpoch - 2;
}

/**
 * The non-zero `pending` amounts in `range` (a number is a lookback of that
 * many epochs ending at the latest claimable one), oldest first. Every epoch
 * in the range is read at once, so callers keep ranges bounded.
 */
export async function scanEpochRewards(
  range: number | EpochRange,
  currentEpoch: () => Promise<number>,
  pending: (epoch: number) => Promise<bigint>,
): Promise<EpochReward[]> {
  const to = typeof range === 'object' && range.toEpoch !== undefined
    ? range.toEpoch
    : latestClaimableEpoch(await currentEpoch());
  const from = Math.max(0, typeof range === 'number' ? to - range + 1 : range.fromEpoch ?? 0);
  if (to < from) return [];
  const epochs = Array.from({ length: to - from + 1 }, (_, i) => from + i);
  const amounts = await Promise.all(epochs.map(pending));
  return epochs.map((epoch, i) => ({ epoch, amount: amounts[i]! })).filter((entry) => entry.amount > 0n);
}

/**
 * The first epoch an emissions-gate controller can pay: its gate's
 * `effectiveEpoch` (earlier epochs belong to the legacy escrow, and the gate
 * refuses to mint them for any controller).
 */
export async function controllerFirstEpoch(controller: Contract, provider: Provider): Promise<number> {
  const gate = await controller.getFunction('emissionsGate')() as string;
  const contract = new Contract(gate, ['function effectiveEpoch() external view returns (uint256)'], provider);
  return Number(await contract.getFunction('effectiveEpoch')());
}
