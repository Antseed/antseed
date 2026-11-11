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
    async refresh(): Promise<void> {
      const id = ++current;
      show(null);
      let endpoint: GatewayEndpointInfo;
      try {
        endpoint = (await read()) ?? { ok: false, error: 'Gateway unavailable' };
      } catch (error) {
        endpoint = { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      if (id === current) show(endpoint);
    },
    /** Drops any read in flight and what was shown. */
    close(): void {
      current += 1;
      show(null);
    },
  };
}
