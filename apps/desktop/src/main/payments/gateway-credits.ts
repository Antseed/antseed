import type { GatewayKeyInfo } from '../../shared/gateway-types.js';
import { creditsBalanceTotals } from '../billing/credits-balance.js';
import type { CreditsInfo } from './credits.js';
import { usdcFromMicros, usdcToMicros } from './usdc-decimal.js';

/** The deposit contract's rules for a first deposit into this computer's wallet. */
export type DepositRulesUsdc = { minFirstDepositUsdc: string; depositFeeUsdc: string };

const DEFAULT_DEPOSIT_RULES: DepositRulesUsdc = { minFirstDepositUsdc: '1', depositFeeUsdc: '0.05' };

/**
 * The balance the app spends from, as its gateway (local or remote) reports
 * it for the app's key in `GET /v1/key`: the wallet paying for that key.
 * Unknown until a gateway that reports it answers.
 */
export function gatewayCreditsInfo(info: GatewayKeyInfo | null, rules: DepositRulesUsdc = DEFAULT_DEPOSIT_RULES): CreditsInfo {
  const balance = info?.balance ?? null;
  const totals = creditsBalanceTotals({
    available: balance ? usdcToMicros(balance.availableUsd) : 0n,
    reserved: balance ? usdcToMicros(balance.reservedUsd) : 0n,
    pending: balance ? usdcToMicros(balance.pendingUsd) : 0n,
    wallet: balance ? usdcToMicros(balance.walletUsd) : 0n,
  });
  return {
    evmAddress: info?.buyerAddress ?? null,
    operatorAddress: balance?.operator ?? null,
    balanceUsdc: usdcFromMicros(totals.deposited),
    reservedUsdc: usdcFromMicros(totals.reserved),
    availableUsdc: usdcFromMicros(totals.available),
    pendingUsdc: usdcFromMicros(totals.pending),
    spendableUsdc: usdcFromMicros(totals.spendable),
    walletUsdc: usdcFromMicros(totals.wallet),
    totalOwnedUsdc: usdcFromMicros(totals.totalOwned),
    creditLimitUsdc: usdcFromMicros(usdcToMicros(balance?.creditLimitUsd ?? null)),
    minFirstDepositUsdc: rules.minFirstDepositUsdc,
    depositFeeUsdc: rules.depositFeeUsdc,
    balanceKnown: balance !== null,
  };
}
