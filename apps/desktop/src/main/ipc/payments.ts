/**
 * IPC surface for funding: balances, deposits, card checkout and the
 * wallet-signing pages. Usage, channels and history live in the gateway console.
 */
import { ipcMain, shell } from 'electron';
import { isDev } from '../app-context.js';
import { LOCALHOST_URL } from '../constants.js';
import { ensureSecureIdentity, getSecureIdentity } from '../identity.js';
import { CREDITS_FRESH_MS, cachedRead, readKeys, refreshFresh } from '../payments/read-cache.js';
import {
  type CreditsInfo,
  getDepositsClient,
  loadCachedCryptoConfig,
  refreshCreditsInfo,
} from '../payments/credits.js';
import { demoteDepositWatch, startDepositWatch } from '../payments/deposit-sweep.js';
import {
  DEFAULT_CARD_PROVIDERS,
  PAYMENTS_PORT,
  PAY_PAGE_KINDS,
  type PayPageKind,
  getPaymentsPortalToken,
  openPaymentsPopup,
  payPageProvider,
  readCardProviders,
  startPaymentsPortal,
} from '../payments/portal.js';
import { openCheckoutPopup } from '../payments/checkout-window.js';
import { antseedPayLinkAmount, resolveCardProviderUrl, signAntseedPayUrl } from '@antseed/payments/card-link';
import { createPeerPayCheckout } from '../payments/peer-pay.js';
import { getMainWindow } from '../ui/window.js';
import { getTelemetryService } from '../telemetry/runtime.js';
import { getGatewayKeyInfo, localFundingBlock } from '../gateway/service.js';
import { getGatewaySettings } from '../gateway/settings.js';
import { attachedGateway } from '../runtime/attach-only.js';
import { remoteCreditsInfo } from '../payments/remote-credits.js';

