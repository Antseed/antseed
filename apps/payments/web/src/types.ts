export interface BalanceData {
  evmAddress: string;
  available: string;
  reserved: string;
  total: string;
  creditLimit: string;
}

export interface PaymentConfig {
  chainId: string;
  evmChainId: number;
  rpcUrl: string;
  depositsContractAddress: string;
  channelsContractAddress: string;
  usdcContractAddress: string;
  emissionsContractAddress: string | null;
  legacyEmissionsContractAddress: string | null;
  usageAccountingAddress: string | null;
  usageRewardsAddress: string | null;
  recognizedUsageEffectiveEpoch: number | null;
  antsTokenAddress: string | null;
  networkStatsUrl: string | null;
  evmAddress: string | null;
}
