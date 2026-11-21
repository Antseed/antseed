import type { MintedBlindCredential } from '@antseed/node';

/** The upstream host whose scoped credentials the blind relay can mint. */
export const DEEPINFRA_HOST = 'api.deepinfra.com';
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

export interface DeepInfraBlindRelayOptions {
  /** The seller's OpenAI-compatible base URL on DeepInfra, e.g. https://api.deepinfra.com/v1/openai. */
  baseUrl: string;
  apiKey: string;
  /** The service's upstream model (after the seller's alias map). */
  resolveUpstreamModel: (service: string) => string;
  /** The spend cap of each credential, in USD. */
  spendLimitUsd: number;
  /** How long each credential lives, in seconds. */
  ttlSeconds: number;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function isDeepInfraBaseUrl(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    return url.protocol === 'https:' && url.hostname === DEEPINFRA_HOST;
  } catch {
    return false;
  }
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > MAX_RESPONSE_BYTES) throw new Error('upstream response is too large');
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new Error('upstream response is too large');
  if (!response.ok) throw new Error(`upstream answered HTTP ${response.status}`);
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error('upstream answered with something other than JSON');
  }
}

/**
 * DeepInfra scoped JWTs for the seller-blind relay: one model, a USD spend
 * cap and an expiry, minted with the seller's key. DeepInfra reports each
 * token's spend to its minter, which is what the seller bills from. The holder
 * of a scoped token cannot read the account's keys, balance or payments.
 */
export function deepInfraBlindRelay(options: DeepInfraBlindRelayOptions) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const origin = new URL(options.baseUrl).origin;
  const baseUrl = options.baseUrl.replace(/\/+$/, '');
  const auth = { authorization: `Bearer ${options.apiKey}`, accept: 'application/json' };

  const mintBlindCredential = async (service: string): Promise<MintedBlindCredential | null> => {
    const model = options.resolveUpstreamModel(service);
    const response = await fetchImpl(`${origin}/v1/scoped-jwt`, {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify({ models: [model], expires_delta: options.ttlSeconds, spending_limit: options.spendLimitUsd }),
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const token = (await readJson(response))['token'];
    if (typeof token !== 'string' || !token) throw new Error('upstream minted no token');
    return {
      handle: token,
      credential: token,
      upstream: { host: DEEPINFRA_HOST, port: 443, baseUrl, model },
      // The relay stops handing it out a little before the upstream does.
      expiresAt: now() + options.ttlSeconds * 1000 - 5_000,
      spendLimitUsd: options.spendLimitUsd,
    };
  };

  const blindCredentialSpendUsd = async (handle: string): Promise<number> => {
    const response = await fetchImpl(`${origin}/v1/scoped-jwt?jwtoken=${encodeURIComponent(handle)}`, {
      headers: auth,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const spent = Number((await readJson(response))['spending_current']);
    if (!Number.isFinite(spent) || spent < 0) throw new Error('upstream reported no spend');
    return spent;
  };

  return { mintBlindCredential, blindCredentialSpendUsd };
}
