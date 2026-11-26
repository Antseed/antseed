import { Contract, JsonRpcProvider } from 'ethers';

const OPERATOR_FEE_ABI = ['function operatorFeeBps() view returns (uint256)'];
/** How often the share is read again, so a changed operator fee reaches estimates and new workers. */
export const WORKER_SHARE_REFRESH_MS = 10 * 60_000;

/**
 * What an AntseedColonyPool contract pays its workers, in basis points of the net payout:
 * everything its operator fee leaves.
 */
export async function readWorkerShareBps(rpcUrl: string, pool: string): Promise<number> {
  const contract = new Contract(pool, OPERATOR_FEE_ABI, new JsonRpcProvider(rpcUrl, undefined, { staticNetwork: true }));
  const fee = Number(await contract.getFunction('operatorFeeBps')());
  if (!Number.isInteger(fee) || fee < 0 || fee > 10_000) throw new Error(`Pool ${pool} reports an operator fee of ${fee} bps`);
  return 10_000 - fee;
}
