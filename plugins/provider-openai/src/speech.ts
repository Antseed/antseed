import type { ServiceApiProtocol, ServiceCapabilities, SpeechOptions } from '@antseed/node';
import { validateServiceCapabilityFields } from '@antseed/node';

const MAX_MODELS_BYTES = 4 * 1024 * 1024;
const MODELS_TIMEOUT_MS = 10_000;

/** Speech services produce audio from text; config wins per field. */
export function withSpeechServiceCapabilityDefaults(
  serviceApiProtocols: Record<string, ServiceApiProtocol[]> | undefined,
  serviceCapabilities: Record<string, ServiceCapabilities> | undefined,
): Record<string, ServiceCapabilities> | undefined {
  const speechServices = Object.entries(serviceApiProtocols ?? {})
    .filter(([, protocols]) => protocols.includes('openai-audio-speech'))
    .map(([service]) => service);
  if (speechServices.length === 0) return serviceCapabilities;
  const merged: Record<string, ServiceCapabilities> = { ...serviceCapabilities };
  for (const service of speechServices) {
    merged[service] = { inputs: ['text'], outputs: ['audio'], ...merged[service] };
  }
  return merged;
}

/**
 * Speech options of one Venice TTS model from its `/models` entry: the listed
 * voices, the formats it can return, and whether it takes account voice IDs.
 * Returns null when the entry does not list valid voices.
 */
export function veniceSpeechOptions(model: unknown): SpeechOptions | null {
  const spec = (model as { model_spec?: Record<string, unknown> } | null)?.model_spec;
  if (!spec || typeof spec !== 'object') return null;
  const voices = Array.isArray(spec.voices) ? spec.voices.filter((voice): voice is string => typeof voice === 'string') : [];
  if (voices.length === 0) return null;
  const formats = Array.isArray(spec.supported_formats)
    ? spec.supported_formats.filter((format): format is string => typeof format === 'string')
    : [];
  const speech: SpeechOptions = {
    voices,
    ...(formats.length > 0 ? { formats } : {}),
    ...(typeof spec.supports_custom_voice_id === 'boolean' ? { customVoices: spec.supports_custom_voice_id } : {}),
  };
  return validateServiceCapabilityFields({ speech }).length === 0 ? speech : null;
}

/**
 * Announce the voices of Venice speech services that the seller did not list
 * itself, from Venice's free model list. Buyers see them in `/v1/models`, and
 * the seller refuses any other voice instead of letting the upstream pick one.
 * Leaves capabilities unchanged when the list can't be read.
 */
export async function announceVeniceSpeechVoices(
  baseUrl: string,
  services: string[],
  serviceApiProtocols: Record<string, ServiceApiProtocol[]> | undefined,
  serviceCapabilities: Record<string, ServiceCapabilities>,
  upstreamModelOf: (service: string) => string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const pending = services.filter((service) => serviceApiProtocols?.[service]?.includes('openai-audio-speech')
    && !serviceCapabilities[service]?.speech?.voices);
  if (pending.length === 0) return;
  try {
    const response = await fetchImpl(`${baseUrl.replace(/\/+$/, '')}/v1/models?type=tts`, {
      redirect: 'error',
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    });
    const body = Buffer.from(await response.arrayBuffer());
    if (!response.ok || body.length > MAX_MODELS_BYTES) return;
    const data = (JSON.parse(body.toString('utf8')) as { data?: unknown }).data;
    if (!Array.isArray(data)) return;
    for (const service of pending) {
      const upstream = upstreamModelOf(service);
      const speech = veniceSpeechOptions(data.find((entry) => (entry as { id?: unknown } | null)?.id === upstream));
      if (!speech) continue;
      const configured = serviceCapabilities[service]?.speech;
      serviceCapabilities[service] = { ...serviceCapabilities[service], speech: { ...speech, ...configured } };
    }
  } catch {
    // Unknown voices: the upstream still refuses a voice it does not offer.
  }
}
