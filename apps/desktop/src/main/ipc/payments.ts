import { readBuyerRewardsSummary } from '../staking/buyer-rewards.js';
import { resolveStakingChain } from '../staking/configuration.js';
import { readConfig } from '../runtime/config-io.js';
import { ACTIVE_CONFIG_PATH } from '../runtime/active-config.js';
/**
 * IPC surface for deposits, balances, channels and the wallet-signing pages.
 */
import { ipcMain, shell } from 'electron';
import {
  isDev,
} from '../app-context.js';
import {
  LOCALHOST_URL,
} from '../constants.js';
import {
  ensureSecureIdentity,
  getSecureIdentity,
} from '../identity.js';
import {
  BYTES32_RE,
  type DesktopBuyerUsageTotals,
  type DesktopPaymentChannelSummary,
  type DesktopRewardsSummary,
  EMPTY_REWARDS_SUMMARY,
  MAX_SPENDING_AUTH_BASE_UNITS,
  fetchBuyerProxyJson,
  loadBuyerChannels,
  normalizeBuyerUsageTotals,
  notePendingSpend,
  requestCooperativeChannelClose,
} from '../payments/buyer-channels.js';
import { resolveServiceIdHashes } from '../payments/service-hash-resolver.js';
import {
  type CreditsInfo,
  loadCachedCryptoConfig,
  refreshCreditsInfo,
} from '../payments/credits.js';
import {
  buildLocalBuyerSpendHistory,
  type DesktopBuyerSpendHistory,
  unavailableLocalBuyerSpendHistory,
} from '../payments/buyer-spend-history.js';
import {
  demoteDepositWatch,
  makeDepositsClient,
  startDepositWatch,
} from '../payments/deposit-sweep.js';
import {
  DEFAULT_CARD_PROVIDERS,
  PAYMENTS_PORT,
  PAY_PAGE_KINDS,
  type PayPageKind,
  focusMainWindow,
  getPaymentsPortalToken,
  openPaymentsPopup,
  payPageProvider,
  readCardProviders,
  startPaymentsPortal,
} from '../payments/portal.js';
import { closeCheckoutWindows, openCheckoutPopup } from '../payments/checkout-window.js';
import { getMainWindow } from '../ui/window.js';
import {
  lookupPeer,
  refreshPeerCache,
} from '../runtime/peer-cache.js';
import {
  makeChannelsDomain,
  peerIdToAddress,
  signSpendingAuth,
} from '@antseed/node';

