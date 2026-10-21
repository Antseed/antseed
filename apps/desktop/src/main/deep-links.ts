/**
 * `antseed://invite/<invite>` deep links (the "Open in Antseed" button on
 * antseed.com/invite/<invite>). macOS delivers them through `open-url`;
 * Windows and Linux start a second instance with the URL in argv, which the
 * single-instance lock hands to this one via `second-instance`. The invite is
 * held until the renderer has subscribed to `referral:deep-link` and asks for
 * it (see InviteLinkQueue); later links are pushed live.
 */
import path from 'node:path';
import { app, type BrowserWindow, type WebContents } from 'electron';
import { InviteLinkQueue } from './deep-link-queue.js';

export const DEEP_LINK_SCHEME = 'antseed';

const links = new InviteLinkQueue<WebContents>((contents, invite) => contents.send('referral:deep-link', invite));
/** The main window, once it exists, and how to bring it forward. */
let target: { getWindow: () => BrowserWindow | null; show: () => void } | null = null;
const watched = new WeakSet<WebContents>();

/** The invite in an `antseed://invite/<invite>` URL, or null for anything else. */
export function inviteFromDeepLink(url: string): string | null {
  const match = /^antseed:\/\/invite\/([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/i.exec(url.trim());
  return match ? match[1]! : null;
}

function handleUrl(url: string): void {
  const invite = inviteFromDeepLink(url);
  if (!invite) return;
  target?.show();
  links.receive(invite, target?.getWindow()?.webContents ?? null);
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

/** Push invites to the main window's renderer once it is ready (and focus it). */
export function deliverDeepLinksTo(getWindow: () => BrowserWindow | null, show: () => void): void {
  target = { getWindow, show };
}

/**
 * The renderer `sender` subscribed to `referral:deep-link`: hand it the invite
 * held so far, once, and push later ones to it until it navigates away.
 */
export function takePendingInviteLink(sender: WebContents): string | null {
  if (!watched.has(sender)) {
    watched.add(sender);
    sender.on('did-start-loading', () => links.reset(sender));
    sender.once('destroyed', () => links.reset(sender));
  }
  return links.take(sender);
}
