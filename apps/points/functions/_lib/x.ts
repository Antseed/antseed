// X (Twitter) OAuth 2.0 with PKCE. We only read the signed-in user's id,
// handle, name and avatar (scope users.read tweet.read); nothing is posted.
import type { XIdentity } from './session';

export const X_AUTHORIZE = 'https://x.com/i/oauth2/authorize';
export const X_TOKEN = 'https://api.x.com/2/oauth2/token';
export const X_ME = 'https://api.x.com/2/users/me?user.fields=profile_image_url,name,username';
export const X_SCOPES = 'users.read tweet.read';

export function authorizeUrl(p: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const u = new URL(X_AUTHORIZE);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', p.clientId);
  u.searchParams.set('redirect_uri', p.redirectUri);
  u.searchParams.set('scope', X_SCOPES);
  u.searchParams.set('state', p.state);
  u.searchParams.set('code_challenge', p.challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

export async function exchangeCode(p: { clientId: string; clientSecret?: string; code: string; redirectUri: string; verifier: string }): Promise<string> {
  const body = new URLSearchParams({ grant_type: 'authorization_code', code: p.code, redirect_uri: p.redirectUri, code_verifier: p.verifier, client_id: p.clientId });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  // Confidential clients authenticate with Basic auth; public clients send client_id only.
  if (p.clientSecret) headers.authorization = `Basic ${btoa(`${p.clientId}:${p.clientSecret}`)}`;
  const res = await fetch(X_TOKEN, { method: 'POST', headers, body });
  if (!res.ok) throw new Error(`X token exchange failed (${res.status})`);
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) throw new Error('X returned no access token');
  return data.access_token;
}

export async function fetchMe(accessToken: string): Promise<XIdentity> {
  const res = await fetch(X_ME, { headers: { authorization: `Bearer ${accessToken}` } });
  if (!res.ok) throw new Error(`X profile lookup failed (${res.status})`);
  const { data } = (await res.json()) as { data?: { id: string; username: string; name: string; profile_image_url?: string } };
  if (!data) throw new Error('X returned no profile');
  return {
    xId: data.id,
    handle: data.username,
    name: data.name,
    // X serves 48px "_normal" avatars by default; ask for the 400px version.
    avatar: (data.profile_image_url || '').replace('_normal.', '_400x400.'),
  };
}
