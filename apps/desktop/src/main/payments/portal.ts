/**
 * The payments portal: a local server for the wallet-signing pages, and the
 * windows that show them.
 *
 * Anything that needs the user's wallet has to leave the app — extensions and
 * WalletConnect only work in a real browser — so a pay page opens in the
 * user's default browser or, failing that, a plain Electron popup (which
 * closes itself once the payment lands).
 */
import { app, BrowserWindow, shell } from 'electron';
import { createServer as createPaymentsServer } from '@antseed/payments';
import { isDev } from '../app-context.js';
import { LOCALHOST, LOCALHOST_URL } from '../constants.js';
import { ACTIVE_CONFIG_PATH } from '../runtime/active-config.js';
import { readConfig } from '../runtime/config-io.js';
import { ensureSecureIdentity, secureIdentityEnv } from '../identity.js';
import { getMainWindow } from '../ui/window.js';
import { asRecord, asString } from '../utils.js';

export let paymentsServer: Awaited<ReturnType<typeof createPaymentsServer>> | null = null;
export const PAYMENTS_PORT = Number(process.env['ANTSEED_PAYMENTS_PORT']) || 3118;

export function focusMainWindow(): void {
  const win = getMainWindow();
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  app.focus({ steal: true });
  win.focus();
}

export async function startPaymentsPortal(): Promise<void> {
  if (paymentsServer) return;
  try {
    await ensureSecureIdentity();
    const identityHex = secureIdentityEnv().ANTSEED_IDENTITY_HEX;
    paymentsServer = await createPaymentsServer({
      port: PAYMENTS_PORT,
      identityHex,
      configPath: ACTIVE_CONFIG_PATH,
      onOpenRewards: async () => {
        const { stakingSessions } = await import('../staking/portal.js');
        await stakingSessions.open('rewards');
      },
      onPaymentCompleted: () => {
        // The payment landed in the browser — pull the app back up and let
        // the renderer refresh balances/channels/rewards immediately.
        focusMainWindow();
        getMainWindow()?.webContents.send('payments:completed');
      },
    });
    await paymentsServer.listen({ port: PAYMENTS_PORT, host: LOCALHOST });
    console.log(`[desktop] Payments portal running at ${LOCALHOST_URL}:${PAYMENTS_PORT}`);
  } catch (err) {
    console.error('[desktop] Failed to start payments portal:', err instanceof Error ? err.message : String(err));
    paymentsServer = null;
  }
}

export async function stopPaymentsPortal(): Promise<void> {
  if (!paymentsServer) return;
  try {
    await paymentsServer.close();
  } catch {
    // Already closed
  }
  paymentsServer = null;
}

export type PayPageKind = 'deposit' | 'withdraw' | 'authorize' | 'claim' | 'close-channel';
export const PAY_PAGE_KINDS: readonly PayPageKind[] = ['deposit', 'withdraw', 'authorize', 'claim', 'close-channel'];

export let paymentsPopup: BrowserWindow | null = null;

export function openPaymentsPopup(url: string): void {
  if (paymentsPopup && !paymentsPopup.isDestroyed()) {
    void paymentsPopup.loadURL(url);
    paymentsPopup.focus();
    return;
  }
  const parent = getMainWindow();
  paymentsPopup = new BrowserWindow({
    width: 480,
    height: 800,
    minWidth: 420,
    minHeight: 620,
    ...(parent ? { parent } : {}),
    title: 'Antseed — Secure payment',
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  paymentsPopup.setMenuBarVisibility(false);
  // Wallet deep links and explorer links leave the popup for the system
  // browser; the popup stays on the payment page only.
  paymentsPopup.webContents.setWindowOpenHandler(({ url: external }) => {
    void shell.openExternal(external);
    return { action: 'deny' };
  });
  paymentsPopup.on('closed', () => {
    paymentsPopup = null;
    focusMainWindow();
  });
  void paymentsPopup.loadURL(url);
}



// Card payments open a hosted checkout page. USDC bought with a card is
// delivered on Base to the buyer hot wallet and credited into AntseedDeposits
// via the P2P deposit relay — same path as a direct QR transfer.
//
// Providers come from config (payments.card.providers) as HTTPS URL templates
// with {address} and optional {amount} placeholders. The default is Antseed's
// hosted card page, which handles the Coinbase Onramp session server-side so
// the CDP secret key never ships inside the app.
export type CardProvider = { id: string; label: string; url: string };

// The hosted pay page. Dev builds target the locally-run checkout (the
// antseed-pay repo's `pnpm dev` on :3120) so the flow is testable end-to-end
// before a deploy; ANTSEED_PAY_URL overrides the target in any build.
const ANTSEED_PAY_URL =
  process.env['ANTSEED_PAY_URL']?.trim()
  || (isDev ? 'http://localhost:3120/' : 'https://antseed-pay.com/');

export const DEFAULT_CARD_PROVIDERS: CardProvider[] = [
  { id: 'meridian', label: 'Meridian', url: 'https://antseed.mrdn.finance/?buyer={address}' },
  { id: 'antseed-pay', label: 'Antseed Pay', url: ANTSEED_PAY_URL },
  // Same page, opened on its Stripe integration (US only).
  { id: 'antseed-pay-stripe', label: 'Antseed Pay (Stripe)', url: ANTSEED_PAY_URL },
];

/** Which pay-page integration a provider id opens; null for other providers. */
export function payPageProvider(id: string): 'crossmint' | 'stripe' | null {
  if (id === 'antseed-pay') return 'crossmint';
  if (id === 'antseed-pay-stripe') return 'stripe';
  return null;
}

// A configured empty array is respected (zero providers = card disabled);
// only a missing/invalid config falls back to the built-in default.
export async function readCardProviders(): Promise<CardProvider[]> {
  let entries: unknown;
  try {
    const config = await readConfig(ACTIVE_CONFIG_PATH);
    entries = asRecord(asRecord(config.payments).card).providers;
  } catch {
    return DEFAULT_CARD_PROVIDERS;
  }
  if (!Array.isArray(entries)) return DEFAULT_CARD_PROVIDERS;
  const providers: CardProvider[] = [];
  for (const entry of entries) {
    const record = asRecord(entry);
    const id = asString(record.id as string, '');
    const label = asString(record.label as string, '');
    const url = asString(record.url as string, '');
    if (id && label && url) providers.push({ id, label, url });
  }
  return providers;
}



/**
 * Bearer token the portal server expects on its pages. Empty until
 * `startPaymentsPortal()` has run.
 */
export function getPaymentsPortalToken(): string {
  return paymentsServer ? (paymentsServer as unknown as { bearerToken?: string }).bearerToken ?? '' : '';
}
