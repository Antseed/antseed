import type { GatewayEndpointInfo } from '../../../types/bridge';

/**
 * Reads whose answer replaces what is shown, where only the newest counts:
 * an answer that a newer read or a close has overtaken is dropped. Each read
 * first clears what was shown, unless `keepShown`; `clearOnClose` clears it
 * on close too.
 */
export function createLatestReads<T>(
  load: () => Promise<T>,
  show: (value: T | null) => void,
  { clearOnClose = false }: { clearOnClose?: boolean } = {},
) {
  let current = 0;
  return {
    /**
     * Reads and shows the answer; resolves to it, or null when a newer read
     * or a close overtook this one. `keepShown` leaves what is shown in place
     * while reading; the answer still replaces it.
     */
    async refresh(options: { keepShown?: boolean } = {}): Promise<T | null> {
      const id = ++current;
      if (!options.keepShown) show(null);
      const value = await load();
      if (id !== current) return null;
      show(value);
      return value;
    },
    /** Drops any read in flight. */
    close(): void {
      current += 1;
      if (clearOnClose) show(null);
    },
  };
}

/**
 * Reads of the gateway endpoint for a card that shows its URL and key. A
 * failed read never leaves an old key to copy (the key may have been rotated
 * in the console), and a close clears what was shown.
 */
export function createEndpointReads(
  read: () => Promise<GatewayEndpointInfo> | undefined,
  show: (endpoint: GatewayEndpointInfo | null) => void,
) {
  return createLatestReads<GatewayEndpointInfo>(async () => {
    try {
      return (await read()) ?? { ok: false, error: 'Gateway unavailable' };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }, show, { clearOnClose: true });
}

/**
 * The key to copy, read again at that moment: it may have been revoked or
 * replaced in the console since it was shown. Null when the read failed.
 */
export async function readKeyToCopy(reads: { refresh: (options?: { keepShown?: boolean }) => Promise<GatewayEndpointInfo | null> }): Promise<string | null> {
  const endpoint = await reads.refresh({ keepShown: true });
  return endpoint?.ok && endpoint.apiKey ? endpoint.apiKey : null;
}

/**
 * Copies a key read at the moment of copying; when that read fails nothing is
 * copied, so a revoked or replaced key never reaches the clipboard.
 */
export async function copyFreshKey(
  readValue: () => Promise<string | null>,
  copy: (value: string) => Promise<void>,
): Promise<boolean> {
  const current = await readValue().catch(() => null);
  if (!current) return false;
  await copy(current);
  return true;
}
