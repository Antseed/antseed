import { ZeroAddress } from 'ethers';
import type { DepositsClient } from '@antseed/node';

/**
 * Closing a channel on chain and withdrawing deposits only accept the buyer's
 * authorized wallet, and the CLI signs them with the buyer wallet. Check before
 * sending, so a buyer with no authorized wallet (or a different one) learns what
 * to do instead of seeing the contract's bare NotAuthorized revert.
 */
export async function assertBuyerIsAuthorizedWallet(
  client: Pick<DepositsClient, 'getOperator'>,
  buyer: string,
  action: string,
): Promise<void> {
  const authorized = await client.getOperator(buyer);
  if (authorized.toLowerCase() === buyer.toLowerCase()) return;
  if (authorized.toLowerCase() === ZeroAddress) {
    throw new Error(
      `No authorized wallet is set for ${buyer}, and only the authorized wallet can ${action}. `
      + 'Run `antseed buyer set-authorized-wallet --self` to authorize the buyer wallet '
      + '(it needs a little ETH on Base for the network fee), then try again.',
    );
  }
  throw new Error(
    `Only the authorized wallet ${authorized} can ${action}, and this command signs with the buyer wallet ${buyer}. `
    + 'Send the transaction from the authorized wallet instead.',
  );
}
