/**
 * What the gateway's responses say about one chat run: which seller answered
 * (a response header), and whether its stream reached its end. The agent library
 * makes its own requests and exposes neither, and it reports a stream that simply
 * stopped as a normal finish, so fetch is observed for the calls made inside a run.
 */
import { AsyncLocalStorage } from 'node:async_hooks';

const SERVED_PEER_HEADER = 'x-antseed-peer-id';
/** The model the seller served: under a router, the one the router picked. */
const SERVED_MODEL_HEADER = 'x-antseed-service';
/** The event names that end a Responses or Anthropic Messages stream. */
const END_EVENTS: ReadonlySet<string> = new Set(['response.completed', 'message_stop']);

/**
 * Whether one SSE line is a stream's end record: `[DONE]`, a choice with a
 * finish reason, or an end event. Read from the record's own fields, never
 * from text: a reply can quote any of these words.
 */
export function isStreamEndLine(line: string): boolean {
  const event = /^event:\s*(.*)$/.exec(line);
  if (event) return END_EVENTS.has(event[1]!.trim());
  const data = /^data:\s*(.*)$/.exec(line);
  if (!data) return false;
  const payload = data[1]!.trim();
  if (payload === '[DONE]') return true;
  let record: unknown;
  try {
    record = JSON.parse(payload);
  } catch {
    return false;
  }
  if (!record || typeof record !== 'object') return false;
  const { type, choices } = record as { type?: unknown; choices?: unknown };
  if (typeof type === 'string' && END_EVENTS.has(type)) return true;
  return Array.isArray(choices) && choices.some((choice) => typeof (choice as { finish_reason?: unknown } | null)?.finish_reason === 'string');
}

type ChatRun = {
  onPeer: (peerId: string, servedModel: string | null) => void;
  /** Reading of the latest stream response; true when it reached its end. */
  lastStream: Promise<boolean> | null;
};

const currentRun = new AsyncLocalStorage<ChatRun>();
let observing = false;

async function reachedStreamEnd(response: Response): Promise<boolean> {
  const reader = response.body?.getReader();
  if (!reader) return true;
  const decoder = new TextDecoder();
  // The line still being received: a record split across chunks is read whole.
  let partial = '';
  let ended = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      const lines = (partial + (done ? decoder.decode() : decoder.decode(value, { stream: true }))).split(/\r?\n/);
      partial = done ? '' : lines.pop()!;
      ended = ended || lines.some(isStreamEndLine);
      if (done) return ended;
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
    if (peerId) run.onPeer(peerId, servedModelFromResponse(response));
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
export function trackChatRun<T>(onPeer: (peerId: string, servedModel: string | null) => void, run: () => Promise<T>): { result: Promise<T>; lastStreamEnded: () => Promise<boolean> } {
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

export function servedModelFromResponse(response: Response): string | null {
  return response.headers.get(SERVED_MODEL_HEADER)?.trim() || null;
}
