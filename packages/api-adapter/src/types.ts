export interface SerializedHttpRequest {
  requestId: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body: Uint8Array;
}

export interface SerializedHttpResponse {
  requestId: string;
  statusCode: number;
  headers: Record<string, string>;
  body: Uint8Array;
  /**
   * Locally computed descriptor of a streamed video download (never read from
   * the wire). `videoDurationMs` is set only when the bytes formed a complete
   * MP4 with a readable duration.
   */
  streamedBody?: { byteLength: number; responseHash: string; videoDurationMs?: number };
}

export interface SerializedHttpResponseChunk {
  requestId: string;
  data: Uint8Array;
  done: boolean;
}

/** Appended only: billing metadata encodes protocols by list position. */
export const NATIVE_VIDEO_PROTOCOLS = ['venice-video', 'fal-video'] as const;

export const WELL_KNOWN_SERVICE_API_PROTOCOLS = [
  'anthropic-messages',
  'openai-chat-completions',
  'openai-completions',
  'openai-responses',
  'openai-images',
  'typesafe-systemone',
  ...NATIVE_VIDEO_PROTOCOLS,
] as const;

export type ServiceApiProtocol = (typeof WELL_KNOWN_SERVICE_API_PROTOCOLS)[number];

export type NativeVideoProtocol = (typeof NATIVE_VIDEO_PROTOCOLS)[number];

export function isNativeVideoProtocol(value: unknown): value is NativeVideoProtocol {
  return NATIVE_VIDEO_PROTOCOLS.includes(value as NativeVideoProtocol);
}

const SERVICE_API_PROTOCOL_SET = new Set<string>(WELL_KNOWN_SERVICE_API_PROTOCOLS);

export function isKnownServiceApiProtocol(value: string): value is ServiceApiProtocol {
  return SERVICE_API_PROTOCOL_SET.has(value);
}
