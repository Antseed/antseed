/** Contract ABI fragments the browser apps call through wagmi/viem. */
import { parseAbi } from 'viem'

export const ERC20_ABI = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
])

/** AntseedDeposits: buyer deposits, operator withdrawals and operator hand-over. */
export const DEPOSITS_ABI = parseAbi([
  'function deposit(address buyer, uint256 amount) external',
  'function withdraw(address buyer, uint256 amount) external',
  'function setOperator(address buyer, address operator, uint256 nonce, bytes buyerSig) external',
  'function transferOperator(address buyer, address newOperator) external',
])

/** AntseedUsageRewards: the operator claims a buyer's reward one epoch at a time. */
export const USAGE_REWARDS_CLAIM_ABI = parseAbi([
  'function claimBuyerReward(address buyer, uint256 epoch) external',
])
