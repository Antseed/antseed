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

/**
 * Routing APIs: services that rank inference destinations instead of serving inference.
 * Each routing API is its own protocol, served by its own provider plugin; none is the
 * default. Appended only, after the video protocols, for the same reason.
 */
export const ROUTING_PROTOCOLS = ['irp-suggest'] as const;

/**
 * Speech APIs: text in, audio file out (OpenAI `POST /v1/audio/speech`).
 * Appended only, after the routing protocols, for the same reason.
 */
export const AUDIO_SPEECH_PROTOCOLS = ['openai-audio-speech'] as const;

/**
 * Data APIs: a seller's own HTTP API offered as a service. It is described by the seller's
 * OpenAPI document, and its operations are reached unchanged under `/v1/data/<service>/`.
 * Appended only, after the speech protocols, for the same reason.
 */
export const DATA_SERVICE_PROTOCOLS = ['openapi-data'] as const;

export const WELL_KNOWN_SERVICE_API_PROTOCOLS = [
  'anthropic-messages',
  'openai-chat-completions',
  'openai-completions',
  'openai-responses',
  'openai-images',
  'typesafe-systemone',
  ...NATIVE_VIDEO_PROTOCOLS,
  ...ROUTING_PROTOCOLS,
  ...AUDIO_SPEECH_PROTOCOLS,
  ...DATA_SERVICE_PROTOCOLS,
] as const;

export type ServiceApiProtocol = (typeof WELL_KNOWN_SERVICE_API_PROTOCOLS)[number];

export type NativeVideoProtocol = (typeof NATIVE_VIDEO_PROTOCOLS)[number];

export function isNativeVideoProtocol(value: unknown): value is NativeVideoProtocol {
  return NATIVE_VIDEO_PROTOCOLS.includes(value as NativeVideoProtocol);
}

export type RoutingProtocol = (typeof ROUTING_PROTOCOLS)[number];

export function isRoutingProtocol(value: unknown): value is RoutingProtocol {
  return ROUTING_PROTOCOLS.includes(value as RoutingProtocol);
}

export type AudioSpeechProtocol = (typeof AUDIO_SPEECH_PROTOCOLS)[number];

export function isAudioSpeechProtocol(value: unknown): value is AudioSpeechProtocol {
  return AUDIO_SPEECH_PROTOCOLS.includes(value as AudioSpeechProtocol);
}

export type DataServiceProtocol = (typeof DATA_SERVICE_PROTOCOLS)[number];

export function isDataServiceProtocol(value: unknown): value is DataServiceProtocol {
  return DATA_SERVICE_PROTOCOLS.includes(value as DataServiceProtocol);
}

const SERVICE_API_PROTOCOL_SET = new Set<string>(WELL_KNOWN_SERVICE_API_PROTOCOLS);

export function isKnownServiceApiProtocol(value: string): value is ServiceApiProtocol {
  return SERVICE_API_PROTOCOL_SET.has(value);
}
