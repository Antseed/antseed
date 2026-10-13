import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import {
  decryptIdentityKey,
  encryptIdentityKey,
  identityEnvelopeAddress,
  identityPassphraseEnv,
  isIdentityEnvelope,
  resolveIdentityPassphrase,
} from '../src/p2p/identity-envelope.js';
import { FileIdentityStore, identityFromPrivateKeyHex, loadOrCreateIdentity } from '../src/p2p/identity.js';

const FAST = { N: 2 ** 14, r: 8, p: 1 };
const KEY = '11'.repeat(32);
const PW = 'correct horse battery';

const dirsToClean: string[] = [];

async function tmpDir(): Promise<string> {
  const dir = path.join(os.tmpdir(), `antseed-envelope-${randomBytes(8).toString('hex')}`);
  dirsToClean.push(dir);
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

afterEach(async () => {
  for (const dir of dirsToClean) await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  dirsToClean.length = 0;
});

describe('identity envelope', () => {
  it('round-trips a key and keeps the address readable without the passphrase', async () => {
    const envelope = await encryptIdentityKey(KEY, 'correct horse', FAST);
    expect(isIdentityEnvelope(envelope)).toBe(true);
    expect(envelope).not.toContain(KEY);
    expect(identityEnvelopeAddress(envelope)).toBe(identityFromPrivateKeyHex(KEY).wallet.address);
    expect(await decryptIdentityKey(envelope, 'correct horse')).toBe(KEY);
  });

  it('rejects a wrong passphrase', async () => {
    const envelope = await encryptIdentityKey(KEY, 'correct horse', FAST);
    await expect(decryptIdentityKey(envelope, 'wrong horse')).rejects.toThrow(/Wrong passphrase/);
  });

  it('rejects an envelope whose address was swapped', async () => {
    const envelope = JSON.parse(await encryptIdentityKey(KEY, 'pw', FAST)) as Record<string, unknown>;
    envelope.address = identityFromPrivateKeyHex('22'.repeat(32)).wallet.address;
    await expect(decryptIdentityKey(JSON.stringify(envelope), 'pw')).rejects.toThrow(/Wrong passphrase/);
  });

  it('refuses unsupported or damaged envelopes', async () => {
    const envelope = JSON.parse(await encryptIdentityKey(KEY, 'pw', FAST)) as { kdf: { N: number } };
    envelope.kdf.N = 2 ** 30;
    await expect(decryptIdentityKey(JSON.stringify(envelope), 'pw')).rejects.toThrow(/does not support/);
    expect(() => identityEnvelopeAddress('{not json')).toThrow(/damaged/);
    expect(() => identityEnvelopeAddress('null')).toThrow(/damaged/);
  });
});

describe('FileIdentityStore with a passphrase', () => {
  it('writes new keys encrypted (0600) and loads them back', async () => {
    const dir = await tmpDir();
    const store = new FileIdentityStore(dir, { passphrase: PW });
    await store.save(KEY);

    const file = path.join(dir, 'identity.key');
    const raw = await fs.readFile(file, 'utf8');
    expect(raw.startsWith('{')).toBe(true);
    expect(raw).not.toContain(KEY);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(await store.format()).toBe('encrypted');
    expect(await store.load()).toBe(KEY);
    expect(await new FileIdentityStore(dir, { passphrase: null }).address()).toBe(identityFromPrivateKeyHex(KEY).wallet.address);
  });

  it('fails closed without the passphrase, naming the variable, and on a wrong one', async () => {
    const dir = await tmpDir();
    await new FileIdentityStore(dir, { passphrase: PW }).save(KEY);

    await expect(new FileIdentityStore(dir, { passphrase: null }).load()).rejects.toThrow(/encrypted; set ANTSEED_PASSPHRASE/);
    await expect(new FileIdentityStore(dir, { passphrase: 'nope' }).load()).rejects.toThrow(/Cannot unlock identity .*Wrong passphrase/);
    await expect(loadOrCreateIdentity(new FileIdentityStore(dir, { passphrase: null }))).rejects.toThrow(/ANTSEED_PASSPHRASE/);
  });

  it('reads plaintext keys as before and does not rewrite them', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'identity.key'), KEY, { mode: 0o600 });
    const store = new FileIdentityStore(dir, { passphrase: PW });

    expect(await store.load()).toBe(KEY);
    expect(await fs.readFile(path.join(dir, 'identity.key'), 'utf8')).toBe(KEY);
  });

  it('refuses a passphrase shorter than 12 characters for new keys, counted after NFKC', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'identity.key');
    await expect(new FileIdentityStore(dir, { passphrase: 'short' }).save(KEY)).rejects.toThrow(/ANTSEED_PASSPHRASE.*at least 12 characters/);
    await expect(fs.access(file)).rejects.toThrow();
    // Eleven ligature characters that NFKC expands to twenty-two: long enough.
    await new FileIdentityStore(dir, { passphrase: '\uFB00'.repeat(11) }).save(KEY);

    await fs.writeFile(file, KEY, { mode: 0o600 });
    await expect(new FileIdentityStore(dir, { passphrase: ' 10 chars ' }).protect()).rejects.toThrow(/at least 12 characters/);
    expect(await fs.readFile(file, 'utf8')).toBe(KEY);
  });

  it('still opens files encrypted earlier with a short passphrase', async () => {
    const dir = await tmpDir();
    await fs.writeFile(path.join(dir, 'identity.key'), await encryptIdentityKey(KEY, 'pw', FAST), { mode: 0o600 });
    const store = new FileIdentityStore(dir, { passphrase: 'pw' });
    expect(await store.load()).toBe(KEY);
    expect(await store.unprotect()).toBe(true);
  });

  it('protects and unprotects a key in place', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'identity.key');
    await fs.writeFile(file, KEY, { mode: 0o600 });
    const store = new FileIdentityStore(dir, { passphrase: PW });

    await expect(new FileIdentityStore(dir, { passphrase: null }).protect()).rejects.toThrow(/Set ANTSEED_PASSPHRASE/);
    expect(await store.protect()).toBe(true);
    expect(await store.protect()).toBe(false);
    expect(await store.format()).toBe('encrypted');
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect(await store.load()).toBe(KEY);

    await expect(new FileIdentityStore(dir, { passphrase: 'nope' }).unprotect()).rejects.toThrow(/Wrong passphrase/);
    expect(await store.unprotect()).toBe(true);
    expect(await store.unprotect()).toBe(false);
    expect(await fs.readFile(file, 'utf8')).toBe(KEY);
    expect((await fs.readdir(dir)).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});

