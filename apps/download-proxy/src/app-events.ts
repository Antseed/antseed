/**
 * Post-install milestones, forwarded to GA4 under the visitor's original
 * client id (see attribution.ts for how the id reaches the app).
 *
 * Two entry points:
 *   POST /app-events   the desktop app reports milestones as
 *                      {token?, install_id?, events: [{name, params}]}
 *   GET  /i?f=<name>   the Windows installer's fire-and-forget beacon, sent
 *                      before the app has ever run; carries its own filename
 *
 * The event catalog is fixed and every param is allowlisted, mirroring the
 * desktop telemetry rules: nothing arrives here that the app did not already
 * classify into a coarse bucket.
 *
 * Attribution, in order of trust (sent as `attribution_method`):
 *   token   the app read the stamp from its installer filename — exact
 *   match   no token; the proxy matched the install to one recent download
 *           from the same platform and IP hash (match.ts) — probabilistic
 *   none    neither; delivered under the app's random install id so the
 *           total count stays honest, flagged attributed=0
 */

import {installTokenFromFilename, verifyInstallToken} from './attribution';
import {deliverEvent, type DownloadEvent, type Ga4Delivery} from './events';
import {appPlatformToProxy, matchInstall, type AttributionStore} from './match';

export const APP_EVENT_NAMES: ReadonlySet<string> = new Set([
  'installer_started',
  'app_first_opened',
  'app_onboarded',
  'app_activated',
  'tool_connected',
  'first_chat_started',
  'deposit_completed',
]);

const APP_EVENT_PARAMS: ReadonlySet<string> = new Set([
  'platform',
  'arch',
  'app_version',
  'install_source',
  'kind',
  'app',
  'amount_bucket',
  'is_first_deposit',
  'days_since_first_open',
  'service_category',
]);

export type AttributionMethod = 'token' | 'match' | 'none';

const MAX_BODY_BYTES = 8 * 1024;
const MAX_EVENTS = 10;
const MAX_STRING_LENGTH = 64;
const INSTALL_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILENAME_RE = /^[A-Za-z0-9._-]{1,200}$/;

export interface AppEventsBody {
  token: string | null;
  installId: string | null;
  events: DownloadEvent[];
}

function sanitizeParams(raw: unknown): Record<string, string | number> {
  const params: Record<string, string | number> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return params;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!APP_EVENT_PARAMS.has(key)) continue;
    if (typeof value === 'string') params[key] = value.slice(0, MAX_STRING_LENGTH);
    else if (typeof value === 'number' && Number.isFinite(value)) params[key] = Math.round(value);
    else if (typeof value === 'boolean') params[key] = value ? 1 : 0;
  }
  return params;
}

/** Parse and validate a request body; null when it is not a well-formed report. */
export function parseAppEventsBody(raw: unknown): AppEventsBody | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const token = typeof record['token'] === 'string' && record['token'].length <= 256 ? record['token'] : null;
  const installId =
    typeof record['install_id'] === 'string' && INSTALL_ID_RE.test(record['install_id'])
      ? record['install_id'].toLowerCase()
      : null;
  if (!Array.isArray(record['events']) || record['events'].length === 0) return null;
  const events: DownloadEvent[] = [];
  for (const entry of record['events'].slice(0, MAX_EVENTS)) {
    if (!entry || typeof entry !== 'object') continue;
    const name = (entry as Record<string, unknown>)['name'];
    if (typeof name !== 'string' || !APP_EVENT_NAMES.has(name)) continue;
    events.push({name, params: sanitizeParams((entry as Record<string, unknown>)['params'])});
  }
  if (events.length === 0) return null;
  return {token, installId, events};
}

export interface AppEventsEnv {
  GA4_MEASUREMENT_ID?: string;
  GA4_API_SECRET?: string;
  ATTRIBUTION_SECRET?: string;
  /** Workers KV for server-side install matching; unset disables the match path. */
  ATTRIBUTION_KV?: AttributionStore;
}

type Deliver = (event: DownloadEvent, ga: Ga4Delivery) => Promise<void>;

interface Resolved {
  ids: Ga4Delivery['ids'];
  method: AttributionMethod;
  ref: string | null;
}

