/**
 * Token usage of a whole agent loop.
 *
 * One buyer request becomes one upstream model call per tool round plus a
 * final one. The seller meters the response the provider returns and the buyer
 * prices the stream it received, so both must report the usage of every call,
 * not only the last. `LoopUsage` sits around a loop: it reads each call's
 * usage, adds the earlier calls to the usage events the buyer receives, and
 * puts the total into the returned response.
 *
 * A request answered in one call is passed through untouched.
 */

import type {
  Provider,
  SerializedHttpResponse,
  ProviderStreamCallbacks,
} from '@antseed/node';

type Usage = Record<string, unknown>;

/** The part of a provider an agent loop calls. */
export type LoopProvider = Pick<Provider, 'handleRequest' | 'handleRequestStream'>;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Sum of two usage objects of the same API: numbers are added at every depth
 * (token counts and their details), anything else keeps the later value.
 */
function addUsage(a: Usage | undefined, b: Usage): Usage {
  if (!a) return b;
  const sum: Usage = { ...a };
  for (const [key, value] of Object.entries(b)) {
    const earlier = sum[key];
    if (typeof value === 'number' && typeof earlier === 'number') sum[key] = earlier + value;
    else if (isObject(value) && isObject(earlier)) sum[key] = addUsage(earlier, value);
    else if (value != null) sum[key] = value;
  }
  return sum;
}

/**
 * The object holding `usage` in a response body or stream event: the body or
 * event itself (Anthropic `message_delta`, OpenAI chunks, JSON bodies), its
 * `response` (Responses `response.completed`) or its `message` (Anthropic
 * `message_start`).
 */
function usageHolder(payload: unknown): Record<string, unknown> | undefined {
  if (!isObject(payload)) return undefined;
  return [payload, payload.response, payload.message].find(
    (holder): holder is Record<string, unknown> => isObject(holder) && isObject(holder.usage),
  );
}

/**
 * Calls `replace` with each usage object in a JSON body or in the `data:` lines
 * of SSE text. A usage it returns takes the original's place. Text without a
 * replaced usage comes back unchanged, byte for byte.
 */
function mapUsage(text: string, replace: (usage: Usage) => Usage | undefined): string {
  if (!text.includes('"usage"')) return text;
  const mapJson = (json: string): string | undefined => {
    let payload: unknown;
    try {
      payload = JSON.parse(json);
    } catch {
      return undefined;
    }
    const holder = usageHolder(payload);
    const replacement = holder && replace(holder.usage as Usage);
    if (!holder || !replacement) return undefined;
    holder.usage = replacement;
    return JSON.stringify(payload);
  };

  if (text.trimStart().startsWith('{')) return mapJson(text) ?? text;
  return text
    .split('\n')
    .map((line) => {
      if (!line.startsWith('data:') || !line.includes('"usage"')) return line;
      const mapped = mapJson(line.slice(5));
      return mapped === undefined ? line : `data: ${mapped}${line.endsWith('\r') ? '\r' : ''}`;
    })
    .join('\n');
}

/** Usage a response body reports. Within one stream a later event's counts replace an earlier event's. */
function usageOf(text: string): Usage | undefined {
  let usage: Usage | undefined;
  mapUsage(text, (found) => {
    usage = { ...usage, ...found };
    return undefined;
  });
  return usage;
}

/** Splits streamed bytes into whole lines, keeping an unfinished line (or UTF-8 character) for the next chunk. */
class LineBuffer {
  private _decoder = new TextDecoder();
  private _rest = '';

  /** The whole lines available after `data`, ending in a newline, or ''. */
  push(data: Uint8Array): string {
    this._rest += this._decoder.decode(data, { stream: true });
    const end = this._rest.lastIndexOf('\n') + 1;
    const lines = this._rest.slice(0, end);
    this._rest = this._rest.slice(end);
    return lines;
  }

  /** What is left when the stream ends. */
  flush(): string {
    const rest = this._rest + this._decoder.decode();
    this._rest = '';
    return rest;
  }
}

export class LoopUsage {
  /** Sum over the calls before the latest one. */
  private _earlier: Usage | undefined;
  /** Usage of the latest call: what its stream has reported so far, then what its response reports. */
  private _latest: Usage | undefined;
  private _calls = 0;
  private _upstream = new LineBuffer();
  private readonly _forwarded = new LineBuffer();

  /** `inner` with the usage of each call read, so every call is counted once. */
  meter(inner: LoopProvider): LoopProvider {
    const call = async (run: () => Promise<SerializedHttpResponse>): Promise<SerializedHttpResponse> => {
      if (this._latest) this._earlier = addUsage(this._earlier, this._latest);
      this._latest = undefined;
      this._upstream = new LineBuffer();
      this._calls += 1;
      try {
        const response = await run();
        this._latest = usageOf(decoder.decode(response.body ?? new Uint8Array(0))) ?? this._latest;
        return response;
      } catch (err) {
        // A call that failed delivered nothing to bill for.
        this._latest = undefined;
        throw err;
      }
    };
    const stream = inner.handleRequestStream?.bind(inner);
    return {
      handleRequest: (req) => call(() => inner.handleRequest(req)),
      ...(stream ? {
        handleRequestStream: (req, callbacks) => call(() => stream(req, {
          ...callbacks,
          onResponseChunk: (chunk) => {
            // Read before the loop decides what the buyer sees: an Anthropic
            // stream reports its input in message_start, which the loop hides
            // after the first call.
            const usage = usageOf(this._upstream.push(chunk.data));
            if (usage) this._latest = { ...this._latest, ...usage };
            callbacks.onResponseChunk(chunk);
          },
        })),
      } : {}),
    };
  }

  /**
   * The buyer's callbacks, with the usage of the earlier calls added to every
   * usage event forwarded from a later call. The first call's stream is
   * forwarded as it is.
   */
  forward(callbacks: ProviderStreamCallbacks): ProviderStreamCallbacks {
    return {
      ...callbacks,
      onResponseChunk: (chunk) => {
        if (this._calls < 2) return callbacks.onResponseChunk(chunk);
        let text = this._forwarded.push(chunk.data);
        if (chunk.done) text += this._forwarded.flush();
        // Part of a line: it is sent with the rest of its line.
        else if (!text && chunk.data.length > 0) return;
        const earlier = this._earlier;
        const summed = earlier
          ? mapUsage(text, (usage) => addUsage(earlier, { ...this._latest, ...usage }))
          : text;
        callbacks.onResponseChunk({ ...chunk, data: encoder.encode(summed) });
      },
    };
  }

  /** The loop's response, reporting the usage of all its calls where it reported the last call's. */
  total(response: SerializedHttpResponse): SerializedHttpResponse {
    if (this._calls < 2 || !this._earlier || !this._latest || !response.body) return response;
    const total = addUsage(this._earlier, this._latest);
    const text = decoder.decode(response.body);
    const summed = mapUsage(text, () => total);
    return summed === text ? response : { ...response, body: encoder.encode(summed) };
  }
}
