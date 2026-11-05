import {describe, expect, it} from 'vitest';
import {
  MATCH_WINDOW_SECONDS,
  appPlatformToProxy,
  hashIp,
  matchInstall,
  parseRef,
  recordDownload,
  type AttributionStore,
} from './match';

const SECRET = 'test-secret';
const NOW = 1_757_500_000_000;
const ids = {clientId: '1234567890.1234567890', sessionId: '1757499000'};
const INSTALL = '9b2f4c1e-7a3d-4e5f-8a9b-0c1d2e3f4a5b';

function memoryStore(): AttributionStore & {data: Map<string, string>} {
  const data = new Map<string, string>();
  return {
    data,
    async get(key) {
      return data.get(key) ?? null;
    },
    async put(key, value) {
      data.set(key, value);
    },
    async list({prefix}) {
      return {keys: [...data.keys()].filter(k => k.startsWith(prefix)).map(name => ({name}))};
    },
    async delete(key) {
      data.delete(key);
    },
  };
}

describe('helpers', () => {
  it('maps desktop platforms to proxy platforms', () => {
    expect(appPlatformToProxy('win32')).toBe('win');
    expect(appPlatformToProxy('darwin')).toBe('mac');
    expect(appPlatformToProxy('linux')).toBe('linux');
    expect(appPlatformToProxy('mac')).toBe('mac');
    expect(appPlatformToProxy('ios')).toBeNull();
    expect(appPlatformToProxy(undefined)).toBeNull();
  });

  it('accepts only well-shaped ref codes', () => {
    expect(parseRef('partner_42')).toBe('partner_42');
    expect(parseRef('bad code!')).toBeNull();
    expect(parseRef('x'.repeat(33))).toBeNull();
    expect(parseRef(null)).toBeNull();
  });

  it('hashes IPs with the secret and never stores the raw address', async () => {
    const a = await hashIp('203.0.113.7', SECRET);
    expect(a).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(await hashIp('203.0.113.7', 'other')).not.toBe(a);
    const store = memoryStore();
    await recordDownload(store, SECRET, {ip: '203.0.113.7', platform: 'mac', arch: 'arm64', ids, ref: null, nowMs: NOW});
    expect([...store.data.keys()].join()).not.toContain('203.0.113.7');
  });
});

describe('matchInstall', () => {
  it('matches the single download from the same platform and IP within the window', async () => {
    const store = memoryStore();
    await recordDownload(store, SECRET, {ip: '203.0.113.7', platform: 'mac', arch: 'arm64', ids, ref: 'partner_42', nowMs: NOW});
    const matched = await matchInstall(store, SECRET, {ip: '203.0.113.7', platform: 'mac', arch: 'arm64', installId: INSTALL, nowMs: NOW + 600_000});
    expect(matched).toEqual({clientId: ids.clientId, sessionId: ids.sessionId, ref: 'partner_42'});
    // consumed: a second install from the same IP cannot claim it
    expect(await matchInstall(store, SECRET, {ip: '203.0.113.7', platform: 'mac', arch: 'arm64', installId: 'other', nowMs: NOW + 700_000})).toBeNull();
    // but the matched install is remembered
    expect(await matchInstall(store, SECRET, {ip: '198.51.100.9', platform: 'mac', arch: 'arm64', installId: INSTALL, nowMs: NOW + 86_400_000})).toEqual({clientId: ids.clientId, sessionId: ids.sessionId, ref: 'partner_42'});
  });

  it('refuses ambiguous matches unless arch breaks the tie', async () => {
    const store = memoryStore();
    const other = {clientId: '9999999999.9999999999', sessionId: null};
    await recordDownload(store, SECRET, {ip: '203.0.113.7', platform: 'win', arch: 'x64', ids, ref: null, nowMs: NOW});
    await recordDownload(store, SECRET, {ip: '203.0.113.7', platform: 'win', arch: 'x64', ids: other, ref: null, nowMs: NOW + 1_000});
    expect(await matchInstall(store, SECRET, {ip: '203.0.113.7', platform: 'win', arch: 'x64', installId: INSTALL, nowMs: NOW + 5_000})).toBeNull();
    await recordDownload(store, SECRET, {ip: '203.0.113.8', platform: 'mac', arch: 'arm64', ids, ref: null, nowMs: NOW});
    await recordDownload(store, SECRET, {ip: '203.0.113.8', platform: 'mac', arch: 'x64', ids: other, ref: null, nowMs: NOW + 1_000});
    expect((await matchInstall(store, SECRET, {ip: '203.0.113.8', platform: 'mac', arch: 'x64', installId: INSTALL, nowMs: NOW + 5_000}))?.clientId).toBe(other.clientId);
  });

  it('does not match across platforms, IPs, the window, or without an IP', async () => {
    const store = memoryStore();
    await recordDownload(store, SECRET, {ip: '203.0.113.7', platform: 'mac', arch: 'arm64', ids, ref: null, nowMs: NOW});
    expect(await matchInstall(store, SECRET, {ip: '203.0.113.7', platform: 'win', arch: 'x64', installId: INSTALL, nowMs: NOW + 1_000})).toBeNull();
    expect(await matchInstall(store, SECRET, {ip: '203.0.113.9', platform: 'mac', arch: 'arm64', installId: INSTALL, nowMs: NOW + 1_000})).toBeNull();
    expect(await matchInstall(store, SECRET, {ip: '203.0.113.7', platform: 'mac', arch: 'arm64', installId: INSTALL, nowMs: NOW + MATCH_WINDOW_SECONDS * 1000 + 1})).toBeNull();
    expect(await matchInstall(store, SECRET, {ip: null, platform: 'mac', arch: 'arm64', installId: INSTALL, nowMs: NOW + 1_000})).toBeNull();
  });

  it('records nothing for unattributed downloads', async () => {
    const store = memoryStore();
    await recordDownload(store, SECRET, {ip: '203.0.113.7', platform: 'mac', arch: 'arm64', ids: {clientId: null, sessionId: null}, ref: null, nowMs: NOW});
    expect(store.data.size).toBe(0);
  });
});
