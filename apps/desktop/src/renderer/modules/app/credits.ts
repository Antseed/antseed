import type { RendererUiState } from '../../core/state';
import { notifyUiStateChanged } from '../../core/store';
import type { DesktopBridge } from '../../types/bridge';

type CreditsModuleOptions = {
  bridge?: DesktopBridge;
  uiState: RendererUiState;
  onBalanceSufficientForPayment?: () => void;
  onPaymentStateChanged?: () => void | Promise<void>;
};

export type CreditsModuleApi = {
  refreshCredits: () => Promise<void>;
  refreshPaymentSummary: (force?: boolean) => Promise<void>;
  startPeriodicRefresh: () => void;
  stopPeriodicRefresh: () => void;
  getAvailableUsdc: () => string;
  notifyPaymentCardVisible: () => void;
};

const CREDITS_REFRESH_INTERVAL_MS = 60_000;
const CREDITS_FAST_REFRESH_INTERVAL_MS = 5_000;
// Self-throttle for refreshPaymentSummary. Slightly under the Credits view's
// 60s poll interval so a tick arriving a moment "early" (relative to when the
// previous fetch finished) is not skipped.
const PAYMENT_SUMMARY_THROTTLE_MS = 55_000;

const MAX_AUTO_RETRIES = 2;

