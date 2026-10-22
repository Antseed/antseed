// Proving a wallet belongs to the signed-in X account: the user signs a fixed
// message with either the address itself or that address's reward wallet
// (the Deposits operator, which is the only wallet allowed to claim its ANTS).
import { createPublicClient, http, isAddress, parseAbi, recoverMessageAddress, type Address, type Hex } from 'viem';
import { base } from 'viem/chains';
import { DEPLOYED_CONTRACT_ADDRESSES } from '../../../../packages/node/src/payments/generated-contract-addresses';
import { linkMessage } from './message';

export { linkMessage };

export const LINK_MAX_AGE_MS = 10 * 60 * 1000;

export type OperatorReader = (address: Address) => Promise<Address | null>;

export function chainOperatorReader(rpcUrl = 'https://mainnet.base.org'): OperatorReader {
  const client = createPublicClient({ chain: base, transport: http(rpcUrl) });
  const deposits = DEPLOYED_CONTRACT_ADDRESSES['base-mainnet'].depositsContractAddress as Address;
  const abi = parseAbi(['function getOperator(address buyer) view returns (address)']);
  return async (address) => {
    try {
      const op = await client.readContract({ address: deposits, abi, functionName: 'getOperator', args: [address] });
      return op && op !== '0x0000000000000000000000000000000000000000' ? op : null;
    } catch {
      return null;
    }
  };
}

export interface LinkRequest {
  address: string;
  issuedAt: string;
  signature: string;
}

export type LinkCheck = { ok: true; signer: Address } | { ok: false; error: string };

export async function checkLink(
  req: LinkRequest,
  id: { handle: string; xId: string },
  readOperator: OperatorReader,
  now = Date.now(),
): Promise<LinkCheck> {
  if (!isAddress(req.address)) return { ok: false, error: 'That is not a valid wallet address.' };
  const issued = Date.parse(req.issuedAt);
  if (!Number.isFinite(issued) || Math.abs(now - issued) > LINK_MAX_AGE_MS) return { ok: false, error: 'The signature expired. Sign again.' };
  let signer: Address;
  try {
    signer = await recoverMessageAddress({
      message: linkMessage({ handle: id.handle, xId: id.xId, address: req.address, issuedAt: req.issuedAt }),
      signature: req.signature as Hex,
    });
  } catch {
    return { ok: false, error: 'The signature could not be read.' };
  }
  const address = req.address.toLowerCase();
  if (signer.toLowerCase() === address) return { ok: true, signer };
  const operator = await readOperator(req.address as Address);
  if (operator && operator.toLowerCase() === signer.toLowerCase()) return { ok: true, signer };
  return {
    ok: false,
    error: operator && operator.toLowerCase() !== address
      ? `Sign with this address's reward wallet (${operator.slice(0, 6)}…${operator.slice(-4)}).`
      : 'Sign with this wallet, or set a reward wallet for it in the AI VPN or console first.',
  };
}
