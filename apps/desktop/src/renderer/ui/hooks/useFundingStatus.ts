import { useMemo } from 'react';
import { shallowEqual, useUiSelector } from './useUiSelector';
import { deriveFundingStatus, type FundingStatus } from '../components/views/funding-status';

/** The buyer's funding status, derived from the polled credits state. */
export function useFundingStatus(): FundingStatus {
  const snap = useUiSelector((state) => ({
    balanceKnown: state.creditsBalanceKnown,
    available: state.creditsAvailableUsdc,
    reserved: state.creditsReservedUsdc,
    wallet: state.creditsWalletUsdc,
    creditLimit: state.creditsCreditLimitUsdc,
    minFirstDeposit: state.creditsMinFirstDepositUsdc,
    depositFee: state.creditsDepositFeeUsdc,
    channels: state.creditsChannels,
  }), shallowEqual);
  return useMemo(() => deriveFundingStatus(snap), [snap]);
}
