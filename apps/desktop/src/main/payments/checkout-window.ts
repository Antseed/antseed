/**
 * Checkout popup windows (the hosted AntSeed Pay page and any sized popups
 * it opens — card processors, sign-ins).
 *
 * Sized popups open as plain Electron child windows: no browser chrome (the
 * `--app` look), window.opener intact for OAuth postMessage flows, and the
 * app owns the handle — the deposit watcher closes every checkout window the
 * moment the bought USDC lands at the hot wallet.
 *
 * Plain `_blank` links (terms, explorers) still go to the system browser.
 */
import { app, screen, shell, BrowserWindow, type BrowserWindowConstructorOptions, type HandlerDetails } from 'electron';

type WindowOpenResponse =
  | { action: 'deny' }
  | { action: 'allow'; overrideBrowserWindowOptions?: BrowserWindowConstructorOptions };

const checkoutWindows = new Set<BrowserWindow>();

/** The SDK's checkout/sign-in popups always pass centered dimensions;
 *  ordinary link-outs pass "noopener" or nothing. */
function isSizedPopup(features: string): boolean {
  return /(?:^|,)\s*(?:width|height)\s*=/.test(features);
}

/** Chrome-equivalent UA. Google sign-in refuses agents that identify as an
 *  embedded shell (`disallowed_useragent`); dropping the app and Electron
 *  tokens leaves the stock Chrome UA, which it accepts. */
function browserUserAgent(): string {
  return app.userAgentFallback
    .split(`${app.getName()}/${app.getVersion()}`)
    .join('')
    .replace(/\sElectron\/\S+/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Window-open handler for any webContents that can host the Fun widget or
 * its checkout pages: sized popups become child windows, links leave for the
 * system browser.
 */
export function checkoutWindowOpenHandler(details: HandlerDetails): WindowOpenResponse {
  if (isSizedPopup(details.features)) {
    return {
      action: 'allow',
      overrideBrowserWindowOptions: {
        title: 'Antseed — Secure checkout',
        autoHideMenuBar: true,
        // webPreferences stay inherited on purpose: the SDK's spinner
        // injection needs the about:blank child in the opener's renderer
        // process, and the inherited preload refuses to expose the IPC
        // bridge to any document that isn't the app's own.
      },
    };
  }
  void shell.openExternal(details.url);
  return { action: 'deny' };
}

/**
 * Track a child window created by the handler above. Sign-in flows inside a
 * checkout page open popups of their own (Google OAuth needs window.opener),
 * so children get the same handler recursively.
 */
export function adoptCheckoutWindow(win: BrowserWindow): void {
  checkoutWindows.add(win);
  win.webContents.setUserAgent(browserUserAgent());
  win.webContents.setWindowOpenHandler(checkoutWindowOpenHandler);
  win.webContents.on('did-create-window', adoptCheckoutWindow);
  win.on('closed', () => {
    checkoutWindows.delete(win);
  });
}

/**
 * Open a hosted checkout page (e.g. the antseed-pay.com Stripe flow) as an
 * app-owned popup rather than a system-browser tab. These pages carry a
 * pre-signed funding link, so no wallet extension is needed — and adopting
 * the window means the deposit watcher closes it the moment the bought USDC
 * lands at the hot wallet, same as the Fun checkout windows.
 *
 * `parent` comes from the caller (ui/window.js imports this module, so
 * importing getMainWindow here would be a cycle).
 */
export function openCheckoutPopup(url: string, parent?: BrowserWindow | null): BrowserWindow {
  // Narrow, like the Fun SDK's sign-in popups — the page renders its bare
  // one-column checkout at this width. Tall enough that the Crossmint card
  // form fits without inner scrolling, clamped to the work area of whichever
  // display the app sits on.
  const display = parent && !parent.isDestroyed()
    ? screen.getDisplayMatching(parent.getBounds())
    : screen.getPrimaryDisplay();
  const height = Math.min(800, display.workArea.height - 24);
  const win = new BrowserWindow({
    width: 420,
    height,
    minWidth: 360,
    minHeight: 560,
    ...(parent && !parent.isDestroyed() ? { parent } : {}),
    title: 'Antseed — Secure checkout',
    autoHideMenuBar: true,
    backgroundColor: '#ffffff',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.setMenuBarVisibility(false);
  adoptCheckoutWindow(win);
  void win.loadURL(url);
  return win;
}

/** Close every open checkout window. Returns whether any were open. */
export function closeCheckoutWindows(): boolean {
  const hadWindows = checkoutWindows.size > 0;
  for (const win of [...checkoutWindows]) {
    if (!win.isDestroyed()) win.close();
  }
  checkoutWindows.clear();
  return hadWindows;
}
