export const ANTSEED_MODEL_CONTEXT_WINDOW = 280_000;
export const ANTSEED_MODEL_MAX_OUTPUT_TOKENS = 8_192;

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
