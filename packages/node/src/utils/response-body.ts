import { extractUsage, type TokenUsage } from '@antseed/api-adapter';

/**
 * A response body's cost is the seller's own: whatever an upstream API says
 * the request cost the seller (DeepInfra's `usage.estimated_cost`,
 * OpenRouter's `usage.cost`, `cost_details`, `is_byok` and its top-level
 * `provider`) is dropped, and `usage.estimated_cost` is set to what the seller
 * charges for the tokens, in USD. A buyer pays the seller's prices; the
 * seller's own costs and suppliers stay with the seller.
 */
const UPSTREAM_USAGE_FIELDS = ['estimated_cost', 'cost', 'cost_details', 'is_byok', 'upstream_inference_cost'];

/** What the seller charges for a request's tokens, in USD; absent when the price is not per token. */
export type SellerCost = (usage: TokenUsage) => number;

const encoder = new TextEncoder();

/** The usage objects a response or stream event carries (top level, Responses API, Anthropic stream start). */
function usageObjects(record: Record<string, unknown>): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  for (const holder of [record, record['response'], record['message']]) {
    const usage = holder && typeof holder === 'object' ? (holder as Record<string, unknown>)['usage'] : undefined;
    if (usage && typeof usage === 'object' && !Array.isArray(usage)) found.push(usage as Record<string, unknown>);
  }
  return found;
}

function roundUsd(value: number): number {
  return Math.round(value * 1e12) / 1e12;
}

/**
 * Rewrites a parsed response object in place; whether anything changed.
 * `usage` is the token count to price (a stream's running totals), when known.
 */
function rewrite(value: unknown, cost: SellerCost | undefined, usage?: TokenUsage): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  let changed = false;
  for (const target of usageObjects(record)) {
    for (const field of UPSTREAM_USAGE_FIELDS) {
      if (field in target) {
        delete target[field];
        changed = true;
      }
    }
    if (cost) {
      target['estimated_cost'] = roundUsd(cost(usage ?? extractUsage(record)));
      changed = true;
    }
  }
  if (typeof record['provider'] === 'string' && 'choices' in record) {
    delete record['provider'];
    changed = true;
  }
  return changed;
}

function mayCarryCost(text: string): boolean {
  return text.includes('"usage"') || text.includes('"provider"');
}

/** A JSON response body priced at the seller's own cost; other bodies unchanged. */
export function exposedJsonBody(body: Uint8Array, cost?: SellerCost): Uint8Array {
  const text = new TextDecoder().decode(body);
  if (!mayCarryCost(text)) return body;
  try {
    const parsed: unknown = JSON.parse(text);
    return rewrite(parsed, cost) ? encoder.encode(JSON.stringify(parsed)) : body;
  } catch {
    return body;
  }
}

/** A received line and the line ending it came with (CRLF, LF or CR; none at the stream's end). */
interface SseLine {
  text: string;
  eol: string;
}

const LINE_END = /\r\n|\r|\n/g;

/**
 * Rewrites a server-sent event stream as it passes, so events keep flowing as
 * they arrive; a line split across chunks waits for its end. An event whose
 * JSON spans several `data:` lines (joined with newlines, as SSE defines) is
 * held until the blank line that ends it, then rewritten whole.
 * Usage can arrive in parts (Anthropic sends input counts at the start and
 * output counts at the end), so each usage event is priced on the running
 * totals, the way the seller meters the stream.
 */
export class ExposedSseStream {
  private _pending = '';
  /** The last line ended in CR at a chunk's end, so a LF opening the next chunk completes its CRLF. */
  private _afterCr = false;
  /** The lines of an event whose data did not parse on its first line. */
  private _held: SseLine[] = [];
  // Each stream decodes on its own, since a character split across chunks
  // leaves partial bytes in the decoder until the next chunk.
  private readonly _decoder = new TextDecoder();
  private readonly _totals: TokenUsage = { inputTokens: 0, outputTokens: 0, freshInputTokens: 0, cachedInputTokens: 0 };

  constructor(private readonly _cost?: SellerCost) {}

  push(data: Uint8Array): Uint8Array {
    let text = this._pending + this._decoder.decode(data, { stream: true });
    const out: SseLine[] = [];
    if (this._afterCr && text.length > 0) {
      this._afterCr = false;
      if (text.startsWith('\n')) {
        text = text.slice(1);
        // The CR's line was already sent, or is still held with its event.
        if (this._held.length > 0) this._held[this._held.length - 1]!.eol += '\n';
        else out.push({ text: '', eol: '\n' });
      }
    }
    let start = 0;
    for (const match of text.matchAll(LINE_END)) {
      out.push(...this._line({ text: text.slice(start, match.index), eol: match[0] }));
      start = match.index + match[0].length;
    }
    this._pending = text.slice(start);
    if (start > 0 && start === text.length && text.endsWith('\r')) this._afterCr = true;
    return toBytes(out);
  }

  flush(): Uint8Array {
    const rest = this._pending + this._decoder.decode();
    this._pending = '';
    this._afterCr = false;
    const out = rest ? this._line({ text: rest, eol: '' }) : [];
    if (this._held.length > 0) {
      out.push(...this._event(this._held));
      this._held = [];
    }
    return toBytes(out);
  }

  /** The lines to send for one received line: none while its event is held. */
  private _line(line: SseLine): SseLine[] {
    const blank = line.text === '';
    if (this._held.length > 0) {
      if (!blank) {
        this._held.push(line);
        return [];
      }
      const event = this._event(this._held);
      this._held = [];
      return [...event, line];
    }
    if (!line.text.startsWith('data:')) return [line];
    const parsed = parseJson(dataValue(line.text));
    if (parsed === undefined) {
      this._held.push(line);
      return [];
    }
    return [this._rewrite(parsed) ? dataLine(parsed, line) : line];
  }

  /** A held event, its data lines joined and rewritten as one when they form JSON. */
  private _event(lines: SseLine[]): SseLine[] {
    const data = lines.filter((line) => line.text.startsWith('data:'));
    const parsed = parseJson(data.map((line) => dataValue(line.text)).join('\n'));
    if (parsed === undefined || !this._rewrite(parsed)) return lines;
    return lines.flatMap((line) => {
      // The merged line ends the way the event's data did.
      if (line === data[0]) return [dataLine(parsed, data[data.length - 1]!)];
      return line.text.startsWith('data:') ? [] : [line];
    });
  }

  private _rewrite(parsed: unknown): boolean {
    if (parsed && typeof parsed === 'object' && usageObjects(parsed as Record<string, unknown>).length > 0) {
      const usage = extractUsage(parsed as Record<string, unknown>);
      for (const key of Object.keys(this._totals) as (keyof TokenUsage)[]) {
        this._totals[key] = Math.max(this._totals[key], usage[key]);
      }
    }
    return rewrite(parsed, this._cost, { ...this._totals });
  }
}

function toBytes(lines: SseLine[]): Uint8Array {
  return lines.length > 0 ? encoder.encode(lines.map((line) => line.text + line.eol).join('')) : new Uint8Array(0);
}

/** A `data:` field's value, without the one leading space that is not part of it. */
function dataValue(text: string): string {
  const value = text.slice(5);
  return value.startsWith(' ') ? value.slice(1) : value;
}

/** A rewritten payload as a single `data:` line, keeping the original line ending. */
function dataLine(parsed: unknown, original: SseLine): SseLine {
  return { text: `data: ${JSON.stringify(parsed)}`, eol: original.eol };
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
