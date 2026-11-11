import type { GatewayEndpointInfo } from '../../../types/bridge';

/**
 * Reads of the gateway endpoint for a card that shows its URL and key. Each
 * read first clears what was shown, so a failed one never leaves an old key
 * to copy (the key may have been rotated in the console), and an answer that
 * a newer read or a close has overtaken is dropped.
 */
export function createEndpointReads(
  read: () => Promise<GatewayEndpointInfo> | undefined,
  show: (endpoint: GatewayEndpointInfo | null) => void,
) {
  let current = 0;
  return {
    /** Reads and shows the endpoint; resolves to it, or null when a newer read or a close overtook this one. */
    async refresh(): Promise<GatewayEndpointInfo | null> {
      const id = ++current;
      show(null);
      let endpoint: GatewayEndpointInfo;
      try {
        endpoint = (await read()) ?? { ok: false, error: 'Gateway unavailable' };
      } catch (error) {
        endpoint = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      if (id !== current) return null;
      show(endpoint);
      return endpoint;
    },
    /** Drops any read in flight and what was shown. */
    close(): void {
      current += 1;
      show(null);
    },
  };
}

/**
 * The key to copy, read again at that moment: it may have been revoked or
 * replaced in the console since it was shown. Null when the read failed.
 */
export async function readKeyToCopy(reads: { refresh: () => Promise<GatewayEndpointInfo | null> }): Promise<string | null> {
  const endpoint = await reads.refresh();
  return endpoint?.ok && endpoint.apiKey ? endpoint.apiKey : null;
}
