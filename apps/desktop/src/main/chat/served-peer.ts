/**
 * Which seller answered a request. The gateway says so in a response header,
 * but the agent library makes its own requests and doesn't expose headers, so
 * fetch is observed for the calls made inside one chat run.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const SERVED_PEER_HEADER = 'x-antseed-peer-id';

const currentRun = new AsyncLocalStorage<(peerId: string) => void>();
let observing = false;

function observeFetch(): void {
  if (observing) return;
  observing = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const response = await realFetch(...args);
    const peerId = response.headers.get(SERVED_PEER_HEADER)?.trim();
    if (peerId) currentRun.getStore()?.(peerId);
    return response;
  };
}

/** Runs `run`, calling `onPeer` with each seller that answers a request made inside it. */
export function trackServedPeer<T>(onPeer: (peerId: string) => void, run: () => Promise<T>): Promise<T> {
  observeFetch();
  return currentRun.run(onPeer, run);
}

export function servedPeerFromResponse(response: Response): string | null {
  return response.headers.get(SERVED_PEER_HEADER)?.trim() || null;
}