describe('passphrase from the environment', () => {
  it('reads ANTSEED_PASSPHRASE_FILE when the variable is not set', async () => {
    const dir = await tmpDir();
    const file = path.join(dir, 'passphrase');
    await fs.writeFile(file, 'from-file\nignored\n');
    process.env.ANTSEED_PASSPHRASE_FILE = file;
    try {
      expect(resolveIdentityPassphrase()).toBe('from-file');
      await fs.writeFile(file, '\n');
      expect(() => resolveIdentityPassphrase()).toThrow(/is empty/);
    } finally {
      delete process.env.ANTSEED_PASSPHRASE_FILE;
    }
  });

  it('loadOrCreateIdentity encrypts with ANTSEED_PASSPHRASE and removes it from the environment', async () => {
    const dir = await tmpDir();
    process.env.ANTSEED_PASSPHRASE = 'env passphrase 1';

    const created = await loadOrCreateIdentity(dir);
    expect(process.env.ANTSEED_PASSPHRASE).toBeUndefined();
    expect(await new FileIdentityStore(dir).format()).toBe('encrypted');

    const reloaded = await loadOrCreateIdentity(dir);
    expect(reloaded.wallet.address).toBe(created.wallet.address);
    expect(await new FileIdentityStore(dir, { passphrase: 'env passphrase 1' }).load()).toBe(created.wallet.privateKey.slice(2));
    expect(identityPassphraseEnv()).toEqual({ ANTSEED_PASSPHRASE: 'env passphrase 1' });
  });
});
