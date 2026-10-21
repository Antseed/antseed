/**
 * Deterministic canonical JSON serialization and content hashing, following
 * the JSON Canonicalization Scheme (JCS, RFC 8785):
 * - UTF-8 JSON with no insignificant whitespace;
 * - object keys sorted by UTF-16 code units (RFC 8785 §3.2.3 — JS default
 *   string comparison);
 * - numbers serialized via the ECMAScript Number-to-string algorithm
 *   (RFC 8785 §3.2.2.3 — what `JSON.stringify` emits);
 * - strings escaped per `JSON.stringify` (RFC 8785 §3.2.2.2).
 *
 * Deviations, both stricter than JCS (they reject inputs JCS cannot round-trip
 * rather than coercing them):
 * - non-finite numbers (NaN / Infinity / -Infinity) throw instead of
 *   serializing to `null`;
 * - undefined / function / bigint / symbol values throw, except undefined
 *   object properties which are skipped exactly like JSON.stringify.
 * `toJSON` is honored as input conditioning (e.g. Date), like JSON.stringify.
 *
 * Also required by docs/protocol/spec/07-model-verification.md
 * ("Private Buyer References").
 */

import { createHash } from 'node:crypto';

/** Serialize a value to canonical JSON. Deterministic across platforms. */
export function canonicalJsonStringify(value: unknown): string {
  return serialize(value, '$');
}

function serialize(value: unknown, path: string): string {
  // Honor toJSON like JSON.stringify does (e.g. Date).
  if (
    value !== null &&
    (typeof value === 'object' || typeof value === 'bigint') &&
    typeof (value as { toJSON?: unknown }).toJSON === 'function'
  ) {
    value = (value as { toJSON: () => unknown }).toJSON();
  }

  if (value === null) {
    return 'null';
  }
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) {
        throw new Error(`canonicalJsonStringify: non-finite number at ${path}`);
      }
      return JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'undefined':
    case 'function':
    case 'bigint':
    case 'symbol':
      throw new Error(`canonicalJsonStringify: unsupported ${typeof value} at ${path}`);
    default:
      break;
  }

  if (Array.isArray(value)) {
    // Index loop, NOT Array.prototype.map: map skips holes in sparse arrays,
    // which would emit invalid JSON like "[1,,2]". Indexing a hole reads
    // undefined, which hits the unsupported-value throw path above — matching
    // the module contract (undefined is only skippable as an object property).
    const parts: string[] = [];
    for (let i = 0; i < value.length; i++) {
      parts.push(serialize(value[i], `${path}[${i}]`));
    }
    return `[${parts.join(',')}]`;
  }

  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const entry = obj[key];
    if (entry === undefined) {
      // Skip undefined object properties, like JSON.stringify.
      continue;
    }
    parts.push(`${JSON.stringify(key)}:${serialize(entry, `${path}.${key}`)}`);
  }
  return `{${parts.join(',')}}`;
}

/** Lowercase hex sha256 of a string (UTF-8) or raw bytes. No prefix. */
export function sha256Hex(input: string | Uint8Array): string {
  const hash = createHash('sha256');
  if (typeof input === 'string') {
    hash.update(input, 'utf8');
  } else {
    hash.update(input);
  }
  return hash.digest('hex');
}

/** Content hash of a value's canonical JSON, formatted as `sha256:<hex>`. */
export function canonicalHash(value: unknown): string {
  return `sha256:${sha256Hex(canonicalJsonStringify(value))}`;
}

/**
 * Content hash of a value's canonical JSON formatted as a 0x-prefixed bytes32
 * hex string, for on-chain fields (evidenceHash, probeCommitment).
 */
export function canonicalHashBytes32(value: unknown): string {
  return `0x${sha256Hex(canonicalJsonStringify(value))}`;
}
