/**
 * Server-side install matching — the fallback for installs the filename
 * stamp cannot reach (macOS: the .dmg name does not survive the drag to
 * /Applications; any platform when the file was renamed).
 *
 * At download_completed the proxy stores a short-lived record keyed by
 * platform and a keyed hash of the client IP: the GA ids, the arch, and an
 * optional affiliate code. When the app later reports a milestone without a
 * token, the proxy looks for records under the same platform and IP hash
 * within the window and accepts the match only when exactly one download
 * fits (arch breaks ties). A matched install is remembered by its install
 * id so later milestones reuse the ids without re-matching, and the download
 * record is consumed so two installs can never claim the same download.
 *
 * This is probabilistic by nature — shared IPs (carrier-grade NAT, campus
 * and office networks, Apple Private Relay) produce either no match or an
 * ambiguous one, and ambiguity is treated as no match. Every forwarded event
 * says how it was attributed (`attribution_method`: token, match, none) so
 * reports and affiliate payouts can weight the two differently.
 *
 * Privacy: the IP is never stored, only an HMAC of it under the attribution
 * secret, and records expire after 48 hours.
 */

import type {GaIds} from './events';

export const MATCH_WINDOW_SECONDS = 48 * 60 * 60;
export const INSTALL_MEMORY_SECONDS = 90 * 24 * 60 * 60;
const REF_RE = /^[A-Za-z0-9_-]{1,32}$/;

/** The subset of Workers KV the matcher uses; tests provide an in-memory one. */
export interface AttributionStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: {expirationTtl?: number}): Promise<void>;
  list(options: {prefix: string}): Promise<{keys: Array<{name: string}>}>;
  delete(key: string): Promise<void>;
}

export type ProxyPlatform = 'win' | 'mac' | 'linux';

export interface DownloadRecord {
  clientId: string;
  sessionId: string | null;
  arch: string;
  ref: string | null;
  t: number;
}

export interface MatchedInstall {
  clientId: string;
  sessionId: string | null;
  ref: string | null;
}

/** Affiliate / referral code from the download URL (?ref=...), strictly shaped. */
export function parseRef(value: string | null): string | null {
  return value && REF_RE.test(value) ? value : null;
}

/** Desktop telemetry platforms (win32, darwin, linux) or the proxy's own names. */
export function appPlatformToProxy(platform: unknown): ProxyPlatform | null {
  switch (typeof platform === 'string' ? platform.toLowerCase() : '') {
    case 'win32':
    case 'win':
      return 'win';
    case 'darwin':
    case 'mac':
      return 'mac';
    case 'linux':
      return 'linux';
    default:
      return null;
  }
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** Keyed hash of the client IP: stable for 48 h of matching, useless without the secret. */
export async function hashIp(ip: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), {name: 'HMAC', hash: 'SHA-256'}, false, ['sign']);
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(ip.trim()));
  return toBase64Url(new Uint8Array(digest).slice(0, 16));
}

function downloadPrefix(platform: ProxyPlatform, ipHash: string): string {
  return `dl:${platform}:${ipHash}:`;
}

/** Store a completed, attributed download for later matching. */
export async function recordDownload(
  store: AttributionStore,
  secret: string,
  input: {ip: string | null; platform: ProxyPlatform; arch: string; ids: GaIds; ref: string | null; nowMs?: number},
): Promise<void> {
  if (!input.ip || !input.ids.clientId) return;
  const t = input.nowMs ?? Date.now();
  const record: DownloadRecord = {clientId: input.ids.clientId, sessionId: input.ids.sessionId, arch: input.arch, ref: input.ref, t};
  const key = `${downloadPrefix(input.platform, await hashIp(input.ip, secret))}${t}`;
  await store.put(key, JSON.stringify(record), {expirationTtl: MATCH_WINDOW_SECONDS});
}

/**
 * Find the one download this install came from, or null. A previously
 * matched install id short-circuits to its remembered ids.
 */
export async function matchInstall(
  store: AttributionStore,
  secret: string,
  input: {ip: string | null; platform: ProxyPlatform | null; arch: string | null; installId: string | null; nowMs?: number},
): Promise<MatchedInstall | null> {
  const nowMs = input.nowMs ?? Date.now();
  if (input.installId) {
    const remembered = await store.get(`inst:${input.installId}`);
    if (remembered) {
      try {
        return JSON.parse(remembered) as MatchedInstall;
      } catch {
        // fall through to a fresh match
      }
    }
  }
  if (!input.ip || !input.platform) return null;

  const prefix = downloadPrefix(input.platform, await hashIp(input.ip, secret));
  const listed = await store.list({prefix});
  const candidates: Array<{key: string; record: DownloadRecord}> = [];
  for (const {name} of listed.keys) {
    const raw = await store.get(name);
    if (!raw) continue;
    try {
      const record = JSON.parse(raw) as DownloadRecord;
      if (record.t <= nowMs && nowMs - record.t <= MATCH_WINDOW_SECONDS * 1000) candidates.push({key: name, record});
    } catch {
      // ignore malformed
    }
  }
  let chosen = candidates.length === 1 ? candidates[0]! : null;
  if (!chosen && candidates.length > 1 && input.arch) {
    const sameArch = candidates.filter(c => c.record.arch === input.arch);
    if (sameArch.length === 1) chosen = sameArch[0]!;
  }
  if (!chosen) return null;

  const matched: MatchedInstall = {clientId: chosen.record.clientId, sessionId: chosen.record.sessionId, ref: chosen.record.ref};
  // Consume the download so no second install can claim it, and remember
  // the install so its later milestones do not depend on the window.
  await store.delete(chosen.key);
  if (input.installId) {
    await store.put(`inst:${input.installId}`, JSON.stringify(matched), {expirationTtl: INSTALL_MEMORY_SECONDS});
  }
  return matched;
}
