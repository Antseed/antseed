import { describe, expect, it } from 'vitest';
import { keccak256 } from 'ethers';
import { randomBytes } from 'node:crypto';
import { createIncrementalKeccak256, keccak256Hex, keccakReady } from './keccak.js';

const hex = (bytes: Uint8Array): string => `0x${Buffer.from(bytes).toString('hex')}`;

describe('keccak256Hex', () => {
  it('matches ethers keccak256 before and after the WASM hasher is ready', async () => {
    const data = randomBytes(300_000);
    const expected = keccak256(data);
    const beforeReady = keccak256Hex(data);
    await keccakReady;
    expect(beforeReady).toBe(expected);
    expect(keccak256Hex(data)).toBe(expected);
    expect(keccak256Hex(new Uint8Array())).toBe(keccak256(new Uint8Array()));
  });

  it('keeps interleaved incremental hashes separate', async () => {
    await keccakReady;
    const a = [randomBytes(1000), randomBytes(70_000)];
    const b = [randomBytes(5), randomBytes(123_456)];
    const ha = createIncrementalKeccak256();
    const hb = createIncrementalKeccak256();
    ha.update(a[0]!);
    hb.update(b[0]!);
    expect(keccak256Hex(randomBytes(64))).toMatch(/^0x[0-9a-f]{64}$/);
    ha.update(a[1]!);
    hb.update(b[1]!);
    expect(hex(ha.digest())).toBe(keccak256(Buffer.concat(a)));
    expect(hex(hb.digest())).toBe(keccak256(Buffer.concat(b)));
  });
});
