export const EMISSIONS_CLAIM_ABI = [
  'function claimSellerEmissions(uint256[] epochs) external',
  'function claimBuyerEmissions(address buyer, uint256[] epochs) external',
] as const;

export const USAGE_ACCOUNTING_CLAIM_ABI = [
  'function claimSellerEmissions(uint256[] epochs) external',
] as const;

export const USAGE_REWARDS_CLAIM_ABI = [
  'function claimBuyerReward(address buyer, uint256 epoch) external',
] as const;
