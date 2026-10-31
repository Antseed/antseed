/**
 * Watches a streamed answer as it passes through the seller: when the first
 * generated token arrives, and whether the stream reports a failure of its
 * own after a 200 start. Understands the OpenAI chat, OpenAI Responses and
 * Anthropic Messages event streams; start events, empty deltas and
 * keepalives are not tokens.
 */
export class StreamOutcome {
  /** When the first event carrying generated output arrived; null until then, and for unknown formats. */
  firstTokenAt: number | null = null;
  /** The stream reported an error after it started (an upstream error event, or the relay's own when the upstream dropped). */
  failed = false;
  private readonly _decoder = new TextDecoder();
  private _partial = '';
  private _event = '';

  observe(data: Uint8Array, now = Date.now()): void {
    if (data.length === 0) return;
    const lines = (this._partial + this._decoder.decode(data, { stream: true })).split('\n');
    this._partial = lines.pop() ?? '';
    for (const raw of lines) this._line(raw.endsWith('\r') ? raw.slice(0, -1) : raw, now);
  }

  private _line(line: string, now: number): void {
    if (line === '') {
      this._event = '';
      return;
    }
    if (line.startsWith('event:')) {
      this._event = line.slice(6).trim();
      if (this._event === 'error') this.failed = true;
      return;
    }
    if (!line.startsWith('data:')) return;
    const payload = line.slice(5).trim();
    if (payload === '' || payload === '[DONE]' || this._event === 'error') return;
    // Once the first token is in, only an error is worth parsing for.
    if (this.firstTokenAt !== null && !payload.includes('"error"') && !payload.includes('response.failed')) return;
    let event: unknown;
    try {
      event = JSON.parse(payload);
    } catch {
      return;
    }
    if (!isRecord(event)) return;
    if (isStreamError(event)) this.failed = true;
    else if (this.firstTokenAt === null && carriesGeneratedOutput(event)) this.firstTokenAt = now;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function nonEmpty(value: unknown): boolean {
  return typeof value === 'string' ? value.length > 0 : Array.isArray(value) && value.length > 0;
}

function isStreamError(event: Record<string, unknown>): boolean {
  return event.type === 'error' || event.type === 'response.failed' || isRecord(event.error);
}

function carriesGeneratedOutput(event: Record<string, unknown>): boolean {
  // OpenAI chat completions: content, reasoning or a tool call in a choice's delta.
  if (Array.isArray(event.choices)) {
    return event.choices.some((choice) => {
      const delta = isRecord(choice) && isRecord(choice.delta) ? choice.delta : null;
      return delta !== null && (nonEmpty(delta.content) || nonEmpty(delta.reasoning_content) || nonEmpty(delta.reasoning) || nonEmpty(delta.tool_calls));
    });
  }
  if (typeof event.type !== 'string') return false;
  // Anthropic messages: text, thinking or tool input in a content block delta.
  if (event.type === 'content_block_delta') {
    const delta = isRecord(event.delta) ? event.delta : {};
    return nonEmpty(delta.text) || nonEmpty(delta.thinking) || nonEmpty(delta.partial_json);
  }
  // OpenAI Responses: output text, reasoning or function arguments deltas.
  return event.type.startsWith('response.') && event.type.endsWith('.delta') && nonEmpty(event.delta);
}
