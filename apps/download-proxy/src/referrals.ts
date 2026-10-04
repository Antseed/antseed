export interface ReferralAttributionStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface ReferralAttributionEnv {
  REFERRAL_ATTRIBUTION?: ReferralAttributionStore;
  REFERRAL_HASH_SECRET?: string;
}

type ReferralObservation = { referrer: string; seenAt: number };
type ReferralRecord = { observations: ReferralObservation[]; expiresAt: number };

const ATTRIBUTION_TTL_SECONDS = 48 * 60 * 60;
const ATTRIBUTION_TTL_MS = ATTRIBUTION_TTL_SECONDS * 1000;
const MAX_OBSERVATIONS = 4;
const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

export function normalizeReferrer(value: string | null): string | null {
  const normalized = value?.trim() ?? '';
  return ADDRESS_PATTERN.test(normalized) ? normalized.toLowerCase() : null;
}

function clientIp(request: Request): string | null {
  const value = request.headers.get('cf-connecting-ip')?.trim();
  return value || null;
}

async function attributionKey(request: Request, secret: string): Promise<string | null> {
  const ip = clientIp(request);
  if (!ip) return null;
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`referral-ip-v1:${ip}`));
  return `ip:${Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

function parseRecord(raw: string | null, now: number): ReferralRecord {
  try {
    const parsed = JSON.parse(raw ?? '') as ReferralRecord;
    if (Array.isArray(parsed.observations) && parsed.expiresAt > now) return parsed;
  } catch {
    // Missing or corrupt record: start fresh.
  }
  return { observations: [], expiresAt: now + ATTRIBUTION_TTL_MS };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' },
  });
}

export async function recordReferralDownload(
  request: Request,
  env: ReferralAttributionEnv,
  rawReferrer: string | null,
  now = Date.now(),
): Promise<void> {
  const referrer = normalizeReferrer(rawReferrer);
  if (!referrer || !env.REFERRAL_ATTRIBUTION || !env.REFERRAL_HASH_SECRET) return;
  const key = await attributionKey(request, env.REFERRAL_HASH_SECRET);
  if (!key) return;

  const record = parseRecord(await env.REFERRAL_ATTRIBUTION.get(key), now);
  const observations = [...record.observations.filter(item => item.referrer !== referrer), { referrer, seenAt: now }]
    .sort((a, b) => b.seenAt - a.seenAt)
    .slice(0, MAX_OBSERVATIONS);
  await env.REFERRAL_ATTRIBUTION.put(
    key,
    JSON.stringify({ observations, expiresAt: now + ATTRIBUTION_TTL_MS } satisfies ReferralRecord),
    { expirationTtl: ATTRIBUTION_TTL_SECONDS },
  );
}

/**
 * Hand out the newest referrer observed for the caller's network, once. The
 * network address is the only signal, so behind a shared egress (office,
 * campus, carrier NAT) every fresh install would otherwise be offered the same
 * inviter and could bind a stranger's usage to them for good. Consuming the
 * observation limits one download link to one candidate; Desktop still asks
 * the user to confirm, and treats the answer as pre-fill, not proof.
 */
export async function matchReferral(
  request: Request,
  env: ReferralAttributionEnv,
  now = Date.now(),
): Promise<Response> {
  const noMatch = jsonResponse({ match: null });
  if (!env.REFERRAL_ATTRIBUTION || !env.REFERRAL_HASH_SECRET) return noMatch;
  const key = await attributionKey(request, env.REFERRAL_HASH_SECRET);
  if (!key) return noMatch;

  const record = parseRecord(await env.REFERRAL_ATTRIBUTION.get(key), now);
  const [latest, ...remaining] = record.observations;
  if (!latest) return noMatch;
  const distinctReferrers = new Set(record.observations.map(item => item.referrer)).size;

  if (remaining.length === 0) {
    await env.REFERRAL_ATTRIBUTION.delete(key);
  } else {
    await env.REFERRAL_ATTRIBUTION.put(
      key,
      JSON.stringify({ observations: remaining, expiresAt: record.expiresAt } satisfies ReferralRecord),
      { expirationTtl: Math.max(60, Math.ceil((record.expiresAt - now) / 1000)) },
    );
  }
  return jsonResponse({
    match: {
      referrer: latest.referrer,
      confidence: distinctReferrers === 1 ? 'probable' : 'low',
      matchedBy: 'network',
      expiresAt: record.expiresAt,
    },
  });
}
