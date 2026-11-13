// One seed per run: everything random in a testbench run comes from these streams, so a failure can be replayed.
import { randomInt } from 'node:crypto';

const TAG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/** A fresh run seed: an integer in [0, 2^32). */
export const randomSeed = () => randomInt(0, 2 ** 32);

/** mulberry32: a deterministic `() => number` in [0, 1), a drop-in for Math.random. */
export function createPrng(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 2 ** 32;
  };
}

/**
 * A 32-bit sub-seed for a named stream: FNV-1a over the label, started from the seed, with a murmur3 finalizer.
 * Part of the replay contract: changing this function, or a label a caller passes, changes what every seed means.
 */
export function derive(seed, label) {
  let hash = (0x811c9dc5 ^ seed) >>> 0;
  for (const byte of Buffer.from(String(label), 'utf8')) hash = Math.imul(hash ^ byte, 0x01000193);
  hash = Math.imul(hash ^ (hash >>> 16), 0x85ebca6b);
  hash = Math.imul(hash ^ (hash >>> 13), 0xc2b2ae35);
  return (hash ^ (hash >>> 16)) >>> 0;
}

/** A lowercase alphanumeric tag of `length` characters, safe inside the mock's `[req:TAG]` marker. */
export function randomTag(prng, length = 13) {
  return Array.from({ length }, () => TAG_ALPHABET[Math.floor(prng() * TAG_ALPHABET.length)]).join('');
}
