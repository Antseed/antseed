import { describe, it, expect, afterEach } from 'vitest';
import * as os from 'node:os';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import {
  loadOrCreateIdentity,
  signData,
  verifySignature,
  hexToBytes,
  bytesToHex,
  signUtf8,
  verifyUtf8,
} from '../src/p2p/identity.js';

function tmpDir(): string {
  return path.join(os.tmpdir(), `antseed-test-${randomBytes(8).toString('hex')}`);
}

const dirsToClean: string[] = [];

afterEach(async () => {
  for (const dir of dirsToClean) {
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  dirsToClean.length = 0;
});

describe('hexToBytes / bytesToHex', () => {
  it('should round-trip bytes', () => {
    const original = new Uint8Array([0, 1, 127, 255, 16]);
    const hex = bytesToHex(original);
    const back = hexToBytes(hex);
    expect(back).toEqual(original);
  });

  it('should produce lowercase hex', () => {
    const hex = bytesToHex(new Uint8Array([0xab, 0xcd]));
    expect(hex).toBe('abcd');
  });

  it('should throw for odd-length hex string', () => {
    expect(() => hexToBytes('abc')).toThrow('even length');
  });
});

describe('loadOrCreateIdentity', () => {
  it('should create a new identity when config dir does not exist', async () => {
    const dir = tmpDir();
    dirsToClean.push(dir);

    const identity = await loadOrCreateIdentity(dir);

    expect(identity.peerId).toMatch(/^[0-9a-f]{40}$/);
    expect(identity.privateKey).toBeInstanceOf(Uint8Array);
    expect(identity.wallet).toBeDefined();
    expect(identity.wallet.address.slice(2).toLowerCase()).toBe(identity.peerId);
  });

  it('should persist and reload the same identity', async () => {
    const dir = tmpDir();
    dirsToClean.push(dir);

    const first = await loadOrCreateIdentity(dir);
    const second = await loadOrCreateIdentity(dir);

    expect(second.peerId).toBe(first.peerId);
    expect(bytesToHex(second.privateKey)).toBe(bytesToHex(first.privateKey));
    expect(second.wallet.address).toBe(first.wallet.address);
  });

  it('refuses to create a second identity beside an app-encrypted identity', async () => {
    const dir = tmpDir();
    dirsToClean.push(dir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'identity.enc'), randomBytes(64));

    await expect(loadOrCreateIdentity(dir)).rejects.toThrow(/app-encrypted identity already exists/);
    await expect(fs.access(path.join(dir, 'identity.key'))).rejects.toThrow();
  });

  it('refuses to replace an invalid existing plaintext identity', async () => {
    const dir = tmpDir();
    dirsToClean.push(dir);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'identity.key'), 'invalid');

    await expect(loadOrCreateIdentity(dir)).rejects.toThrow(/Existing identity is invalid/);
    expect(await fs.readFile(path.join(dir, 'identity.key'), 'utf8')).toBe('invalid');
  });
});

describe('signData / verifySignature', () => {
  it('should sign and verify data', async () => {
    const dir = tmpDir();
    dirsToClean.push(dir);

    const identity = await loadOrCreateIdentity(dir);
    const data = new TextEncoder().encode('hello world');
    const signature = signData(identity.wallet, data);

    expect(signature).toBeInstanceOf(Uint8Array);
    expect(signature.length).toBe(65);

    const valid = verifySignature(identity.peerId, signature, data);
    expect(valid).toBe(true);
  });

  it('should fail verification with wrong data', async () => {
    const dir = tmpDir();
    dirsToClean.push(dir);

    const identity = await loadOrCreateIdentity(dir);
    const data = new TextEncoder().encode('hello');
    const signature = signData(identity.wallet, data);

    const wrongData = new TextEncoder().encode('world');
    const valid = verifySignature(identity.peerId, signature, wrongData);
    expect(valid).toBe(false);
  });
});

describe('signUtf8 / verifyUtf8', () => {
  it('should sign and verify a UTF-8 message', async () => {
    const dir = tmpDir();
    dirsToClean.push(dir);

    const identity = await loadOrCreateIdentity(dir);
    const message = 'receipt|data|12345';
    const sig = signUtf8(identity.wallet, message);

    expect(sig).toMatch(/^[0-9a-f]+$/);
    expect(sig.length).toBe(130); // 65 bytes = 130 hex chars

    const valid = verifyUtf8(identity.peerId, message, sig);
    expect(valid).toBe(true);
  });

  it('should fail verification with wrong message', async () => {
    const dir = tmpDir();
    dirsToClean.push(dir);

    const identity = await loadOrCreateIdentity(dir);
    const sig = signUtf8(identity.wallet, 'correct');
    const valid = verifyUtf8(identity.peerId, 'wrong', sig);
    expect(valid).toBe(false);
  });

  it('should fail verification with invalid address', () => {
    const valid = verifyUtf8('invalidhex', 'msg', 'ab'.repeat(65));
    expect(valid).toBe(false);
  });
});
