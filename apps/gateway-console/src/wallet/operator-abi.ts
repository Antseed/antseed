import { parseAbi } from 'viem'

/**
 * AntseedDeposits' operator functions with its custom errors, so viem can
 * name a revert (OperatorAlreadySet, InvalidNonce, NotAuthorized…) during
 * the pre-flight simulation instead of a bare "execution reverted".
 */
export const DEPOSITS_OPERATOR_ABI = parseAbi([
  'function getOperator(address buyer) view returns (address)',
  'function getOperatorNonce(address buyer) view returns (uint256)',
  'function setOperator(address buyer, address operator, uint256 nonce, bytes buyerSig)',
  'function transferOperator(address buyer, address newOperator)',
  'function withdraw(address buyer, uint256 amount)',
  'error NotAuthorized()',
  'error InvalidAmount()',
  'error InvalidAddress()',
  'error InsufficientBalance()',
  'error InvalidSignature()',
  'error InvalidNonce()',
  'error OperatorAlreadySet()',
])

/** AntseedUsageRewards' buyer claim with the errors a non-operator caller hits. */
export const USAGE_REWARDS_OPERATOR_ABI = parseAbi([
  'function claimBuyerReward(address buyer, uint256 epoch)',
  'error NotRewardRecipient()',
  'error RewardRecipientUnavailable()',
])
