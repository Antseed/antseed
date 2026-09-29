import { type Identity } from '../p2p/identity.js';
import { type DepositsClient } from './evm/deposits-client.js';
import { type IdentityClient } from './evm/identity-client.js';
import { type StakingClient } from './evm/staking-client.js';
import { formatEther } from 'ethers';

export interface ReadinessCheck {
  name: string;
  passed: boolean;
  message: string;
  command?: string;
}

export async function checkSellerReadiness(
  identity: Identity,
  identityClient: IdentityClient,
  stakingClient: StakingClient,
  sellerContract?: string,
): Promise<ReadinessCheck[]> {
  const checks: ReadinessCheck[] = [];
  const evmAddr = identity.wallet.address;
  // When the peer is fronted by a seller contract, stake and agent registration
  // live under the proxy address — not the peer's wallet. ETH gas still comes
  // from the peer's wallet regardless.
  const sellerAddr = sellerContract ?? evmAddr;

  // 1. ETH for gas (always the peer wallet)
  const ethBalance = await stakingClient.provider.getBalance(evmAddr);
  checks.push({
    name: 'Gas balance',
    passed: ethBalance > 0n,
    message: ethBalance > 0n
      ? `ETH balance: ${formatEther(ethBalance)}`
      : `No ETH for gas fees. Send ETH to ${evmAddr}`,
  });

  // 2. Registered (seller on-chain address = proxy when configured)
  const isReg = await identityClient.isRegistered(sellerAddr);
  checks.push({
    name: 'Peer registration',
    passed: isReg,
    message: isReg ? 'Registered' : 'Not registered. Run: antseed seller register',
    command: isReg ? undefined : 'antseed seller register',
  });

  // 3. Use the configured staking contract's eligibility rule. The seller
  // registry can allow zero stake, but still requires a valid bound agent.
  const eligible = await stakingClient.isStakedAboveMin(sellerAddr);
  checks.push({
    name: 'Stake',
    passed: eligible,
    message: eligible
      ? 'Seller meets on-chain eligibility requirements'
      : 'Seller does not meet on-chain eligibility requirements. Check agent binding and required stake with: antseed seller status',
    command: eligible ? undefined : 'antseed seller status',
  });

  return checks;
}

export async function checkBuyerReadiness(
  identity: Identity,
  depositsClient: DepositsClient,
): Promise<ReadinessCheck[]> {
  const checks: ReadinessCheck[] = [];
  const evmAddr = identity.wallet.address;

  // 1. ETH for gas
  const ethBalance = await depositsClient.provider.getBalance(evmAddr);
  checks.push({
    name: 'Gas balance',
    passed: ethBalance > 0n,
    message: ethBalance > 0n
      ? `ETH balance: ${formatEther(ethBalance)}`
      : `No ETH for gas. Send ETH to ${evmAddr}`,
  });

  // 2. USDC in deposits
  const balance = await depositsClient.getBuyerBalance(evmAddr);
  checks.push({
    name: 'Deposit balance',
    passed: balance.available > 0n,
    message: balance.available > 0n
      ? `Available: ${balance.available}`
      : 'No USDC deposited. Run: antseed buyer deposit <amount>',
    command: balance.available > 0n ? undefined : 'antseed buyer deposit 10',
  });

  return checks;
}
