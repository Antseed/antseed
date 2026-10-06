const decoder = new TextDecoder();
const encoder = new TextEncoder();

export interface JsonObjectParseOptions {
  maxBytes?: number;
  payloadName?: string;
}

export function parseJsonObject(
  input: Uint8Array | string,
  options: JsonObjectParseOptions = {},
): Record<string, unknown> {
  const text = decodeJsonInput(input, options);
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Expected JSON object');
  }
  return raw as Record<string, unknown>;
}

export function tryParseJsonObject(
  input: Uint8Array | string,
  options: JsonObjectParseOptions = {},
): Record<string, unknown> | null {
  try {
    return parseJsonObject(input, options);
  } catch {
    return null;
  }
}

export function hasJsonContentType(headers: Record<string, string>): boolean {
  const contentType = headers['content-type'] ?? headers['Content-Type'] ?? '';
  return contentType.toLowerCase().includes('application/json');
}

export function requireStringField(obj: Record<string, unknown>, field: string): string {
  const value = obj[field];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Missing or invalid string field: ${field}`);
  }
  return value;
}

export function requireFiniteNumberField(obj: Record<string, unknown>, field: string): number {
  const value = obj[field];
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Missing or invalid number field: ${field}`);
  }
  return value;
}

function decodeJsonInput(input: Uint8Array | string, options: JsonObjectParseOptions): string {
  const maxBytes = options.maxBytes;
  const payloadName = options.payloadName ?? 'JSON payload';
  if (typeof input === 'string') {
    const byteLength = maxBytes === undefined ? 0 : encoder.encode(input).byteLength;
    if (maxBytes !== undefined && byteLength > maxBytes) {
      throw new Error(`${payloadName} too large: ${byteLength} bytes (max ${maxBytes})`);
    }
    return input;
  }
  if (maxBytes !== undefined && input.byteLength > maxBytes) {
    throw new Error(`${payloadName} too large: ${input.byteLength} bytes (max ${maxBytes})`);
  }
  return decoder.decode(input);
}
