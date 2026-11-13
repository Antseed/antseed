/**
 * Byte-level helpers shared by every metadata version. All multi-byte values
 * are big-endian.
 */

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export const SIGNATURE_LENGTH = 65;

/**
 * A map for decoded service-keyed entries. It has no prototype, so a service
 * named "__proto__" or "constructor" decodes as an ordinary entry.
 */
export function serviceMap<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>;
}

export class MetadataWriter {
  private readonly parts: Uint8Array[] = [];

  u8(value: number): void {
    this.parts.push(new Uint8Array([value]));
  }

  u16(value: number): void {
    const buf = new ArrayBuffer(2);
    new DataView(buf).setUint16(0, value, false);
    this.parts.push(new Uint8Array(buf));
  }

  u32(value: number): void {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setUint32(0, value, false);
    this.parts.push(new Uint8Array(buf));
  }

  u64(value: number): void {
    const buf = new ArrayBuffer(8);
    new DataView(buf).setBigUint64(0, BigInt(value), false);
    this.parts.push(new Uint8Array(buf));
  }

  f32(value: number): void {
    const buf = new ArrayBuffer(4);
    new DataView(buf).setFloat32(0, value, false);
    this.parts.push(new Uint8Array(buf));
  }

  bytes(value: Uint8Array): void {
    this.parts.push(value);
  }

  /** u8-length-prefixed UTF-8. Throws past 255 bytes. */
  utf8(value: string): void {
    const bytes = textEncoder.encode(value);
    if (bytes.length > 255) {
      throw new Error(`Metadata string too long (${bytes.length} bytes)`);
    }
    this.u8(bytes.length);
    this.bytes(bytes);
  }

  /**
   * u8-length-prefixed UTF-8 whose length byte wraps past 255 instead of
   * throwing. Older fields were written this way; their bytes are signed, so
   * they must stay exactly as they were.
   */
  utf8Wrapping(value: string): void {
    const bytes = textEncoder.encode(value);
    this.u8(bytes.length);
    this.bytes(bytes);
  }

  /** u16-length-prefixed UTF-8. */
  utf8Long(value: string): void {
    const bytes = textEncoder.encode(value);
    this.u16(bytes.length);
    this.bytes(bytes);
  }

  /** Entry count for a per-service list: u16 when `wide`, u8 otherwise. */
  serviceEntryCount(count: number, wide: boolean): void {
    if (wide) {
      if (count > 0xffff) throw new Error(`Service entry count ${count} exceeds uint16`);
      this.u16(count);
      return;
    }
    if (count > 0xff) throw new Error(`Service entry count ${count} requires wide service counts`);
    this.u8(count);
  }

  finish(): Uint8Array {
    const total = this.parts.reduce((sum, part) => sum + part.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const part of this.parts) {
      result.set(part, offset);
      offset += part.length;
    }
    return result;
  }
}

export class MetadataReader {
  offset = 0;

  /** `end` is the first byte this reader may not read (the signature start). */
  constructor(private readonly data: Uint8Array, private readonly end: number) {}

  remaining(): number {
    return this.end - this.offset;
  }

  private need(count: number): void {
    if (this.offset + count > this.end) throw new Error("Truncated metadata buffer");
  }

  private view(count: number): DataView {
    this.need(count);
    const view = new DataView(this.data.buffer, this.data.byteOffset + this.offset, count);
    this.offset += count;
    return view;
  }

  u8(): number {
    this.need(1);
    return this.data[this.offset++]!;
  }

  u16(): number {
    return this.view(2).getUint16(0, false);
  }

  u32(): number {
    return this.view(4).getUint32(0, false);
  }

  u64(): number {
    return Number(this.view(8).getBigUint64(0, false));
  }

  f32(): number {
    return this.view(4).getFloat32(0, false);
  }

  bytes(count: number): Uint8Array {
    this.need(count);
    const value = this.data.slice(this.offset, this.offset + count);
    this.offset += count;
    return value;
  }

  utf8(): string {
    return textDecoder.decode(this.bytes(this.u8()));
  }

  utf8Long(): string {
    return textDecoder.decode(this.bytes(this.u16()));
  }

  serviceEntryCount(wide: boolean): number {
    return wide ? this.u16() : this.u8();
  }
}

/** Code-unit string order: signed bytes must not depend on the verifier's locale. */
export function compareCodeUnits(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
