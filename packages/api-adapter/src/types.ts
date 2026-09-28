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
}

export interface SerializedHttpResponseChunk {
  requestId: string;
  data: Uint8Array;
  done: boolean;
}

export const NATIVE_VIDEO_PROTOCOLS = ['veo-video', 'seedance-video', 'venice-video'] as const;

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
