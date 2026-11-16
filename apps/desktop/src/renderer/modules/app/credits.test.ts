import assert from 'node:assert/strict';
import { test, vi } from 'vitest';
import { createInitialUiState } from '../../core/state';
import type { DesktopBridge } from '../../types/bridge';
import { initCreditsModule } from './credits.js';

test('refreshCredits updates balance fields from creditsGetInfo', async () => {
  const uiState = createInitialUiState();
  const bridge: DesktopBridge = {
    creditsGetInfo: async () => ({
      ok: true,
      data: {
        evmAddress: '0xabc',
        operatorAddress: '0xdef',
        balanceUsdc: '10',
        reservedUsdc: '2',
        availableUsdc: '8',
        pendingUsdc: '1',
        spendableUsdc: '9',
        walletUsdc: '6',
        totalOwnedUsdc: '15',
        creditLimitUsdc: '20',
      },
      error: null,
    }),
  };
  const api = initCreditsModule({ bridge, uiState });

  await api.refreshCredits();

  assert.equal(uiState.creditsAvailableUsdc, '8');
  assert.equal(uiState.creditsReservedUsdc, '2');
  assert.equal(uiState.creditsTotalUsdc, '10');
  assert.equal(uiState.creditsPendingUsdc, '1');
  assert.equal(uiState.creditsSpendableUsdc, '9');
  assert.equal(uiState.creditsWalletUsdc, '6');
  assert.equal(uiState.creditsTotalOwnedUsdc, '15');
  assert.equal(uiState.creditsCreditLimitUsdc, '20');
  assert.equal(uiState.creditsEvmAddress, '0xabc');
  assert.equal(uiState.creditsOperatorAddress, '0xdef');
});

test('a failed first balance read retries soon instead of waiting for the next poll', async () => {
  vi.useFakeTimers();
  vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} });
  try {
    const uiState = createInitialUiState();
    let calls = 0;
    const bridge: DesktopBridge = {
      creditsGetInfo: async () => {
        calls++;
        if (calls === 1) return { ok: false, data: null, error: 'CancelledError' };
        return {
          ok: true,
          data: {
            evmAddress: '0xabc', operatorAddress: null, balanceUsdc: '5', reservedUsdc: '0', availableUsdc: '5',
            pendingUsdc: '0', spendableUsdc: '5', walletUsdc: '0', totalOwnedUsdc: '5', creditLimitUsdc: '500',
            balanceKnown: true,
          },
          error: null,
        };
      },
    };
    const api = initCreditsModule({ bridge, uiState });
    api.startPeriodicRefresh();
    await vi.advanceTimersByTimeAsync(0);
    assert.equal(uiState.creditsBalanceKnown, false);
    await vi.advanceTimersByTimeAsync(2_000);
    assert.equal(calls, 2);
    assert.equal(uiState.creditsBalanceKnown, true);
    assert.equal(uiState.creditsTotalOwnedUsdc, '5');
    api.stopPeriodicRefresh();
  } finally {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  }
});
