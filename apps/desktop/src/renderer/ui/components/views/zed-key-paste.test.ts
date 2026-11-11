import { describe, expect, it } from 'vitest';
import { loadZedKey, zedKeyFingerprint } from './zed-key-paste';

describe('zedKeyFingerprint', () => {
  it('stays the same for the same gateway and key, and never holds the key', async () => {
    const fingerprint = await zedKeyFingerprint('https://gw.example', 'sk-secret');
    expect(await zedKeyFingerprint('https://gw.example', 'sk-secret')).toBe(fingerprint);
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes with a new key or a new gateway, so the row asks again', async () => {
    const fingerprint = await zedKeyFingerprint('https://gw.example', 'sk-secret');
    expect(await zedKeyFingerprint('https://gw.example', 'sk-other')).not.toBe(fingerprint);
    expect(await zedKeyFingerprint('https://other.example', 'sk-secret')).not.toBe(fingerprint);
  });
});

describe('loadZedKey', () => {
  it('returns the key and its fingerprint', async () => {
    const result = await loadZedKey(async () => ({ ok: true, origin: 'https://gw.example', apiKey: 'sk-secret' }));
    expect(result).toEqual({ apiKey: 'sk-secret', fingerprint: await zedKeyFingerprint('https://gw.example', 'sk-secret') });
  });

  it('reports why when the gateway refuses or the call fails, so no old key is offered', async () => {
    expect(await loadZedKey(async () => ({ ok: false, error: 'Key revoked' }))).toEqual({ error: 'Key revoked' });
    expect(await loadZedKey(async () => { throw new Error('offline'); })).toEqual({ error: 'offline' });
    expect(await loadZedKey(undefined)).toEqual({ error: 'Couldn’t read Zed’s key from the gateway.' });
  });
});
