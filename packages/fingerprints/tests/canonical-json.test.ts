import { describe, expect, it } from 'vitest';
import {
  canonicalHash,
  canonicalHashBytes32,
  canonicalJsonStringify,
  sha256Hex,
} from '../src/canonical-json.js';

describe('canonicalJsonStringify', () => {
  it('sorts object keys lexicographically', () => {
    expect(canonicalJsonStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('sorts nested object keys and preserves array order', () => {
    expect(canonicalJsonStringify({ b: 1, a: { d: [1, 2], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[1,2]},"b":1}',
    );
    expect(canonicalJsonStringify([3, 1, 2])).toBe('[3,1,2]');
  });

  it('emits no whitespace', () => {
    const out = canonicalJsonStringify({ a: [1, { b: 'x y' }] });
    expect(out.replace(/"[^"]*"/g, '""')).not.toMatch(/\s/);
  });

  it('serializes primitives like JSON', () => {
    expect(canonicalJsonStringify(null)).toBe('null');
    expect(canonicalJsonStringify(true)).toBe('true');
    expect(canonicalJsonStringify(false)).toBe('false');
    expect(canonicalJsonStringify(1.5)).toBe('1.5');
    expect(canonicalJsonStringify(-0.25)).toBe('-0.25');
    expect(canonicalJsonStringify('a"b')).toBe('"a\\"b"');
  });

  it('rejects NaN and Infinity', () => {
    expect(() => canonicalJsonStringify(NaN)).toThrow(/non-finite/);
    expect(() => canonicalJsonStringify(Infinity)).toThrow(/non-finite/);
    expect(() => canonicalJsonStringify({ a: -Infinity })).toThrow(/non-finite/);
    expect(() => canonicalJsonStringify([NaN])).toThrow(/non-finite/);
  });

  it('skips undefined object properties like JSON.stringify', () => {
    expect(canonicalJsonStringify({ a: 1, b: undefined })).toBe('{"a":1}');
  });

  it('throws on undefined, function, and bigint elsewhere', () => {
    expect(() => canonicalJsonStringify(undefined)).toThrow(/unsupported/);
    expect(() => canonicalJsonStringify([undefined])).toThrow(/unsupported/);
    expect(() => canonicalJsonStringify({ a: [() => 1] })).toThrow(/unsupported/);
    expect(() => canonicalJsonStringify({ a: 1n })).toThrow(/unsupported/);
  });

  it('treats sparse-array holes as undefined (throws) instead of emitting invalid JSON', () => {
    // Array.prototype.map skips holes, which used to serialize [1, <hole>, 2]
    // to the invalid "[1,,2]". Holes must hit the same path as an explicit
    // undefined element.
    const sparse: unknown[] = [1];
    sparse[2] = 2; // hole at index 1
    expect(() => canonicalJsonStringify(sparse)).toThrow(/unsupported undefined at \$\[1\]/);
    // A trailing hole must throw too, not silently truncate or emit ",".
    const trailingHole: unknown[] = [1, 2];
    trailingHole.length = 3;
    expect(() => canonicalJsonStringify(trailingHole)).toThrow(/unsupported undefined at \$\[2\]/);
  });

  it('honors toJSON (Date)', () => {
    expect(canonicalJsonStringify(new Date('2026-06-14T00:00:00.000Z'))).toBe(
      '"2026-06-14T00:00:00.000Z"',
    );
  });

  it('is stable regardless of key insertion order', () => {
    const a = { x: 1, y: { b: 2, a: 3 } };
    const b: Record<string, unknown> = {};
    b['y'] = { a: 3, b: 2 };
    b['x'] = 1;
    expect(canonicalJsonStringify(a)).toBe(canonicalJsonStringify(b));
  });

  // RFC 8785 §3.2.3: keys sort by UTF-16 code units, NOT locale/codepoint
  // collation.
  it('sorts non-ASCII keys by UTF-16 code units', () => {
    // "é" is U+00E9 (0x00e9) > "z" (0x007a): "z" sorts first.
    expect(canonicalJsonStringify({ 'é': 1, z: 2 })).toBe('{"z":2,"é":1}');
    // Surrogate-pair key "𝄞" (U+1D11E → 0xd834 0xdd1e) sorts by its FIRST
    // code unit 0xd834, so it precedes "﻿" (0xfeff) despite the higher
    // code point.
    expect(canonicalJsonStringify({ '﻿': 1, '𝄞': 2 })).toBe('{"𝄞":2,"﻿":1}');
    // RFC 8785 §3.2.3 example ordering fragment: "\r" < "1" < "El Niño"-style
    // non-ASCII after ASCII.
    expect(canonicalJsonStringify({ 'ü': 1, '\r': 2, '1': 3 })).toBe(
      '{"\\r":2,"1":3,"ü":1}',
    );
  });

  // RFC 8785 §3.2.2.2: control characters use \u00xx (lowercase hex) except
  // the short forms \b \t \n \f \r.
  it('escapes control characters per the JSON short forms and \\u00xx', () => {
    expect(canonicalJsonStringify('\u0000')).toBe('"\\u0000"');
    expect(canonicalJsonStringify('\u001f')).toBe('"\\u001f"');
    expect(canonicalJsonStringify('\b\t\n\f\r')).toBe('"\\b\\t\\n\\f\\r"');
  });

  it('escapes lone surrogates instead of emitting invalid UTF-8', () => {
    // ES2019 well-formed JSON.stringify escapes unpaired surrogates.
    expect(canonicalJsonStringify('\ud800')).toBe('"\\ud800"');
    expect(canonicalJsonStringify('\udfff')).toBe('"\\udfff"');
    expect(canonicalJsonStringify('a\ud800b')).toBe('"a\\ud800b"');
    // A well-formed pair passes through unescaped.
    expect(canonicalJsonStringify('𝄞')).toBe('"𝄞"');
  });

  // RFC 8785 §3.2.2.3 / Appendix B: ECMAScript Number-to-string algorithm.
  it('serializes numbers via the ECMAScript algorithm, including exponent forms', () => {
    expect(canonicalJsonStringify(1e21)).toBe('1e+21');
    expect(canonicalJsonStringify(1e20)).toBe('100000000000000000000');
    expect(canonicalJsonStringify(1e-7)).toBe('1e-7');
    expect(canonicalJsonStringify(0.000001)).toBe('0.000001');
    expect(canonicalJsonStringify(333333333.33333329)).toBe('333333333.3333333');
    expect(canonicalJsonStringify(9007199254740996.0)).toBe('9007199254740996');
    expect(canonicalJsonStringify(-0)).toBe('0');
  });
});

describe('sha256Hex / canonicalHash / canonicalHashBytes32', () => {
  it('matches the known sha256 of "abc"', () => {
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('hashes bytes and strings identically for the same UTF-8 content', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(sha256Hex('abc'));
  });

  it('produces stable canonical hashes (fixed expected values)', () => {
    const value = { b: 1, a: { d: [1, 2], c: 'x' } };
    expect(canonicalHash(value)).toBe(
      'sha256:830c7b7f8c79059841a32e4738f35625c6e5bb256f2821b221cadaef7411d44d',
    );
    expect(canonicalHashBytes32(value)).toBe(
      '0x830c7b7f8c79059841a32e4738f35625c6e5bb256f2821b221cadaef7411d44d',
    );
  });

  it('canonicalHashBytes32 is a 0x-prefixed 64-hex string', () => {
    expect(canonicalHashBytes32({ a: 1 })).toMatch(/^0x[0-9a-f]{64}$/);
  });
});
