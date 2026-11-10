/** Asks the gateway for TEE sellers only, on top of the key's policy (it can only narrow it). */
export const REQUIRE_TEE_HEADER = 'x-antseed-require-tee';

/**
 * Headers every request to the gateway carries: the key as a bearer token,
 * and for a Private run the TEE requirement. Sent with each request of the
 * run, it holds even if the key's policy is relaxed while the run goes on.
 */
export function gatewayRequestHeaders(endpoint: { apiKey: string; requireTee?: boolean }): Record<string, string> {
  return {
    authorization: `Bearer ${endpoint.apiKey}`,
    ...(endpoint.requireTee ? { [REQUIRE_TEE_HEADER]: '1' } : {}),
  };
}
