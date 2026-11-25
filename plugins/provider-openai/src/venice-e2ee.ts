import type { E2eeAttestationResponse } from '@antseed/node';

/** Venice names the models that encrypt end to end with this prefix. */
export const VENICE_E2EE_MODEL_PREFIX = 'e2ee-';
const ATTESTATION_TIMEOUT_MS = 20_000;
const MAX_ATTESTATION_BYTES = 1024 * 1024;

export interface VeniceE2eeAttestationOptions {
  baseUrl: string;
  apiKey: string;
  /** The service's upstream model (after the seller's alias map). */
  resolveUpstreamModel: (service: string) => string;
  fetchImpl?: typeof fetch;
}

/**
 * Relays Venice's TEE attestation for an `e2ee-*` model, fetched with the seller's key and the
 * buyer's nonce. The body goes back unchanged: the buyer checks the quote and its binding to the
 * nonce and the model key itself, so the seller never needs to be trusted with it.
 */
export function veniceE2eeAttestation(options: VeniceE2eeAttestationOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const base = options.baseUrl.replace(/\/+$/, '');
  return async (service: string, nonce: string): Promise<E2eeAttestationResponse | null> => {
    const model = options.resolveUpstreamModel(service);
    if (!model.toLowerCase().startsWith(VENICE_E2EE_MODEL_PREFIX)) return null;
    // Buyer paths carry `/v1`, so the base URL does not (https://api.venice.ai/api).
    const url = `${base}/v1/tee/attestation?model=${encodeURIComponent(model)}&nonce=${encodeURIComponent(nonce)}`;
    const response = await fetchImpl(url, {
      headers: { authorization: `Bearer ${options.apiKey}`, accept: 'application/json' },
      redirect: 'error',
      signal: AbortSignal.timeout(ATTESTATION_TIMEOUT_MS),
    });
    const declared = Number(response.headers.get('content-length') ?? '0');
    if (declared > MAX_ATTESTATION_BYTES) throw new Error('attestation response is too large');
    const body = new Uint8Array(await response.arrayBuffer());
    if (body.byteLength > MAX_ATTESTATION_BYTES) throw new Error('attestation response is too large');
    return { statusCode: response.status, body };
  };
}
