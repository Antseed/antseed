import { describe, expect, it } from 'vitest';
import { zedKeyFingerprint } from './zed-key-paste';

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