async function resolveIds(
  body: AppEventsBody,
  env: AppEventsEnv,
  request: {ip: string | null; platform: unknown; arch: unknown},
  nowMs: number,
): Promise<Resolved> {
  const secret = env.ATTRIBUTION_SECRET;
  const verified = body.token && secret ? await verifyInstallToken(body.token, secret, nowMs) : null;
  if (verified) {
    return {ids: {clientId: verified.clientId, sessionId: verified.sessionId}, method: 'token', ref: verified.ref};
  }
  if (secret && env.ATTRIBUTION_KV) {
    const matched = await matchInstall(env.ATTRIBUTION_KV, secret, {
      ip: request.ip,
      platform: appPlatformToProxy(request.platform),
      arch: typeof request.arch === 'string' ? request.arch : null,
      installId: body.installId,
      nowMs,
    });
    if (matched) return {ids: {clientId: matched.clientId, sessionId: matched.sessionId}, method: 'match', ref: matched.ref};
  }
  // Nothing usable: keep the event countable under the app's own random
  // install id. deliverEvent marks it attributed=0 because the id is not a
  // GA client id shape — GA4 still accepts any non-empty string.
  return {ids: {clientId: null, sessionId: null, fallbackClientId: body.installId}, method: 'none', ref: null};
}

/** POST /app-events */
export async function handleAppEvents(
  request: Request,
  env: AppEventsEnv,
  ctx: {waitUntil: (promise: Promise<unknown>) => void},
  options: {deliver?: Deliver; nowMs?: number} = {},
): Promise<Response> {
  const declared = Number(request.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return new Response('payload too large', {status: 413});
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return new Response('payload too large', {status: 413});
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return new Response('bad request', {status: 400});
  }
  const body = parseAppEventsBody(raw);
  if (!body) return new Response('bad request', {status: 400});

  const deliver = options.deliver ?? deliverEvent;
  const first = body.events[0]!.params;
  const resolved = await resolveIds(
    body,
    env,
    {ip: request.headers.get('cf-connecting-ip'), platform: first['platform'], arch: first['arch']},
    options.nowMs ?? Date.now(),
  );
  const ga: Ga4Delivery = {measurementId: env.GA4_MEASUREMENT_ID, apiSecret: env.GA4_API_SECRET, ids: resolved.ids};
  const events = body.events.map(event => ({
    name: event.name,
    params: {...event.params, attribution_method: resolved.method, ...(resolved.ref ? {ref: resolved.ref} : {})},
  }));
  ctx.waitUntil(Promise.all(events.map(event => deliver(event, ga))));
  return new Response(null, {status: 204});
}

/** GET /i?f=<installer filename> — the installer's own beacon. */
export async function handleInstallerBeacon(
  url: URL,
  env: AppEventsEnv,
  ctx: {waitUntil: (promise: Promise<unknown>) => void},
  options: {deliver?: Deliver; nowMs?: number} = {},
): Promise<Response> {
  const filename = url.searchParams.get('f') ?? '';
  if (!FILENAME_RE.test(filename)) return new Response('bad request', {status: 400});
  const token = installTokenFromFilename(filename);
  const nowMs = options.nowMs ?? Date.now();
  const verified = token && env.ATTRIBUTION_SECRET ? await verifyInstallToken(token, env.ATTRIBUTION_SECRET, nowMs) : null;
  const ids: Ga4Delivery['ids'] = verified
    ? {clientId: verified.clientId, sessionId: verified.sessionId}
    : {clientId: null, sessionId: null};
  const platform = /\.exe$/i.test(filename) ? 'win' : /\.dmg$/i.test(filename) ? 'mac' : 'linux';
  const deliver = options.deliver ?? deliverEvent;
  ctx.waitUntil(
    deliver(
      {
        name: 'installer_started',
        params: {
          platform,
          install_source: platform === 'win' ? 'nsis' : platform,
          attribution_method: verified ? 'token' : 'none',
          ...(verified?.ref ? {ref: verified.ref} : {}),
        },
      },
      {measurementId: env.GA4_MEASUREMENT_ID, apiSecret: env.GA4_API_SECRET, ids},
    ),
  );
  return new Response(null, {status: 204, headers: {'cache-control': 'no-store'}});
}
