import { describe, expect, it, vi } from 'vitest';
import plugin from './index.js';

const nonce = 'ab'.repeat(32);

function venice(fetchImpl: typeof fetch) {
  vi.stubGlobal('fetch', fetchImpl);
  return plugin.createProvider({
    OPENAI_API_KEY: 'seller-key',
    OPENAI_BASE_URL: 'https://api.venice.ai/api',
    ANTSEED_ALLOWED_SERVICES: 'private-qwen,plain-qwen',
    ANTSEED_SERVICE_ALIAS_MAP_JSON: JSON.stringify({ 'private-qwen': 'e2ee-qwen-2-5-7b-p', 'plain-qwen': 'qwen-2.5-7b' }),
  });
}

describe('Venice end-to-end encryption attestation', () => {
  it('relays the attestation of the upstream e2ee model with the seller key and the buyer nonce', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ nonce, signing_key: '04aa' }), { status: 200 }));
    const provider = venice(fetchImpl as unknown as typeof fetch);
    const out = await provider.getE2eeAttestation!('private-qwen', nonce);
    expect(out?.statusCode).toBe(200);
    expect(JSON.parse(new TextDecoder().decode(out!.body))).toEqual({ nonce, signing_key: '04aa' });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`https://api.venice.ai/api/v1/tee/attestation?model=e2ee-qwen-2-5-7b-p&nonce=${nonce}`);
    expect((init.headers as Record<string, string>)['authorization']).toBe('Bearer seller-key');
    expect(init.redirect).toBe('error');
    vi.unstubAllGlobals();
  });

  it('answers null for a service whose upstream model does not encrypt end to end', async () => {
    const fetchImpl = vi.fn();
    const provider = venice(fetchImpl as unknown as typeof fetch);
    expect(await provider.getE2eeAttestation!('plain-qwen', nonce)).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
