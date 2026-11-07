/**
 * What the gateway's responses say about one chat run: which seller answered
 * (a response header), and whether its stream reached its end. The agent library
 * makes its own requests and exposes neither, and it reports a stream that simply
 * stopped as a normal finish, so fetch is observed for the calls made inside a run.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const SERVED_PEER_HEADER = 'x-antseed-peer-id';
/** How each chat protocol ends a stream. */
const STREAM_END = /\[DONE\]|"finish_reason":\s*"[a-z_]+"|response\.completed|message_stop/;

type ChatRun = {
  onPeer: (peerId: string) => void;
  /** Reading of the latest stream response; true when it reached its end. */
  lastStream: Promise<boolean> | null;
};

const currentRun = new AsyncLocalStorage<ChatRun>();
let observing = false;

async function reachedStreamEnd(response: Response): Promise<boolean> {
  const reader = response.body?.getReader();
  if (!reader) return true;
  const decoder = new TextDecoder();
  let tail = '';
  let ended = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return ended;
      // Keeps a marker split across two chunks findable.
      const text = tail + decoder.decode(value, { stream: true });
      ended = ended || STREAM_END.test(text);
      tail = text.slice(-40);
    }
  } catch {
    return false;
  }
}

function observeFetch(): void {
  if (observing) return;
  observing = true;
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (...args) => {
    const response = await realFetch(...args);
    const run = currentRun.getStore();
    if (!run) return response;
    const peerId = servedPeerFromResponse(response);
    if (peerId) run.onPeer(peerId);
    if (response.ok && response.headers.get('content-type')?.includes('text/event-stream')) {
      run.lastStream = reachedStreamEnd(response.clone());
    }
    return response;
  };
}

/**
 * Runs `run`, calling `onPeer` with each seller that answers a request made
 * inside it. `lastStreamEnded` resolves once `run` is over: false when the
 * last stream it read stopped before its end.
 */
export function trackChatRun<T>(onPeer: (peerId: string) => void, run: () => Promise<T>): { result: Promise<T>; lastStreamEnded: () => Promise<boolean> } {
  observeFetch();
  const chatRun: ChatRun = { onPeer, lastStream: null };
  return {
    result: currentRun.run(chatRun, run),
    lastStreamEnded: () => chatRun.lastStream ?? Promise.resolve(true),
  };
}

export function servedPeerFromResponse(response: Response): string | null {
  return response.headers.get(SERVED_PEER_HEADER)?.trim() || null;
}
