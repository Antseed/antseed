import { describe, expect, it } from 'vitest';
import { createZedKeyReads, loadZedKey, readZedKeyToCopy, zedKeyFingerprint } from './zed-key-paste';

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

describe('createZedKeyReads', () => {
  it('copies the key the console holds now, even after it was replaced while the dialog stayed open', async () => {
    let gatewayKey = 'sk-old';
    const shown: Array<string | null> = [];
    const reads = createZedKeyReads(
      () => loadZedKey(async () => ({ ok: true, origin: 'https://gw.example', apiKey: gatewayKey })),
      (read) => shown.push(read && 'apiKey' in read ? read.apiKey : null),
    );
    await reads.refresh();
    expect(shown.at(-1)).toBe('sk-old');
    // Replaced in the console; the dialog never closed.
    gatewayKey = 'sk-new';
    expect(await readZedKeyToCopy(reads)).toBe('sk-new');
    expect(shown.at(-1)).toBe('sk-new');
  });

  it('copies nothing and shows no old key when the re-read fails', async () => {
    let fail = false;
    const shown: Array<string | null> = [];
    const reads = createZedKeyReads(
      () => loadZedKey(async () => (fail ? { ok: false, error: 'Key revoked' } : { ok: true, origin: 'https://gw.example', apiKey: 'sk-old' })),
      (read) => shown.push(read && 'apiKey' in read ? read.apiKey : null),
    );
    await reads.refresh();
    fail = true;
    expect(await readZedKeyToCopy(reads)).toBeNull();
    expect(shown.at(-1)).toBeNull();
  });

  it('drops an answer a newer read overtook', async () => {
    const answers: Array<(key: string) => void> = [];
    const shown: Array<string | null> = [];
    const reads = createZedKeyReads(
      () => new Promise((resolve) => { answers.push((apiKey) => resolve({ apiKey, fingerprint: apiKey })); }),
      (read) => shown.push(read && 'apiKey' in read ? read.apiKey : null),
    );
    const first = reads.refresh();
    const second = reads.refresh();
    answers[1]!('sk-new');
    answers[0]!('sk-old');
    expect(await first).toBeNull();
    expect(await second).toEqual({ apiKey: 'sk-new', fingerprint: 'sk-new' });
    expect(shown.at(-1)).toBe('sk-new');
  });
});