export function initCreditsModule({
  bridge,
  uiState,
  onBalanceSufficientForPayment,
  onPaymentStateChanged,
}: CreditsModuleOptions): CreditsModuleApi {
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let fastRefreshTimer: ReturnType<typeof setInterval> | null = null;
  let autoRetryCount = 0;
  let lastCardVisibleAt = 0;
  let lastPaymentSummaryRefreshAt = 0;
  let paymentSummaryRefreshInFlight = false;

  async function refreshCredits(fresh = true): Promise<void> {
    if (!bridge?.creditsGetInfo) return;

    try {
      // While a payment card waits for funds, read the chain directly so the
      // auto-retry fires as soon as the deposit lands.
      const result = await bridge.creditsGetInfo(fresh || uiState.chatPaymentApprovalVisible ? { fresh: true } : undefined);
      if (result.ok && result.data) {
        // Only notify if values actually changed
        const changed =
          uiState.creditsAvailableUsdc !== result.data.availableUsdc ||
          uiState.creditsReservedUsdc !== result.data.reservedUsdc ||
          uiState.creditsTotalUsdc !== result.data.balanceUsdc ||
          uiState.creditsPendingUsdc !== result.data.pendingUsdc ||
          uiState.creditsSpendableUsdc !== result.data.spendableUsdc ||
          uiState.creditsWalletUsdc !== result.data.walletUsdc ||
          uiState.creditsTotalOwnedUsdc !== result.data.totalOwnedUsdc ||
          uiState.creditsEvmAddress !== result.data.evmAddress ||
          uiState.creditsOperatorAddress !== (result.data.operatorAddress ?? null);

        uiState.creditsAvailableUsdc = result.data.availableUsdc;
        uiState.creditsReservedUsdc = result.data.reservedUsdc;
        uiState.creditsTotalUsdc = result.data.balanceUsdc;
        uiState.creditsPendingUsdc = result.data.pendingUsdc;
        uiState.creditsSpendableUsdc = result.data.spendableUsdc;
        uiState.creditsWalletUsdc = result.data.walletUsdc;
        uiState.creditsTotalOwnedUsdc = result.data.totalOwnedUsdc;
        uiState.creditsCreditLimitUsdc = result.data.creditLimitUsdc;
        uiState.creditsEvmAddress = result.data.evmAddress;
        uiState.creditsOperatorAddress = result.data.operatorAddress ?? null;

        // Clear channel badges when no funds are reserved (all channels closed)
        const reserved = parseFloat(uiState.creditsReservedUsdc);
        if (reserved === 0 && uiState.chatActiveChannels.size > 0) {
          uiState.chatActiveChannels.clear();
        }

        // Low balance detection
        const available = parseFloat(uiState.creditsAvailableUsdc);
        const lowBalance = available > 0 && (available < 1.0 || (reserved > 0 && available < reserved));
        if (uiState.chatLowBalanceWarning !== lowBalance) {
          uiState.chatLowBalanceWarning = lowBalance;
        }

        // Auto-retry: if the payment approval card is visible and balance
        // now covers the required amount, dismiss the card and retry.
        if (
          uiState.chatPaymentApprovalVisible &&
          !uiState.chatPaymentApprovalLoading &&
          onBalanceSufficientForPayment &&
          autoRetryCount < MAX_AUTO_RETRIES
        ) {
          const required = parseFloat(uiState.chatPaymentApprovalAmount || '0');
          if (available > 0 && required > 0 && available >= required) {
            stopFastRefresh();
            autoRetryCount++;
            onBalanceSufficientForPayment();
            // Fall through to notifyUiStateChanged so title bar balance updates
          }
        }

        // Start/stop fast polling based on whether the payment card is visible
        if (uiState.chatPaymentApprovalVisible && !fastRefreshTimer) {
          startFastRefresh();
        } else if (!uiState.chatPaymentApprovalVisible && fastRefreshTimer) {
          stopFastRefresh();
        }

        if (changed) notifyUiStateChanged();
        await onPaymentStateChanged?.();

      }
    } catch {
      // Silently fail — cached values remain
    }
  }

  async function refreshPaymentSummary(force = false): Promise<void> {
    if (paymentSummaryRefreshInFlight) return;
    if (!force && Date.now() - lastPaymentSummaryRefreshAt < PAYMENT_SUMMARY_THROTTLE_MS) return;
    if (!bridge?.paymentsGetBuyerUsage && !bridge?.paymentsGetBuyerSpendHistory && !bridge?.paymentsGetChannels && !bridge?.paymentsGetRewardsSummary) return;

    paymentSummaryRefreshInFlight = true;
    uiState.creditsSummaryLoading = true;
    notifyUiStateChanged();
    try {
      const [usage, spendHistory, channels, rewards] = await Promise.all([
        bridge?.paymentsGetBuyerUsage?.().catch(() => null) ?? Promise.resolve(null),
        bridge?.paymentsGetBuyerSpendHistory?.().catch(() => null) ?? Promise.resolve(null),
        bridge?.paymentsGetChannels?.(force ? { fresh: true } : undefined).catch(() => null) ?? Promise.resolve(null),
        bridge?.paymentsGetRewardsSummary?.().catch(() => null) ?? Promise.resolve(null),
      ]);

      if (usage?.ok && usage.data) {
        uiState.creditsBuyerUsage = usage.data;
      }
      if (spendHistory?.ok && spendHistory.data) {
        uiState.creditsBuyerSpendHistory = spendHistory.data;
      }
      if (channels?.ok && Array.isArray(channels.data)) {
        uiState.creditsChannels = channels.data;
      }
      if (rewards?.ok && rewards.data) {
        uiState.creditsRewards = rewards.data;
      }
      // Arm the throttle only once the buyer answered the usage query.
      // While it's still booting that fetch fails ("buyer proxy
      // unreachable") — but rewards is chain-side and reports ok even with
      // no data, so any-of-three would arm the throttle on a boot-time
      // failure and pin the zero-value tiles for the whole window.
      if (usage?.ok) {
        lastPaymentSummaryRefreshAt = Date.now();
      }
    } finally {
      paymentSummaryRefreshInFlight = false;
      uiState.creditsSummaryLoading = false;
      notifyUiStateChanged();
      await onPaymentStateChanged?.();
    }
  }

  function startFastRefresh(): void {
    if (fastRefreshTimer) return;
    fastRefreshTimer = setInterval(() => void refreshCredits(), CREDITS_FAST_REFRESH_INTERVAL_MS);
  }

  function stopFastRefresh(): void {
    if (fastRefreshTimer) {
      clearInterval(fastRefreshTimer);
      fastRefreshTimer = null;
    }
  }

  function onWindowFocus(): void {
    void refreshCredits(false);
  }

  function startPeriodicRefresh(): void {
    if (refreshTimer) return;
    void refreshCredits();
    refreshTimer = setInterval(() => void refreshCredits(false), CREDITS_REFRESH_INTERVAL_MS);
    window.addEventListener('focus', onWindowFocus);
  }

  function stopPeriodicRefresh(): void {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    stopFastRefresh();
    window.removeEventListener('focus', onWindowFocus);
  }

  function getAvailableUsdc(): string {
    return uiState.creditsAvailableUsdc;
  }

  /**
   * Call when the payment approval card becomes visible (new 402 cycle).
   * Resets the auto-retry counter and starts fast polling immediately.
   */
  function notifyPaymentCardVisible(): void {
    autoRetryCount = 0;
    lastCardVisibleAt = Date.now();
    startFastRefresh();
    void refreshCredits();
  }

  return { refreshCredits, refreshPaymentSummary, startPeriodicRefresh, stopPeriodicRefresh, getAvailableUsdc, notifyPaymentCardVisible };
}
