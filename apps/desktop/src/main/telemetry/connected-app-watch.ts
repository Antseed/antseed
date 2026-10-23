/**
 * Spots a connected app's first request after it was connected, for the
 * `connected_app_first_request` event. The buyer proxy attributes each
 * conversation to a client `tool` slug and stamps `lastActiveAt`; a
 * conversation for one of the app's slugs that is active after the connect
 * time means the app sent a request. Only the fixed app name leaves the
 * device — never a slug, a snippet or a conversation id.
 */
import { SYSTEM_PROXY_PROFILES } from '../system-proxy/profiles.js';
import { effectiveToolSlugs } from '../connected-apps/profile-targets.js';
import { resolveBuyerProxyPort } from '../runtime/active-config.js';
import { LOCALHOST_URL } from '../constants.js';
import { CONNECTED_APP_FIRST_REQUEST_WINDOW_MS } from './telemetry.js';
import { getTelemetryService } from './runtime.js';
import type { TelemetryAppName } from '../../shared/telemetry.js';
import { conversationsShowRequestSince } from './connected-app-requests.js';

const POLL_INTERVAL_MS = 30_000;

const watches = new Map<TelemetryAppName, NodeJS.Timeout>();

function toolSlugsFor(app: TelemetryAppName): string[] {
  const profile = SYSTEM_PROXY_PROFILES.find((entry) => entry.name === app);
  if (!profile) return [];
  return effectiveToolSlugs(profile.name, profile.toolSlugs, profile.label);
}

async function listConversations(): Promise<unknown> {
  const port = await resolveBuyerProxyPort();
  const response = await fetch(`${LOCALHOST_URL}:${port}/_antseed/conversations`, {
    signal: AbortSignal.timeout(3_000),
  });
  if (!response.ok) return null;
  const parsed = await response.json() as { conversations?: unknown };
  return parsed.conversations ?? null;
}

/**
 * Polls the local proxy until the app's first request shows up or the
 * window closes. Apps without packaged slugs (Telegram, custom apps) are
 * not watched; their pending entry ends as `no_request`.
 */
export function watchConnectedAppFirstRequest(app: TelemetryAppName, connectedAtMs = Date.now()): void {
  const existing = watches.get(app);
  if (existing) clearInterval(existing);
  watches.delete(app);
  const slugs = toolSlugsFor(app);
  if (slugs.length === 0) return;
  const deadline = connectedAtMs + CONNECTED_APP_FIRST_REQUEST_WINDOW_MS;
  let polling = false;
  const timer = setInterval(() => {
    if (polling) return;
    if (Date.now() > deadline) {
      clearInterval(timer);
      watches.delete(app);
      return;
    }
    polling = true;
    void listConversations()
      .then((conversations) => {
        if (!conversationsShowRequestSince(conversations, slugs, connectedAtMs)) return;
        clearInterval(timer);
        watches.delete(app);
        void getTelemetryService()?.recordConnectedAppRequest(app);
      })
      .catch(() => undefined)
      .finally(() => { polling = false; });
  }, POLL_INTERVAL_MS);
  timer.unref?.();
  watches.set(app, timer);
}
