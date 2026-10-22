// Signed cookies (HMAC-SHA256 over a base64url JSON payload). No server-side
// session table: the cookie carries the X identity, and its signature proves
// this server issued it.

export interface XIdentity {
  xId: string;
  handle: string;
  name: string;
  avatar: string;
}

export interface Session extends XIdentity {
  exp: number; // unix seconds
}

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(pad);
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64url(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data))));
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function sign(payload: object, secret: string): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  return `${body}.${await hmac(secret, body)}`;
}

export async function verify<T extends { exp: number }>(token: string | null | undefined, secret: string, nowSec = Math.floor(Date.now() / 1000)): Promise<T | null> {
  if (!token || !secret) return null;
  const [body, mac] = token.split('.');
  if (!body || !mac) return null;
  if (!safeEqual(mac, await hmac(secret, body))) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body))) as T;
    return typeof payload.exp === 'number' && payload.exp > nowSec ? payload : null;
  } catch {
    return null;
  }
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('cookie') || '';
  for (const part of header.split(/;\s*/)) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i) === name) return decodeURIComponent(part.slice(i + 1));
  }
  return null;
}

export function cookie(name: string, value: string, maxAgeSec: number): string {
  return `${name}=${encodeURIComponent(value)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAgeSec}`;
}

export const SESSION_COOKIE = 'ap_session';
export const OAUTH_COOKIE = 'ap_oauth';
export const SESSION_DAYS = 30;

export async function sessionFrom(request: Request, secret: string): Promise<Session | null> {
  return verify<Session>(readCookie(request, SESSION_COOKIE), secret);
}

export async function sessionCookie(id: XIdentity, secret: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400;
  return cookie(SESSION_COOKIE, await sign({ ...id, exp }, secret), SESSION_DAYS * 86400);
}

/** PKCE helpers for X OAuth 2.0. */
export function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(verifier))));
}
