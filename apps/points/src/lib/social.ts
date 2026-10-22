// Optional X sign-in and public profiles, served by the Pages Functions in
// ../../functions. Everything here degrades quietly: if the API isn't there
// (plain `vite` dev server) the site simply shows wallets without names.
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { linkMessage } from '../../functions/_lib/message';

export interface Me {
  signedIn: boolean;
  /** False when X sign-in isn't configured on this deployment, so the button stays hidden. */
  xEnabled: boolean;
  xId?: string;
  handle?: string;
  name?: string;
  avatar?: string;
  addresses?: string[];
}

export interface PublicProfile {
  handle: string;
  name: string;
  avatar: string;
}

export interface ProfileRecord extends PublicProfile {
  addresses: string[];
}

const SIGNED_OUT: Me = { signedIn: false, xEnabled: false };

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, { credentials: 'same-origin', ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const body = isJson ? await res.json() : null;
  if (!res.ok || !isJson) throw Object.assign(new Error((body as { error?: string } | null)?.error || `Request failed (${res.status})`), { status: res.status });
  return body as T;
}

export const signInHref = (returnTo = window.location.pathname + window.location.search) =>
  `/api/auth/x/start?return=${encodeURIComponent(returnTo)}`;

export function useMe() {
  return useQuery({
    queryKey: ['me'],
    queryFn: () => api<Me>('/api/me').catch(() => SIGNED_OUT),
    staleTime: 60_000,
  });
}

export function useSignOut() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api('/api/logout', { method: 'POST' }),
    onSettled: () => {
      qc.setQueryData(['me'], (m: Me | undefined) => ({ ...(m ?? SIGNED_OUT), signedIn: false, addresses: [] }));
      qc.invalidateQueries({ queryKey: ['profiles'] });
    },
  });
}

/** X names for a set of wallets, for the leaderboard. Missing wallets simply aren't in the map. */
export function useProfiles(addresses: string[]) {
  const key = Array.from(new Set(addresses.map((a) => a.toLowerCase()))).sort();
  return useQuery({
    queryKey: ['profiles', key.join(',')],
    queryFn: () => api<Record<string, PublicProfile>>(`/api/profiles?a=${key.slice(0, 100).join(',')}`).catch(() => ({}) as Record<string, PublicProfile>),
    enabled: key.length > 0,
    staleTime: 60_000,
  });
}

export function useProfile(handle: string) {
  return useQuery({
    queryKey: ['profile', handle.toLowerCase()],
    queryFn: () => api<ProfileRecord>(`/api/profile/${encodeURIComponent(handle)}`),
    retry: (n, e) => (e as { status?: number }).status !== 404 && n < 2,
    staleTime: 60_000,
  });
}

/**
 * Link a wallet to the signed-in X account. The signer is the wallet itself or
 * its reward wallet (the Deposits operator); the API checks which on-chain.
 */
export function useLinkWallet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ me, address, sign }: { me: Me; address: string; sign: (message: string) => Promise<string> }) => {
      if (!me.signedIn || !me.handle || !me.xId) throw new Error('Sign in with X first.');
      const issuedAt = new Date().toISOString();
      const signature = await sign(linkMessage({ handle: me.handle, xId: me.xId, address, issuedAt }));
      return api<{ ok: true }>('/api/link', { method: 'POST', body: JSON.stringify({ address, issuedAt, signature }) });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['me'] });
      qc.invalidateQueries({ queryKey: ['profiles'] });
      qc.invalidateQueries({ queryKey: ['profile'] });
    },
  });
}

export function useUnlinkWallet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (address: string) => api('/api/link', { method: 'DELETE', body: JSON.stringify({ address }) }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['me'] });
      qc.invalidateQueries({ queryKey: ['profiles'] });
      qc.invalidateQueries({ queryKey: ['profile'] });
    },
  });
}

export const profileHref = (handle: string) => `/u/${encodeURIComponent(handle)}`;
