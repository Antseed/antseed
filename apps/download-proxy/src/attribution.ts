/**
 * Install attribution tokens.
 *
 * The website appends the visitor's GA ids to download links (?cid=&sid=),
 * which is how the proxy's download_started/completed events land inside the
 * visitor's GA4 session. That join ends at the installer: nothing carried the
 * ids into the app, so app_first_opened and everything after it reached GA4
 * under an unrelated client id and could never be attributed to a campaign.
 *
 * This module closes the gap without storing anything. The ids are encoded
 * into a short, HMAC-signed token that is stamped into the installer's
 * filename (`AntSeed-VPR-Setup-0.2.38.a-<token>.exe`). The installer and the
 * app read their own filename, send the token back to the proxy with each
 * milestone (see app-events.ts), and the proxy forwards the milestone to GA4
 * under the original client id and session id. The token is a proof of
 * origin, not a secret: anyone holding it can only attribute events to the
 * download session it came from, and the signature stops forged ids.
 *
 * Token shape: `1.<payload>.<sig>` — version, base64url of
 * `<client_id>|<session_id>|<issued_at_seconds>|<ref>` (ref is the optional
 * affiliate code from the download URL and may be empty), and the first 16
 * bytes of HMAC-SHA256(secret, payload) as base64url. Only [A-Za-z0-9._-] appear, so
 * the token is safe in filenames on every platform and in URL query strings
 * without encoding.
 */

import type {GaIds} from './events';

export const INSTALL_TOKEN_VERSION = '1';
/** Tokens older than this are ignored; matches GA4's default 30-day attribution lookback. */
export const INSTALL_TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SIGNATURE_BYTES = 16;

const TOKEN_RE = /^1\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]{22})$/;
const FILENAME_STAMP_RE = /\.a-(1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22})\.[A-Za-z0-9]+$/;

export interface InstallAttribution {
  clientId: string;
  sessionId: string | null;
  issuedAtMs: number;
  /** Affiliate / referral code carried from the download URL, if any. */
  ref: string | null;
}

function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text: string): Uint8Array | null {
  try {
    const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, char => char.charCodeAt(0));
  } catch {
    return null;
  }
}

async function sign(payload: string, secret: string): Promise<string> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    {name: 'HMAC', hash: 'SHA-256'},
    false,
    ['sign'],
  );
  const digest = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  return toBase64Url(new Uint8Array(digest).slice(0, SIGNATURE_BYTES));
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * Mint a token for a download, or null when the visitor had no GA client id
 * (blocked GA, direct link) — there is nothing to attribute to.
 */
export async function mintInstallToken(
  ids: GaIds,
  secret: string,
  nowMs: number = Date.now(),
  ref: string | null = null,
): Promise<string | null> {
  if (!ids.clientId || !secret) return null;
  const payload = `${ids.clientId}|${ids.sessionId ?? ''}|${Math.floor(nowMs / 1000)}|${ref ?? ''}`;
  const encoded = toBase64Url(new TextEncoder().encode(payload));
  return `${INSTALL_TOKEN_VERSION}.${encoded}.${await sign(payload, secret)}`;
}

/** Verify a token's signature and age; null for anything malformed, forged, or stale. */
export async function verifyInstallToken(
  token: string,
  secret: string,
  nowMs: number = Date.now(),
): Promise<InstallAttribution | null> {
  if (!secret) return null;
  const match = TOKEN_RE.exec(token);
  if (!match) return null;
  const payloadBytes = fromBase64Url(match[1]!);
  if (!payloadBytes) return null;
  const payload = new TextDecoder().decode(payloadBytes);
  if (!timingSafeEqual(await sign(payload, secret), match[2]!)) return null;
  const parts = payload.split('|');
  if (parts.length !== 3 && parts.length !== 4) return null;
  const [clientId, sessionId, issuedAt] = parts as [string, string, string];
  const ref = parts[3] ?? '';
  if (!/^\d{5,15}\.\d{5,15}$/.test(clientId)) return null;
  if (sessionId && !/^\d{8,12}$/.test(sessionId)) return null;
  if (!/^\d{9,11}$/.test(issuedAt)) return null;
  if (ref && !/^[A-Za-z0-9_-]{1,32}$/.test(ref)) return null;
  const issuedAtMs = Number(issuedAt) * 1000;
  if (issuedAtMs > nowMs + 60_000 || nowMs - issuedAtMs > INSTALL_TOKEN_MAX_AGE_MS) return null;
  return {clientId, sessionId: sessionId || null, issuedAtMs, ref: ref || null};
}

/** `AntSeed-VPR-Setup-0.2.38.exe` + token → `AntSeed-VPR-Setup-0.2.38.a-<token>.exe`. */
export function stampAssetName(assetName: string, token: string): string {
  const dot = assetName.lastIndexOf('.');
  if (dot <= 0) return `${assetName}.a-${token}`;
  return `${assetName.slice(0, dot)}.a-${token}${assetName.slice(dot)}`;
}

/** The token embedded in a stamped filename, or null. Mirrored in the desktop app. */
export function installTokenFromFilename(filename: string): string | null {
  const match = FILENAME_STAMP_RE.exec(filename.trim());
  return match ? match[1]! : null;
}