export function registerPaymentsIpc(): void {
  // Slim payment pages: only actions that need an external wallet signature
  // (connected-wallet deposit, withdraw, authorize-operator, channel close,
  // rewards claims) leave the app — everything else renders in-app. The full
  // portal dashboard is retired.
  //
  // Preferred surface: a regular tab in the user's default browser, where
  // extension wallets like MetaMask work in their normal profile. Only when
  // that fails does a sandboxed Electron popup take over (WalletConnect/QR
  // flows only).
  ipcMain.handle('payments:open-pay-page', async (_event, opts: { kind?: PayPageKind; amountUsdc?: string; channelId?: string }) => {
    try {
      const kind: PayPageKind = opts?.kind && PAY_PAGE_KINDS.includes(opts.kind) ? opts.kind : 'deposit';
      if (kind === 'claim') {
        const { stakingSessions } = await import('../staking/portal.js');
        await stakingSessions.open('rewards');
        return { ok: true };
      }
      await startPaymentsPortal();
      const token = getPaymentsPortalToken();
      const params = new URLSearchParams();
      if (token) params.set('token', token);
      params.set('page', 'pay');
      params.set('action', kind);
      const amount = Number(opts?.amountUsdc);
      if (Number.isFinite(amount) && amount > 0) params.set('amount', String(amount));
      if (kind === 'close-channel' && typeof opts?.channelId === 'string' && BYTES32_RE.test(opts.channelId)) {
        params.set('channel', opts.channelId);
      }
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

  ipcMain.handle('payments:card-providers', async () => {
    try {
      const providers = await readCardProviders();
      // Only id + label cross into the renderer — URLs stay in the main process.
      return { ok: true, data: providers.map(({ id, label }) => ({ id, label })) };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('payments:open-card-provider', async (_event, opts?: { providerId?: string; amountUsdc?: string }) => {
    try {
      await ensureSecureIdentity();
      const identity = getSecureIdentity();
      if (!identity) return { ok: false, error: 'Identity not available' };
      const providers = await readCardProviders();
      // The chooser's fixed lineup (Meridian, Antseed Pay) must resolve even
      // when a legacy config overrides the provider list with other entries.
      const provider = opts?.providerId
        ? providers.find((entry) => entry.id === opts.providerId)
          ?? DEFAULT_CARD_PROVIDERS.find((entry) => entry.id === opts.providerId)
        : providers[0];
      if (!provider) return { ok: false, error: 'card-not-configured' };

      const amount = Number(opts?.amountUsdc);
      const hasAmount = Number.isFinite(amount) && amount > 0;
      let template = provider.url.split('{address}').join(identity.wallet.address);
      if (hasAmount) template = template.split('{amount}').join(String(amount));
      let parsed: URL;
      try {
        parsed = new URL(template);
      } catch {
        return { ok: false, error: 'Card provider URL is invalid' };
      }
      // https only — except loopback, so a locally-run payment page can be
      // tested from the app before it is deployed.
      const isLoopback = parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost';
      if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback)) {
        return { ok: false, error: 'Card provider URL must be https' };
      }
      if (!hasAmount) {
        // No amount entered — drop query params still carrying the placeholder.
        for (const [key, value] of [...parsed.searchParams.entries()]) {
          if (value.includes('{amount}')) parsed.searchParams.delete(key);
        }
      }

      // Antseed Pay authenticates the request: the page expects the buyer
      // address, currency and amount plus a personal-sign signature over the
      // canonical message below, proving the params came from this wallet.
      // The signed message carries the LOWERCASED address (the URL param stays
      // checksummed) — verified against the reference sig their page accepts.
      // The header line is a wire-format constant that must match the page's
      // `buildFundingMessage` byte for byte ("AntSeed Pay", capital S); it is
      // not display copy and must not follow product-name renames.
      const payPage = payPageProvider(provider.id);
      if (payPage) {
        const cur = 'USD';
        const amountStr = hasAmount ? String(amount) : '';
        const message = [
          'AntSeed Pay',
          `address: ${identity.wallet.address.toLowerCase()}`,
          `currency: ${cur}`,
          `amount: ${amountStr}`,
        ].join('\n');
        parsed.searchParams.set('address', identity.wallet.address);
        parsed.searchParams.set('cur', cur);
        if (amountStr) parsed.searchParams.set('amount', amountStr);
        parsed.searchParams.set('sig', await identity.wallet.signMessage(message));
        // Open the page on exactly one integration (no provider tab strip).
        // Unsigned, UX-only.
        parsed.searchParams.set('provider', payPage);
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

  // The renderer closes checkout popup windows on flows that never produce
  // a deposit.
  ipcMain.handle('payments:close-checkout-windows', () => {
    if (closeCheckoutWindows()) focusMainWindow();
    return { ok: true };
  });

  ipcMain.handle('credits:get-info', async (): Promise<{ ok: boolean; data: CreditsInfo | null; error: string | null }> => {
    try {
      await ensureSecureIdentity();
      const info = await refreshCreditsInfo();
      return { ok: true, data: info, error: null };
    } catch (err) {
      return { ok: false, data: null, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('deposits:watch-start', async () => {
    try {
      await ensureSecureIdentity();
      const identity = getSecureIdentity();
      if (!identity) return { ok: false, error: 'Identity not available' };
      const cc = await loadCachedCryptoConfig();
      if (!cc) return { ok: false, error: 'No payment chain configured' };
      const client = makeDepositsClient(cc);
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

  // Max spending per session: $5 USDC = 5,000,000 base units. Main process enforces
  // this cap to prevent a compromised renderer from signing unbounded authorizations.
  ipcMain.handle('payments:sign-spending-auth', async (_event, params: {
    channelId: string;
    cumulativeAmountBaseUnits: string;
    metadataHash: string;
  }) => {
    try {
      // Validate renderer-supplied parameters at the trust boundary
      if (!BYTES32_RE.test(params.channelId)) {
        return { ok: false, error: 'Invalid channel ID format' };
      }
      const cumulativeAmount = BigInt(params.cumulativeAmountBaseUnits);
      if (cumulativeAmount <= 0n || cumulativeAmount > MAX_SPENDING_AUTH_BASE_UNITS) {
        return { ok: false, error: `cumulativeAmount exceeds cap (${MAX_SPENDING_AUTH_BASE_UNITS} base units)` };
      }
      if (!BYTES32_RE.test(params.metadataHash)) {
        return { ok: false, error: 'Invalid metadataHash format' };
      }

      await ensureSecureIdentity();
      const identity = getSecureIdentity();
      if (!identity) {
        return { ok: false, error: 'Identity not available' };
      }

      const cc = await loadCachedCryptoConfig();
      if (!cc) {
        return { ok: false, error: 'No channels contract configured' };
      }

      const wallet = identity.wallet;

      // Sign SpendingAuth (Antseed Channels domain)
      const channelsDomain = makeChannelsDomain(cc.chainId, cc.channelsAddress);
      const spendingAuthSig = await signSpendingAuth(wallet, channelsDomain, {
        channelId: params.channelId,
        cumulativeAmount,
        metadataHash: params.metadataHash,
      });

      const buyerEvmAddress = identity.wallet.address;

      return {
        ok: true,
        data: {
          spendingAuthSig,
          buyerEvmAddress,
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('payments:get-peer-info', async (_event, peerId: string) => {
    try {
      if (typeof peerId !== 'string' || peerId.trim().length === 0) {
        return { ok: false, error: 'Invalid peerId' };
      }
      await refreshPeerCache();
      const peer = lookupPeer(peerId.trim());
      if (!peer) {
        return { ok: false, error: 'Peer not found' };
      }

      return {
        ok: true,
        data: {
          peerId: peer.peerId,
          displayName: peer.displayName ?? null,
          reputation: peer.reputation ?? 0,
          onChainChannelCount: (peer as Record<string, unknown>).onChainChannelCount ?? null,
          onChainGhostCount: (peer as Record<string, unknown>).onChainGhostCount ?? null,
          evmAddress: peer.peerId ? peerIdToAddress(peer.peerId) : null,
          timestamp: (peer as Record<string, unknown>).timestamp ?? null,
          providers: peer.providers ?? [],
          services: peer.services ?? [],
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipcMain.handle('payments:get-buyer-usage', async (): Promise<{ ok: boolean; data: DesktopBuyerUsageTotals | null; error: string | null; lastActivityAt: number | null }> => {
    const body = await fetchBuyerProxyJson('/_antseed/buyer-usage');
    if (!body) {
      return { ok: false, data: null, error: 'buyer proxy unreachable', lastActivityAt: null };
    }
    const lastActivityAt = typeof body['lastActivityAt'] === 'number' ? body['lastActivityAt'] : null;
    const totals = normalizeBuyerUsageTotals(body['totals']);
    // Resolve service-id hashes to model names so the renderer can price
    // usage against the retail baseline for the "Saving" tile.
    if (totals.services.length > 0) {
      const names = await resolveServiceIdHashes(totals.services.map((s) => s.serviceIdHash));
      totals.services = totals.services.map((s) => ({
        ...s,
        serviceName: names.get(s.serviceIdHash.toLowerCase()) ?? null,
      }));
    }
    return {
      ok: true,
      data: totals,
      error: null,
      lastActivityAt,
    };
  });

  ipcMain.handle('payments:get-buyer-spend-history', async (): Promise<{ ok: boolean; data: DesktopBuyerSpendHistory | null; error: string | null }> => {
    const channels = await loadBuyerChannels(true, false);
    if (!channels) {
      return { ok: false, data: unavailableLocalBuyerSpendHistory(), error: 'buyer proxy unreachable' };
    }
    return { ok: true, data: buildLocalBuyerSpendHistory(channels), error: null };
  });

  ipcMain.handle('payments:get-channels', async (): Promise<{ ok: boolean; data: DesktopPaymentChannelSummary[] | null; error: string | null }> => {
    const channels = await loadBuyerChannels(true);
    if (!channels) {
      return { ok: false, data: null, error: 'buyer proxy unreachable' };
    }
    notePendingSpend(channels);
    return { ok: true, data: channels, error: null };
  });

  ipcMain.handle('payments:request-cooperative-close', async (_event, opts?: { peerId?: string }) => {
    const peerId = typeof opts?.peerId === 'string' ? opts.peerId.trim() : '';
    if (!peerId) {
      return { ok: false, result: null, error: 'Invalid peerId' };
    }
    try {
      const result = await requestCooperativeChannelClose(peerId);
      return { ok: true, result, error: null };
    } catch (err) {
      return {
        ok: false,
        result: null,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  ipcMain.handle('payments:get-rewards-summary', async (): Promise<{ ok: boolean; data: DesktopRewardsSummary | null; error: string | null }> => {
    try {
      await ensureSecureIdentity();
      const identity = getSecureIdentity();
      if (!identity) return { ok: true, data: EMPTY_REWARDS_SUMMARY, error: null };
      const chain = resolveStakingChain(await readConfig(ACTIVE_CONFIG_PATH));
      return { ok: true, data: await readBuyerRewardsSummary(chain, identity.wallet.address), error: null };
    } catch (err) {
      return {
        ok: true,
        data: { ...EMPTY_REWARDS_SUMMARY, error: err instanceof Error ? err.message : String(err) },
        error: null,
      };
    }
  });
}
