/**
 * Bridge to the buyer daemon's hot-wallet deposit watcher.
 *
 * The watcher itself (balance polling, EIP-3009 signing, relayer dispatch,
 * on-chain confirmation) lives in the CLI daemon — the daemon holds the same
 * identity key and the live P2P connections, and a second signer here would
 * race it over the same wallet. This module only promotes/demotes the
 * daemon's watcher over the proxy control plane and forwards its status
 * events to the renderer.
 */
import { LOCALHOST_URL } from '../constants.js';
import { resolveBuyerProxyPort } from '../runtime/active-config.js';
import { getMainWindow } from '../ui/window.js';
import { closeCheckoutWindows } from './checkout-window.js';
import { focusMainWindow } from './portal.js';
import { invalidateCreditsCache } from './credits.js';
import { getTelemetryService } from '../telemetry/runtime.js';
import { classifyDepositFailure } from '../telemetry/classify.js';

type DepositWatchStatus = {
  phase: 'deferred' | 'received' | 'sweeping' | 'credited' | 'error';
  amountBaseUnits?: string;
  txHash?: string;
  error?: string;
};

/** Wire shape of the daemon's watcher status (see apps/cli deposit-watcher). */
type DaemonWatchEvent = DepositWatchStatus & { seq: number; at: number };
type DaemonWatchStatus = {
  mode: 'active' | 'background' | 'idle' | 'off';
  address: string;
  usdcBalance: string;
  sweepInFlight: boolean;
  lastEvent: DaemonWatchEvent | null;
};

export const DEPOSIT_WATCH_INTERVAL_MS = 2_000;
// Cadence after the deposit view closes: card/Fun deliveries can land minutes
// later, so the status poll lingers at a slow cadence instead of stopping
// outright (the daemon keeps sweeping either way — this only keeps the
// progress banner alive).
export const DEPOSIT_WATCH_BACKGROUND_INTERVAL_MS = 15_000;
// How long the background status poll keeps running with an empty wallet
// before stopping. Any activity (funds present, sweep in flight) re-arms it.
const DEPOSIT_WATCH_LINGER_MS = 30 * 60_000;

let pollTimer: NodeJS.Timeout | null = null;
let pollMode: 'active' | 'background' = 'active';
let pollLingerDeadline = 0;
let lastForwardedSeq = 0;
// The daemon can start seconds after the deposit view opens (process-manager
// races) — remember the requested mode and re-send it once it answers.
let pendingDaemonMode: 'active' | 'background' | null = null;
// The daemon drops an unrefreshed active watch back to background after five
// minutes, so re-request it while the deposit view stays open.
const DEPOSIT_WATCH_ACTIVE_REFRESH_MS = 60_000;
let activeRequestedAt = 0;

function sendDepositWatchStatus(status: DepositWatchStatus): void {
  // Funds arriving at the hot wallet means an in-flight checkout (Fun card /
  // sign-in popup) succeeded — close its windows and bring the app back up
  // so the user lands on the deposit progress banner.
  if (status.phase === 'received' || status.phase === 'credited') {
    if (closeCheckoutWindows()) focusMainWindow();
  }
  getMainWindow()?.webContents.send('deposits:watch-status', status);
}

