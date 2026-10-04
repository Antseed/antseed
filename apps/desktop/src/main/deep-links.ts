/**
 * `antseed://invite/<invite>` deep links (the "Open in Antseed" button on
 * antseed.com/invite/<invite>). macOS delivers them through `open-url`;
 * Windows and Linux start a second instance with the URL in argv, which the
 * single-instance lock hands to this one via `second-instance`. The invite is
 * kept until the renderer takes it, then pushed live on `referral:deep-link`.
 */
import path from 'node:path';
import { app, type BrowserWindow } from 'electron';

export const DEEP_LINK_SCHEME = 'antseed';

let pendingInvite: string | null = null;
/** Sends the invite to a live window; false while there is none yet. */
let deliver: ((invite: string) => boolean) | null = null;

/** The invite in an `antseed://invite/<invite>` URL, or null for anything else. */
export function inviteFromDeepLink(url: string): string | null {
  const match = /^antseed:\/\/invite\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/i.exec(url.trim());
  return match ? match[1]! : null;
}

function handleUrl(url: string): void {
  const invite = inviteFromDeepLink(url);
  if (!invite) return;
  pendingInvite = deliver?.(invite) ? null : invite;
}

function handleArgv(argv: string[]): void {
  for (const arg of argv) if (arg.toLowerCase().startsWith(`${DEEP_LINK_SCHEME}://`)) handleUrl(arg);
}

/**
 * Register the scheme and its listeners. Call before `app.whenReady()`: macOS
 * may fire `open-url` for the link that launched the app before ready.
 * Returns false when another instance holds the lock and this one should quit.
 */
export function registerDeepLinks(options: { singleInstance: boolean; onSecondInstance: () => void }): boolean {
  if (options.singleInstance && !app.requestSingleInstanceLock()) return false;
  if (process.defaultApp && process.argv[1]) {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    app.setAsDefaultProtocolClient(DEEP_LINK_SCHEME);
  }
  app.on('open-url', (event, url) => {
    event.preventDefault();
    handleUrl(url);
  });
  app.on('second-instance', (_event, argv) => {
    handleArgv(argv);
    options.onSecondInstance();
  });
  handleArgv(process.argv);
  return true;
}

/** Push invites to the renderer once a window exists (and focus it). */
export function deliverDeepLinksTo(getWindow: () => BrowserWindow | null, show: () => void): void {
  deliver = (invite) => {
    show();
    const window = getWindow();
    if (!window || window.webContents.isLoading()) return false;
    window.webContents.send('referral:deep-link', invite);
    return true;
  };
}

/** The invite from the link that launched or focused the app, once. */
export function takePendingInviteLink(): string | null {
  const invite = pendingInvite;
  pendingInvite = null;
  return invite;
}
