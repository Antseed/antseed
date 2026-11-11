import type { GatewayKeyInfo } from '../../shared/gateway-types.js';
import type { CreditsInfo } from './credits.js';

const MICROS = 1_000_000n;

function toMicros(value: string): bigint {
  const match = /^(\d+)(?:\.(\d{1,6})\d*)?$/.exec(value.trim());
  if (!match) return 0n;
  return BigInt(match[1]!) * MICROS + BigInt((match[2] ?? '').padEnd(6, '0'));
}

function fromMicros(value: bigint): string {
  const whole = value / MICROS;
  const fraction = (value % MICROS).toString().padStart(6, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

/**
 * On a remote gateway the app spends from the wallet that pays for its key,
 * not this computer's: its balance comes from the gateway (`GET /v1/key`).
 * Unknown until a gateway that reports it answers.
 */
export function remoteCreditsInfo(info: GatewayKeyInfo | null): CreditsInfo {
  const balance = info?.balance ?? null;
  const available = balance ? toMicros(balance.availableUsd) : 0n;
  const reserved = balance ? toMicros(balance.reservedUsd) : 0n;
  const total = fromMicros(available + reserved);
  return {
    evmAddress: info?.buyerAddress ?? null,
    operatorAddress: null,
    balanceUsdc: total,
    reservedUsdc: fromMicros(reserved),
    availableUsdc: fromMicros(available),
    pendingUsdc: '0',
    spendableUsdc: total,
    walletUsdc: '0',
    totalOwnedUsdc: total,
    creditLimitUsdc: '0',
    minFirstDepositUsdc: '1',
    depositFeeUsdc: '0.05',
    balanceKnown: balance !== null,
  };
}