async function buyerDaemonFetch(pathname: string, init?: RequestInit, timeoutMs = 5_000): Promise<Response | null> {
  try {
    const port = await resolveBuyerProxyPort();
    return await fetch(`${LOCALHOST_URL}:${port}${pathname}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return null;
  }
}

/** Banner text for the daemon-reported watcher-absence reason (older daemons send none). */
function watcherAbsenceBanner(reason: string | null): string {
  if (reason === 'payments-disabled') {
    return 'Automatic deposit is paused because payments are disabled on this buyer. Your USDC is safe in the wallet.';
  }
  if (reason === 'no-deposit-relay') {
    return 'Automatic deposit is not available on this chain yet. Your USDC is safe in the wallet.';
  }
  return 'Automatic deposit is not running right now. Your USDC is safe in the wallet.';
}

async function daemonWatchStatus(): Promise<{ watcher: boolean; reason: string | null; status: DaemonWatchStatus | null } | null> {
  const res = await buyerDaemonFetch('/_antseed/deposits/status', undefined, 3_000);
  if (!res) return null;
  const body = await res.json().catch(() => null) as { ok?: boolean; watcher?: boolean; reason?: string | null; status?: DaemonWatchStatus | null } | null;
  if (!res.ok || !body?.ok) return null;
  return { watcher: body.watcher === true, reason: typeof body.reason === 'string' ? body.reason : null, status: body.status ?? null };
}

async function daemonSetWatchMode(mode: 'active' | 'background'): Promise<boolean> {
  if (mode === 'active') activeRequestedAt = Date.now();
  const res = await buyerDaemonFetch('/_antseed/deposits/watch', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ mode }),
  });
  const body = await res?.json().catch(() => null) as { ok?: boolean } | null;
  return body?.ok === true;
}

async function pollDaemonWatch(): Promise<void> {
  const current = await daemonWatchStatus();
  if (!current) return; // daemon not up yet — pendingDaemonMode re-sends below

  if (!current.watcher) {
    // The daemon answered but runs no watcher — surface the daemon-reported
    // cause once instead of re-asking (older daemons send no reason).
    if (pendingDaemonMode) {
      pendingDaemonMode = null;
      sendDepositWatchStatus({ phase: 'error', error: watcherAbsenceBanner(current.reason) });
      void getTelemetryService()?.recordDepositFailed(classifyDepositFailure('', current.reason));
    }
    return;
  }

  if (pendingDaemonMode) {
    const mode = pendingDaemonMode;
    const ok = await daemonSetWatchMode(mode);
    // Clear only when no newer request superseded this one during the await.
    if (ok && pendingDaemonMode === mode) pendingDaemonMode = null;
  }

  if (pollMode === 'active' && !pendingDaemonMode && Date.now() - activeRequestedAt >= DEPOSIT_WATCH_ACTIVE_REFRESH_MS) {
    void daemonSetWatchMode('active');
  }

  const status = current.status;
  if (pollMode === 'background') {
    const busy = status ? BigInt(status.usdcBalance || '0') > 0n || status.sweepInFlight : false;
    if (busy) {
      pollLingerDeadline = Date.now() + DEPOSIT_WATCH_LINGER_MS;
    } else if (Date.now() > pollLingerDeadline) {
      // The daemon keeps its own watch; only this banner poll stops.
      stopDepositWatchPoll();
      return;
    }
  }

  const event = status?.lastEvent;
  if (!event || event.seq <= lastForwardedSeq) return;
  lastForwardedSeq = event.seq;
  if (event.phase === 'credited') {
    invalidateCreditsCache();
    // Anonymous funnel telemetry: only coarse buckets leave the device —
    // never the exact amount, wallet address, or tx hash.
    void getTelemetryService()?.recordDepositCredited(event.amountBaseUnits ?? '0');
  } else if (event.phase === 'error') {
    void getTelemetryService()?.recordDepositFailed(classifyDepositFailure(event.error ?? ''));
  }
  sendDepositWatchStatus({
    phase: event.phase,
    ...(event.amountBaseUnits ? { amountBaseUnits: event.amountBaseUnits } : {}),
    ...(event.txHash ? { txHash: event.txHash } : {}),
    ...(event.error ? { error: event.error } : {}),
  });
}

function startPollTimer(mode: 'active' | 'background', intervalMs: number): void {
  if (pollTimer) clearInterval(pollTimer);
  pollMode = mode;
  pollTimer = setInterval(() => { void pollDaemonWatch(); }, intervalMs);
}

/**
 * The deposit view opened: promote the daemon's watcher to its fast cadence
 * and start forwarding its status events to the renderer.
 */
export async function startDepositWatch(): Promise<void> {
  // Baseline on the daemon's current event so a sweep from an earlier session
  // isn't replayed into the fresh view.
  const initial = await daemonWatchStatus();
  lastForwardedSeq = initial?.status?.lastEvent?.seq ?? 0;
  pendingDaemonMode = (initial && await daemonSetWatchMode('active')) ? null : 'active';
  startPollTimer('active', DEPOSIT_WATCH_INTERVAL_MS);
}

/**
 * The deposit view closed: don't stop — deliveries (card/Fun purchases) can
 * land minutes later. Demote the daemon's watcher and keep a slow status
 * poll so late deliveries still surface in the global progress banner.
 */
export function demoteDepositWatch(): void {
  if (!pollTimer) return;
  pollLingerDeadline = Date.now() + DEPOSIT_WATCH_LINGER_MS;
  pendingDaemonMode = 'background';
  void daemonSetWatchMode('background').then((ok) => {
    if (ok && pendingDaemonMode === 'background') pendingDaemonMode = null;
  });
  startPollTimer('background', DEPOSIT_WATCH_BACKGROUND_INTERVAL_MS);
}

export function stopDepositWatchPoll(): void {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
  pendingDaemonMode = null;
}
