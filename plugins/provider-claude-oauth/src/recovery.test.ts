import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ModelHealthChecker, type Provider } from '@antseed/node';
import plugin from './index.js';
import { CredentialStore } from './credential-store.js';

let directory: string;
let path: string;
let fetchMock: ReturnType<typeof vi.fn>;
const fresh = () => ({ accessToken: 'new-access', refreshToken: 'new-refresh', expiresAt: Date.now() + 3600_000 });
const config = () => ({
  CLAUDE_AUTH_FILE: path,
  CLAUDE_ACCESS_TOKEN: 'old-access',
  CLAUDE_REFRESH_TOKEN: 'old-refresh',
  CLAUDE_TOKEN_EXPIRES_AT: String(Date.now() - 1000),
  ANTSEED_ALLOWED_SERVICES: 'model-a,model-b',
});

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'oauth-test-'));
  path = join(directory, 'credentials.json');
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  rmSync(directory, { recursive: true, force: true });
});

describe('development OAuth persistence and recovery', () => {
  it('persists rotation privately and uses it after restart instead of stale env', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({
      access_token: 'new-access', refresh_token: 'new-refresh', expires_in: 3600,
    })));
    const provider = plugin.createProvider(config());
    await provider.init?.();
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ accessToken: 'new-access', refreshToken: 'new-refresh' });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    await plugin.createProvider(config()).init?.();
    await plugin.createProvider({ CLAUDE_AUTH_FILE: path }).init?.();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not overwrite invalid stored credentials or expose their contents', () => {
    const secret = '{"accessToken":"DO-NOT-LOG-THIS';
    writeFileSync(path, secret);
    expect(() => plugin.createProvider(config())).toThrow('Invalid Claude OAuth credential file');
    expect(readFileSync(path, 'utf8')).toBe(secret);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not silently bootstrap on filesystem/configuration failures', () => {
    expect(() => plugin.createProvider({ CLAUDE_AUTH_FILE: path })).toThrow('required to initialize');
    expect(() => plugin.createProvider({ ...config(), CLAUDE_AUTH_FILE: directory })).toThrow();
  });

  it('keeps failed services hidden, continues other providers, and restores every model after repair', async () => {
    fetchMock.mockResolvedValue(new Response('sensitive-upstream-body', { status: 401 }));
    const provider: Provider = plugin.createProvider(config());
    await expect(provider.init?.()).rejects.toMatchObject({ code: 'ANTSEED_OAUTH_REFRESH_FAILED' });
    provider.healthCheckAvailable = false;
    const other: Provider = {
      name: 'other', services: ['working'], pricing: { defaults: { inputUsdPerMillion: 0, outputUsdPerMillion: 0 } },
      maxConcurrency: 5, getCapacity: () => ({ current: 0, max: 5 }),
      handleRequest: vi.fn(async (req) => ({ requestId: req.requestId, statusCode: 200, headers: {}, body: new Uint8Array() })),
    };
    const checker = new ModelHealthChecker({ targets: [{ provider }, { provider: other }] });
    expect(provider.services).toEqual([]);
    await checker.runSweep();
    expect(provider.healthCheckAvailable).toBe(false);
    expect(other.handleRequest).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1); // refresh backoff applies across model probes
    new CredentialStore(path).save(fresh());
    fetchMock.mockImplementation(async () => new Response(JSON.stringify({ content: [{ type: 'text', text: 'OK' }] })));
    await checker.runSweep();
    expect(provider.healthCheckAvailable).toBe(true);
    expect(provider.services).toEqual(['model-a', 'model-b']);
    expect(checker.getSnapshot().every((s) => s.advertised)).toBe(true);
    expect(other.handleRequest).toHaveBeenCalledTimes(2);
    checker.stop();
  });

  it('refreshes on 401 even with a future expiry and saves the replacement', async () => {
    new CredentialStore(path).initialize(fresh());
    fetchMock.mockResolvedValueOnce(new Response('expired', { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ access_token: 'rotated', refresh_token: 'rotated-refresh', expires_in: 3600 })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ content: [{ type: 'text', text: 'OK' }] })));
    const provider = plugin.createProvider({ CLAUDE_AUTH_FILE: path, ANTSEED_ALLOWED_SERVICES: 'model-a' });
    const response = await provider.handleRequest({ requestId: 'test', method: 'POST', path: '/v1/messages', headers: {},
      body: new TextEncoder().encode(JSON.stringify({ model: 'model-a', messages: [], max_tokens: 1 })) });
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ accessToken: 'rotated', refreshToken: 'rotated-refresh' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
