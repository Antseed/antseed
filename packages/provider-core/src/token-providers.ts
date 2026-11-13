import type { TokenProvider, TokenProviderState } from '@antseed/node';

export type { TokenProvider, TokenProviderState };

const REFRESH_BUFFER_MS = 5 * 60 * 1000; // refresh 5 min before expiry
const DEFAULT_REFRESH_TIMEOUT_MS = 15_000;
const DEFAULT_OAUTH_TOKEN_ENDPOINT = 'https://console.anthropic.com/v1/oauth/token';

function getRefreshTimeoutMs(): number {
  const raw = process.env['ANTSEED_OAUTH_REFRESH_TIMEOUT_MS'];
  if (!raw) {
    return DEFAULT_REFRESH_TIMEOUT_MS;
  }
  const parsed = Number.parseInt(raw.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_REFRESH_TIMEOUT_MS;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// StaticTokenProvider
// ---------------------------------------------------------------------------

/** Wraps a static API key. No refresh logic. */
export class StaticTokenProvider implements TokenProvider {
  constructor(private readonly token: string) {}
  async getToken(): Promise<string> {
    return this.token;
  }
  stop(): void {}
  getState(): TokenProviderState {
    return { accessToken: this.token };
  }
}

// ---------------------------------------------------------------------------
// OAuthTokenProvider
// ---------------------------------------------------------------------------

export class OAuthRefreshError extends Error {
  readonly code = 'ANTSEED_OAUTH_REFRESH_FAILED';
}

export interface OAuthState {
  accessToken: string;
  refreshToken: string;
  expiresAt: number; // epoch ms
}

export interface OAuthStateStore {
  load(): OAuthState;
  save(state: OAuthState): void;
}

type RefreshRequestEncoding = 'form' | 'json';

/**
 * Manages an OAuth access/refresh token pair.
 * Transparently refreshes the access token when it nears expiry.
 */
export class OAuthTokenProvider implements TokenProvider {
  private state: OAuthState;
  private refreshPromise: Promise<string> | null = null;
  private readonly tokenEndpoint: string;
  private readonly requestEncoding: RefreshRequestEncoding;
  private readonly clientId: string | undefined;
  private readonly stateStore: OAuthStateStore | undefined;
  private hasUnsavedCredentials = false;
  private failures = 0;
  private retryAt = 0;

  constructor(opts: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
    tokenEndpoint?: string;
    requestEncoding?: RefreshRequestEncoding;
    clientId?: string;
    stateStore?: OAuthStateStore;
  }) {
    this.state = {
      accessToken: opts.accessToken,
      refreshToken: opts.refreshToken,
      expiresAt: opts.expiresAt,
    };
    this.tokenEndpoint = opts.tokenEndpoint ?? DEFAULT_OAUTH_TOKEN_ENDPOINT;
    this.requestEncoding = opts.requestEncoding ?? 'form';
    this.clientId = opts.clientId;
    this.stateStore = opts.stateStore;
  }

  async getToken(): Promise<string> {
    return this.getOrRefresh(false);
  }

  async forceRefresh(): Promise<string> {
    return this.getOrRefresh(true);
  }

  private async getOrRefresh(force: boolean): Promise<string> {
    if (this.refreshPromise) return this.refreshPromise;
    // Persist an already-rotated token before trying another refresh. Never
    // reload stale disk state after a failed save.
    if (this.hasUnsavedCredentials) this.persist();
    if (this.stateStore) {
      const saved = this.stateStore.load();
      if (saved.accessToken !== this.state.accessToken || saved.refreshToken !== this.state.refreshToken
        || saved.expiresAt !== this.state.expiresAt) {
        this.state = saved;
        this.failures = 0;
        this.retryAt = 0;
      }
    }
    if (!force && !this.isExpiringSoon()) return this.state.accessToken;
    if (Date.now() < this.retryAt) {
      throw new OAuthRefreshError('OAuth refresh temporarily unavailable; retry is deferred');
    }
    this.refreshPromise = this.refreshWithBackoff().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async refreshWithBackoff(): Promise<string> {
    try {
      const token = await this.refresh();
      this.failures = 0;
      this.retryAt = 0;
      return token;
    } catch (err) {
      if (err instanceof OAuthRefreshError) {
        this.failures = Math.min(this.failures + 1, 7);
        const delayMs = Math.min(1000 * 2 ** (this.failures - 1), 60_000);
        this.retryAt = Date.now() + delayMs;
      }
      throw err;
    }
  }

  private persist(): void {
    if (!this.stateStore) return;
    try {
      this.stateStore.save({ ...this.state });
      this.hasUnsavedCredentials = false;
    } catch {
      throw new OAuthRefreshError('OAuth credential persistence failed; check credential file permissions and storage');
    }
  }

  stop(): void {}

  /** Expose current state for persistence. */
  getState(): TokenProviderState {
    return { ...this.state };
  }

  private isExpiringSoon(): boolean {
    return Date.now() >= this.state.expiresAt - REFRESH_BUFFER_MS;
  }

  private async refresh(): Promise<string> {
    const payload: Record<string, string> = {
      grant_type: 'refresh_token',
      refresh_token: this.state.refreshToken,
    };
    if (this.clientId) {
      payload['client_id'] = this.clientId;
    }

    const headers =
      this.requestEncoding === 'json'
        ? { 'Content-Type': 'application/json' }
        : { 'Content-Type': 'application/x-www-form-urlencoded' };
    const body =
      this.requestEncoding === 'json'
        ? JSON.stringify(payload)
        : new URLSearchParams(payload).toString();

    const timeoutMs = getRefreshTimeoutMs();
    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(this.tokenEndpoint, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      });

      if (!res.ok) {
        await res.body?.cancel();
        // Upstream response bodies may echo credentials. Never log them.
        throw new OAuthRefreshError(`OAuth refresh failed (${res.status})`);
      }

      const data = (await res.json()) as {
        access_token?: string;
        accessToken?: string;
        refresh_token?: string;
        refreshToken?: string;
        expires_in?: number;
        expires_at?: number;
        expiresAt?: number;
      };

      const accessToken = data.access_token ?? data.accessToken;
      const refreshToken = data.refresh_token ?? data.refreshToken ?? this.state.refreshToken;
      const expiresAt = data.expires_at ?? data.expiresAt
        ?? (data.expires_in !== undefined ? Date.now() + data.expires_in * 1000 : this.state.expiresAt);
      if (typeof accessToken !== 'string' || !accessToken) {
        throw new OAuthRefreshError('OAuth refresh response missing access token');
      }
      if (typeof refreshToken !== 'string' || !refreshToken
        || typeof expiresAt !== 'number' || !Number.isFinite(expiresAt) || expiresAt <= 0) {
        throw new OAuthRefreshError('OAuth refresh response contains invalid credential fields');
      }

      this.state = { accessToken, refreshToken, expiresAt };
      this.hasUnsavedCredentials = this.stateStore !== undefined;
      this.persist();
      return this.state.accessToken;
    } catch (err) {
      if (err instanceof OAuthRefreshError) throw err;
      if (err instanceof Error && err.name === 'AbortError') {
        throw new OAuthRefreshError(`OAuth refresh timed out after ${timeoutMs}ms; check network/proxy access`);
      }
      throw new OAuthRefreshError('OAuth refresh request failed or returned an invalid response');
    } finally {
      clearTimeout(timeoutHandle);
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export type AuthType = 'apikey' | 'oauth';

/**
 * Create the appropriate TokenProvider from config values.
 */
export function createTokenProvider(opts: {
  authType?: AuthType;
  authValue: string;
  refreshToken?: string;
  expiresAt?: number;
}): TokenProvider {
  const authType = opts.authType ?? 'apikey';

  switch (authType) {
    case 'oauth':
      if (!opts.refreshToken) {
        // No refresh token — treat as static (works until expiry)
        return new StaticTokenProvider(opts.authValue);
      }
      return new OAuthTokenProvider({
        accessToken: opts.authValue,
        refreshToken: opts.refreshToken,
        expiresAt: opts.expiresAt ?? Date.now() + 3600_000,
      });

    default:
      return new StaticTokenProvider(opts.authValue);
  }
}
