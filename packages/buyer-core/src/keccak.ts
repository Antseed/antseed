import { keccak_256 } from '@noble/hashes/sha3';
import { createKeccak, type IHasher } from 'hash-wasm';
import { bytesToHex } from '@antseed/protocol/signing';

/**
 * Keccak-256 for large payloads (request and response bodies hashed for
 * response auth). The pure-JS hash (@noble/hashes, also behind ethers'
 * `keccak256`) took over a second per 4 MB body on a 2-vCPU seller and was
 * the largest cost on its single thread; the WASM one is ~25× faster and
 * returns the same digest. WASM compiles asynchronously, so until it is ready
 * (the first milliseconds of a process, or where WASM is unavailable) the
 * pure-JS hash is used.
 */
let wasm: IHasher | null = null;

export const keccakReady: Promise<void> = createKeccak(256).then(
  (hasher) => { wasm = hasher; },
  () => { /* stay on the pure-JS hash */ },
);

/** Keccak-256 of `data` as 0x-prefixed hex. */
export function keccak256Hex(data: Uint8Array): string {
  if (wasm) {
    wasm.init();
    wasm.update(data);
    return `0x${wasm.digest('hex')}`;
  }
  return `0x${bytesToHex(keccak_256(data))}`;
}

export interface IncrementalKeccak {
  update(data: Uint8Array): void;
  digest(): Uint8Array;
}

/**
 * Incremental Keccak-256. The one WASM hasher is shared, so each update
 * loads this hash's saved state, hashes, and saves it again; streams can
 * interleave freely.
 */
export function createIncrementalKeccak256(): IncrementalKeccak {
  if (!wasm) {
    const hash = keccak_256.create();
    return { update: (data) => { hash.update(data); }, digest: () => hash.digest() };
  }
  const hasher = wasm;
  hasher.init();
  let state = hasher.save();
  return {
    update(data) {
      hasher.load(state);
      hasher.update(data);
      state = hasher.save();
    },
    digest() {
      hasher.load(state);
      return hasher.digest('binary');
    },
  };
}
