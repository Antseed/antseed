/**
 * The bytes of an inline `data:<kind>/...;base64,` source, or null when
 * `source` is not one (a URL, another media type, or broken base64).
 */
export function inlineMediaBytes(source: unknown, kind: 'video' | 'audio'): Uint8Array | null {
  if (typeof source !== 'string') return null;
  const match = /^data:([a-z]+)\/[a-z0-9.+-]+(?:;[a-z0-9.+-]+=[^;,]*)*;base64,/i.exec(source.slice(0, 256));
  if (!match || match[1]!.toLowerCase() !== kind) return null;
  return base64Bytes(source.slice(match[0].length));
}

/** The bytes of a base64 string, or null when it is not base64. */
export function base64Bytes(text: string): Uint8Array | null {
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
