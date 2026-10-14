import { afterEach, describe, expect, it, vi } from 'vitest';
import { OAuthRefreshError, OAuthTokenProvider, type OAuthState } from './token-providers.js';

const initial = (): OAuthState => ({ accessToken: 'old', refreshToken: 'old-refresh', expiresAt: Date.now() - 1000 });
const response = () => new Response(JSON.stringify({ access_token: 'new', refresh_token: 'new-refresh', expires_in: 3600 }));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('OAuth recovery', () => {
  it('bounds exponential backoff and resets it after recovery', async () => {
    vi.useFakeTimers();
    const fetch = vi.fn(async () => new Response('secret upstream body', { status: 401 }));
    vi.stubGlobal('fetch', fetch);
    const provider = new OAuthTokenProvider(initial());
    for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
      await expect(provider.getToken()).rejects.toThrow('OAuth refresh failed (401)');
      const calls = fetch.mock.calls.length;
      await expect(provider.forceRefresh()).rejects.toThrow('retry is deferred');
      expect(fetch).toHaveBeenCalledTimes(calls);
      await vi.advanceTimersByTimeAsync(delay);
    }
    fetch.mockImplementation(async () => response());
    expect(await provider.getToken()).toBe('new');
    expect(await provider.getToken()).toBe('new');
  });

  it('deduplicates getToken and forceRefresh and persists before resolving', async () => {
    let saved = initial();
    const save = vi.fn((state: OAuthState) => { saved = state; });
    const fetch = vi.fn(async () => response());
    vi.stubGlobal('fetch', fetch);
    const provider = new OAuthTokenProvider({ ...saved, stateStore: { load: () => saved, save } });
    expect(await Promise.all([provider.getToken(), provider.forceRefresh(), provider.getToken()])).toEqual(['new', 'new', 'new']);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
    expect(saved.refreshToken).toBe('new-refresh');
  });

  it('retains rotated credentials after a save failure and retries saving without refreshing again', async () => {
    const saved = initial();
    let writable = false;
    const save = vi.fn((_state: OAuthState) => { if (!writable) throw new Error('disk full'); });
    const fetch = vi.fn(async () => response());
    vi.stubGlobal('fetch', fetch);
    const store = { load: () => saved, save };
    const provider = new OAuthTokenProvider({ ...saved, stateStore: store });
    await expect(provider.getToken()).rejects.toThrow('credential persistence failed');
    await expect(provider.getToken()).rejects.toThrow('credential persistence failed');
    expect(provider.getState().refreshToken).toBe('new-refresh');
    writable = true;
    save.mockImplementation((state: OAuthState) => { Object.assign(saved, state); });
    expect(await provider.getToken()).toBe('new');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(saved.refreshToken).toBe('new-refresh');
  });

  it('times out refresh requests without surfacing credentials', async () => {
    vi.useFakeTimers();
    vi.stubEnv('ANTSEED_OAUTH_REFRESH_TIMEOUT_MS', '20');
    vi.stubGlobal('fetch', vi.fn((_url, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('secret', 'AbortError')));
    })));
    const provider = new OAuthTokenProvider(initial());
    const pending = expect(provider.getToken()).rejects.toThrow('OAuth refresh timed out after 20ms');
    await vi.advanceTimersByTimeAsync(20);
    await pending;
  });

  it('redacts invalid JSON and network errors', async () => {
    for (const implementation of [
      async () => new Response('secret-token-not-json'),
      async () => { throw new Error('secret-token-from-network'); },
    ]) {
      vi.stubGlobal('fetch', vi.fn(implementation));
      await expect(new OAuthTokenProvider(initial()).getToken()).rejects.toEqual(
        new OAuthRefreshError('OAuth refresh request failed or returned an invalid response'),
      );
    }
  });
});
