import type { GatewayKeyInfo } from '../../shared/gateway-types.js';
import { creditsBalanceTotals } from '../billing/credits-balance.js';
import type { CreditsInfo } from './credits.js';

const MICROS = 1_000_000n;

function toMicros(value: string | null): bigint {
  const match = value === null ? null : /^(\d+)(?:\.(\d{1,6})\d*)?$/.exec(value.trim());
  if (!match) return 0n;
  return BigInt(match[1]!) * MICROS + BigInt((match[2] ?? '').padEnd(6, '0'));
}

function fromMicros(value: bigint): string {
  const whole = value / MICROS;
  const fraction = (value % MICROS).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

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
    available: balance ? toMicros(balance.availableUsd) : 0n,
    reserved: balance ? toMicros(balance.reservedUsd) : 0n,
    pending: balance ? toMicros(balance.pendingUsd) : 0n,
    wallet: balance ? toMicros(balance.walletUsd) : 0n,
  });
  return {
    evmAddress: info?.buyerAddress ?? null,
    operatorAddress: balance?.operator ?? null,
    balanceUsdc: fromMicros(totals.deposited),
    reservedUsdc: fromMicros(totals.reserved),
    availableUsdc: fromMicros(totals.available),
    pendingUsdc: fromMicros(totals.pending),
    spendableUsdc: fromMicros(totals.spendable),
    walletUsdc: fromMicros(totals.wallet),
    totalOwnedUsdc: fromMicros(totals.totalOwned),
    creditLimitUsdc: fromMicros(toMicros(balance?.creditLimitUsd ?? null)),
    minFirstDepositUsdc: rules.minFirstDepositUsdc,
    depositFeeUsdc: rules.depositFeeUsdc,
    balanceKnown: balance !== null,
  };
}
