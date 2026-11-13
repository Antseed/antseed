import { ANTSEED_REQUIRE_TEE_HEADER } from '@antseed/node';

/**
 * Headers every request to the gateway carries: the key as a bearer token,
 * and for a Private run the TEE requirement. Sent with each request of the
 * run, it holds even if the key's policy is relaxed while the run goes on.
 */
export function gatewayRequestHeaders(endpoint: { apiKey: string; requireTee?: boolean }): Record<string, string> {
  return {
    authorization: `Bearer ${endpoint.apiKey}`,
    ...(endpoint.requireTee ? { [ANTSEED_REQUIRE_TEE_HEADER]: '1' } : {}),
  };
}
