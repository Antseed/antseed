import type { RendererUiState } from '../../core/state';
import { notifyUiStateChanged } from '../../core/store';
import type { DesktopBridge } from '../../types/bridge';

type CreditsModuleOptions = {
  bridge?: DesktopBridge;
  uiState: RendererUiState;
  onPaymentStateChanged?: () => void | Promise<void>;
};

export type CreditsModuleApi = {
  refreshCredits: () => Promise<void>;
  startPeriodicRefresh: () => void;
  stopPeriodicRefresh: () => void;
  getAvailableUsdc: () => string;
};

const CREDITS_REFRESH_INTERVAL_MS = 60_000;

// Until the balance has been read once, a failed or empty read retries on a
// short backoff instead of leaving the placeholder up until the next poll.
const UNKNOWN_BALANCE_RETRY_BASE_MS = 2_000;
const UNKNOWN_BALANCE_RETRY_MAX_MS = 30_000;

export function initCreditsModule({
  bridge,
  uiState,
  onPaymentStateChanged,
}: CreditsModuleOptions): CreditsModuleApi {
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let unknownBalanceRetryTimer: ReturnType<typeof setTimeout> | null = null;
  let unknownBalanceRetries = 0;

  function scheduleUnknownBalanceRetry(): void {
    if (uiState.creditsBalanceKnown) {
      unknownBalanceRetries = 0;
      return;
    }
    if (unknownBalanceRetryTimer || !refreshTimer) return;
    const delay = Math.min(UNKNOWN_BALANCE_RETRY_BASE_MS * 2 ** unknownBalanceRetries, UNKNOWN_BALANCE_RETRY_MAX_MS);
    unknownBalanceRetries++;
    unknownBalanceRetryTimer = setTimeout(() => {
      unknownBalanceRetryTimer = null;
      void refreshCredits();
    }, delay);
  }

  async function refreshCredits(fresh = true): Promise<void> {
    if (!bridge?.creditsGetInfo) return;

    try {
      const result = await bridge.creditsGetInfo(fresh ? { fresh: true } : undefined);
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
          uiState.creditsCreditLimitUsdc !== result.data.creditLimitUsdc ||
          (result.data.minFirstDepositUsdc != null && uiState.creditsMinFirstDepositUsdc !== result.data.minFirstDepositUsdc) ||
          (result.data.depositFeeUsdc != null && uiState.creditsDepositFeeUsdc !== result.data.depositFeeUsdc) ||
          uiState.creditsBalanceKnown !== (result.data.balanceKnown ?? true) ||
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
        if (result.data.minFirstDepositUsdc != null) uiState.creditsMinFirstDepositUsdc = result.data.minFirstDepositUsdc;
        if (result.data.depositFeeUsdc != null) uiState.creditsDepositFeeUsdc = result.data.depositFeeUsdc;
        uiState.creditsBalanceKnown = result.data.balanceKnown ?? true;
        uiState.creditsEvmAddress = result.data.evmAddress;
        uiState.creditsOperatorAddress = result.data.operatorAddress ?? null;

        // Clear channel badges when no funds are reserved (all channels closed)
        const reserved = parseFloat(uiState.creditsReservedUsdc);
        if (reserved === 0 && uiState.chatActiveChannels.size > 0) {
          uiState.chatActiveChannels.clear();
        }

        if (changed) notifyUiStateChanged();
        await onPaymentStateChanged?.();

      }
    } catch {
      // Silently fail — cached values remain
    }
    scheduleUnknownBalanceRetry();
  }

  function onWindowFocus(): void {
    void refreshCredits(false);
  }

  function startPeriodicRefresh(): void {
    if (refreshTimer) return;
    refreshTimer = setInterval(() => void refreshCredits(false), CREDITS_REFRESH_INTERVAL_MS);
    void refreshCredits();
    window.addEventListener('focus', onWindowFocus);
  }

  function stopPeriodicRefresh(): void {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
    if (unknownBalanceRetryTimer) {
      clearTimeout(unknownBalanceRetryTimer);
      unknownBalanceRetryTimer = null;
    }
    window.removeEventListener('focus', onWindowFocus);
  }

  function getAvailableUsdc(): string {
    return uiState.creditsAvailableUsdc;
  }

  return { refreshCredits, startPeriodicRefresh, stopPeriodicRefresh, getAvailableUsdc };
}