export function registerPaymentsIpc(): void {
  // Slim payment pages: only actions that need an external wallet signature
  // (connected-wallet deposit, withdraw, authorize-operator) leave the app — everything else renders in-app. The full
  // portal dashboard is retired.
  //
  // Preferred surface: a regular tab in the user's default browser, where
  // extension wallets like MetaMask work in their normal profile. Only when
  // that fails does a sandboxed Electron popup take over (WalletConnect/QR
  // flows only).
  ipcMain.handle('payments:open-pay-page', async (_event, opts: { kind?: PayPageKind; amountUsdc?: string }) => {
    try {
      const kind: PayPageKind = opts?.kind && PAY_PAGE_KINDS.includes(opts.kind) ? opts.kind : 'deposit';
      // Withdrawing what this wallet already holds stays open; adding to it doesn't when it isn't what pays.
      if (kind === 'deposit') {
        const blocked = await localFundingBlock();
        if (blocked) return { ok: false, error: blocked };
      }
      await startPaymentsPortal();
      if (kind === 'withdraw') void getTelemetryService()?.recordWithdrawStarted();
      else getTelemetryService()?.clearPendingWithdraw();
      const token = getPaymentsPortalToken();
      const params = new URLSearchParams();
      if (token) params.set('token', token);
      params.set('page', 'pay');
      params.set('action', kind);
      const amount = Number(opts?.amountUsdc);
      if (Number.isFinite(amount) && amount > 0) params.set('amount', String(amount));
      const devUrl = isDev ? process.env['ANTSEED_PAYMENTS_DEV_URL']?.trim() : undefined;
      const base = devUrl || `${LOCALHOST_URL}:${PAYMENTS_PORT}`;

      // No popup param → regular browser tab (extensions available);
      // popup=win → Electron fallback (WalletConnect/QR only).
      const browserUrl = `${base}?${params.toString()}`;
      try {
        await shell.openExternal(browserUrl);
        return { ok: true, url: browserUrl };
      } catch (err) {
        console.warn('[payments] system browser launch failed:', err instanceof Error ? err.message : String(err));
      }
      const fallbackUrl = `${base}?${params.toString()}&popup=win`;
      console.log('[payments] no system browser available — using Electron popup');
      openPaymentsPopup(fallbackUrl);
      return { ok: true, url: fallbackUrl };
    } catch (err) {
      console.error('[payments] open-pay-page failed:', err instanceof Error ? err.message : String(err));
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('payments:open-card-provider', async (_event, opts?: { providerId?: string; amountUsdc?: string }) => {
    try {
      const blocked = await localFundingBlock();
      if (blocked) return { ok: false, error: blocked };
      await ensureSecureIdentity();
      const identity = getSecureIdentity();
      if (!identity) return { ok: false, error: 'Identity not available' };
      const providers = await readCardProviders();
      // The chooser's fixed lineup (Meridian, Antseed Pay, Peer Pay) must resolve even
      // when a legacy config overrides the provider list with other entries.
      const provider = opts?.providerId
        ? providers.find((entry) => entry.id === opts.providerId)
          ?? DEFAULT_CARD_PROVIDERS.find((entry) => entry.id === opts.providerId)
        : providers[0];
      if (!provider) return { ok: false, error: 'card-not-configured' };

      const amount = Number(opts?.amountUsdc);
      const hasAmount = Number.isFinite(amount) && amount > 0;
      if (provider.id === 'peer-pay') {
        if (!hasAmount) return { ok: false, error: 'Enter an amount before opening Peer Pay' };
        const checkoutUrl = await createPeerPayCheckout({
          endpoint: provider.url,
          address: identity.wallet.address,
          amount: opts?.amountUsdc ?? '',
        }, identity.wallet);
        if (isDev) console.log('[payments] Peer Pay checkout created');
        openCheckoutPopup(checkoutUrl, getMainWindow());
        return { ok: true };
      }
      // Antseed Pay refuses a link without an amount, or with one outside
      // its $1–$200 / two-decimal rules, as "invalid or was altered" — and the
      // Add Credits chooser opens it with no amount entered. Sign the amount
      // the page accepts (the entered one, else the $20 default);
      // the user can still change it on the page.
      const payPage = payPageProvider(provider.id);
      const amountStr = payPage
        ? antseedPayLinkAmount(hasAmount ? amount : '')
        : hasAmount ? String(amount) : '';
      let parsed: URL;
      try {
        parsed = resolveCardProviderUrl(provider.url, identity.wallet.address, amountStr);
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }

      // Antseed Pay authenticates the request: a personal-sign signature over
      // the buyer address, currency and amount (see @antseed/payments/card-link,
      // shared with the gateway console so both build the same link).
      if (payPage) {
        await signAntseedPayUrl(parsed, { wallet: identity.wallet, amount: amountStr, integration: payPage });
      }
      const url = parsed.toString();

      // Antseed Pay needs no wallet extension (the link is pre-signed), so it
      // opens as an app-owned checkout popup: the deposit watcher closes it
      // the moment the bought USDC lands, instead of stranding a browser tab.
      if (payPage) {
        // The full signed funding link — nothing secret in it (the sig is in
        // the URL by design), and having it in the dev log makes testing the
        // hosted page outside the popup trivial. Dev only: production output
        // shouldn't carry the buyer's address.
        if (isDev) console.log('[payments] antseed-pay funding link:', url);
        openCheckoutPopup(url, getMainWindow());
        return { ok: true, url };
      }

      try {
        await shell.openExternal(url);
        return { ok: true, url };
      } catch (err) {
        console.warn('[payments] system browser launch failed:', err instanceof Error ? err.message : String(err));
      }
      console.log('[payments] no system browser available — using Electron popup');
      openPaymentsPopup(url);
      return { ok: true, url };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('credits:get-info', async (_event, opts?: { fresh?: boolean }): Promise<{ ok: boolean; data: CreditsInfo | null; error: string | null }> => {
    try {
      // A remote gateway pays from the wallet behind its key, so the app
      // shows that balance, read from the gateway.
      if (getGatewaySettings().mode === 'remote' && !attachedGateway()) {
        return { ok: true, data: remoteCreditsInfo(await getGatewayKeyInfo()), error: null };
      }
      await ensureSecureIdentity();
      const address = getSecureIdentity()?.wallet.address ?? '';
      // Display polls (balance timer, focus handlers) share one read. A caller
      // deciding whether a payment can proceed passes `fresh` and always reads
      // the chain, as before.
      const info = opts?.fresh === true
        ? await refreshFresh(readKeys.credits(address), refreshCreditsInfo)
        : await cachedRead(readKeys.credits(address), CREDITS_FRESH_MS, refreshCreditsInfo);
      return { ok: true, data: info, error: null };
    } catch (err) {
      return { ok: false, data: null, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('deposits:watch-start', async () => {
    try {
      // No deposit address for a wallet that doesn't pay for this app's requests.
      const blocked = await localFundingBlock();
      if (blocked) return { ok: false, error: blocked };
      await ensureSecureIdentity();
      const identity = getSecureIdentity();
      if (!identity) return { ok: false, error: 'Identity not available' };
      const cc = await loadCachedCryptoConfig();
      if (!cc) return { ok: false, error: 'No payment chain configured' };
      const client = await getDepositsClient(cc);
      const address = identity.wallet.address;
      let balance = 0n;
      try {
        balance = await client.getUSDCBalance(address);
      } catch {
        // RPC hiccup — the daemon's watcher picks it up
      }
      // The daemon's watcher does the sweeping (it holds the same key and the
      // live relayer connections); this only promotes it to the fast cadence
      // and forwards its progress events. USDC already sitting in the wallet
      // is swept on the daemon's first fast tick.
      await startDepositWatch();
      return {
        ok: true,
        data: {
          address,
          walletUsdcBaseUnits: balance.toString(),
          usdcAddress: cc.usdcAddress,
          chainId: cc.chainId,
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('deposits:watch-stop', () => {
    // Not a hard stop: deliveries can land after the deposit view closes, so
    // the daemon's watcher demotes to a slow cadence and the status poll
    // lingers (and stops itself later).
    demoteDepositWatch();
    return { ok: true };
  });
}
