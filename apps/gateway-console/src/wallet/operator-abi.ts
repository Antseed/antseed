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

/** AntseedChannels' operator-only close: request it, then withdraw the unused reserve after the grace period. */
export const CHANNELS_CLOSE_ABI = parseAbi([
  'function channels(bytes32 channelId) view returns (address buyer, address seller, uint128 deposit, uint128 settled, bytes32 metadataHash, uint256 deadline, uint256 settledAt, uint256 closeRequestedAt, uint8 status)',
  'function requestClose(bytes32 channelId)',
  'function withdraw(bytes32 channelId)',
  'error ChannelNotActive()',
  'error NotAuthorized()',
  'error CloseAlreadyRequested()',
  'error CloseNotReady()',
])

/** The legacy emissions program's buyer claim (operator only; claimed or empty epochs are skipped on chain). */
export const LEGACY_EMISSIONS_BUYER_ABI = parseAbi([
  'function claimBuyerEmissions(address buyer, uint256[] epochs)',
  'error NotAuthorized()',
  'error EpochNotFinalized()',
])
