/**
 * Think markup a seller leaks at the start of an answer's text: some chat servers split the model's reasoning
 * out of `content` but leave its closing tag behind (`</mm:think>`, alone or before the text), or leave a whole
 * `<think>…</think>` block in. Only the very start of the text is read, after optional whitespace, so a tag in
 * the middle of an answer, in code, or in an explanation of the tags is never touched.
 */

const THINK_TAGS = ['think', 'mm:think'] as const;

export interface ThinkMarkupPiece {
  kind: 'text' | 'reasoning';
  text: string;
}

export interface LeadingThinkMarkupFilter {
  /** The text and reasoning that `delta` decides; text that could still be the start of a tag is held back. */
  push(delta: string): ThinkMarkupPiece[];
  /**
   * What is held, now that a tool call starts, so it keeps its place before the call. Text so far is text; an
   * open block is reasoning (the model thought, then acted), and so is what follows until it closes.
   */
  release(): ThinkMarkupPiece[];
  /**
   * What is still held when the answer ends. A block that never closed is reasoning when the turn went on
   * (`turnEnded` false: the answer was cut off, or called a tool); in an answer that finished there, it was the
   * answer's own text (`<think> is the tag…`) and comes back whole, opening tag included.
   */
  end(turnEnded: boolean): ThinkMarkupPiece[];
}

const LEADING_WHITESPACE = /^\s*/;

/** Strips a leading think block or a lone closing think tag from an answer's text, streamed delta by delta. */
export function createLeadingThinkMarkupFilter(): LeadingThinkMarkupFilter {
  // start: still deciding whether the text opens with a tag. block: inside a leading <tag>…</tag>, held whole
  // until it closes or a tool call settles it. thinking: a block a tool call settled as reasoning, still open.
  // afterTag: a tag was dropped; whitespace after it is dropped too. text: the rest passes as it comes.
  let state: 'start' | 'block' | 'thinking' | 'afterTag' | 'text' = 'start';
  let held = '';
  let closeTag = '';
  // The whitespace and opening tag of a held block, given back if the block turns out to be text.
  let blockOpening = '';

  const afterTag = (rest: string, pieces: ThinkMarkupPiece[]): void => {
    state = 'afterTag';
    const text = rest.replace(LEADING_WHITESPACE, '');
    if (text.length === 0) return;
    state = 'text';
    pieces.push({ kind: 'text', text });
  };

  const inBlock = (pieces: ThinkMarkupPiece[]): void => {
    const end = held.indexOf(closeTag);
    if (end >= 0) {
      const reasoning = held.slice(0, end);
      const rest = held.slice(end + closeTag.length);
      held = '';
      blockOpening = '';
      if (reasoning.length > 0) pieces.push({ kind: 'reasoning', text: reasoning });
      afterTag(rest, pieces);
      return;
    }
    if (state === 'block') return;
    // Settled as reasoning: it streams, holding back only what could be the start of the closing tag.
    const keep = partialSuffixLength(held, closeTag);
    if (held.length > keep) pieces.push({ kind: 'reasoning', text: held.slice(0, held.length - keep) });
    held = held.slice(held.length - keep);
  };

  const atStart = (pieces: ThinkMarkupPiece[]): void => {
    const start = held.slice(held.match(LEADING_WHITESPACE)![0].length);
    for (const tag of THINK_TAGS) {
      if (start.startsWith(`</${tag}>`)) {
        held = '';
        afterTag(start.slice(tag.length + 3), pieces);
        return;
      }
      if (start.startsWith(`<${tag}>`)) {
        state = 'block';
        closeTag = `</${tag}>`;
        blockOpening = held.slice(0, held.length - start.length + tag.length + 2);
        held = start.slice(tag.length + 2);
        inBlock(pieces);
        return;
      }
    }
    if (start.length === 0 || THINK_TAGS.some((tag) => `<${tag}>`.startsWith(start) || `</${tag}>`.startsWith(start))) return;
    state = 'text';
    pieces.push({ kind: 'text', text: held });
    held = '';
  };

  return {
    push(delta) {
      const pieces: ThinkMarkupPiece[] = [];
      if (delta.length === 0) return pieces;
      if (state === 'text') return [{ kind: 'text', text: delta }];
      if (state === 'afterTag') {
        afterTag(delta, pieces);
        return pieces;
      }
      held += delta;
      if (state === 'block' || state === 'thinking') inBlock(pieces);
      else atStart(pieces);
      return pieces;
    },
    release() {
      if (state === 'block') {
        state = 'thinking';
        blockOpening = '';
        const pieces: ThinkMarkupPiece[] = [];
        inBlock(pieces);
        return pieces;
      }
      if (state !== 'start' || held.length === 0) return [];
      // The start stays undecided: a lone closing tag right after the call is still the seller's markup.
      const text = held;
      held = '';
      return [{ kind: 'text', text }];
    },
    end(turnEnded) {
      const open = state === 'block' || state === 'thinking';
      const asText = state === 'block' && turnEnded;
      const rest = asText ? blockOpening + held : held;
      held = '';
      blockOpening = '';
      if (rest.length === 0) return [];
      return [{ kind: open && !asText ? 'reasoning' : 'text', text: rest }];
    },
  };
}

/**
 * A whole answer text without its leading think markup, and the reasoning a leading block held. `turnEnded`:
 * the answer finished without a tool call (see `LeadingThinkMarkupFilter.end`).
 */
export function stripLeadingThinkMarkup(text: string, turnEnded: boolean): { text: string; reasoning: string } {
  const filter = createLeadingThinkMarkupFilter();
  const pieces = [...filter.push(text), ...filter.end(turnEnded)];
  return {
    text: pieces.filter((piece) => piece.kind === 'text').map((piece) => piece.text).join(''),
    reasoning: pieces.filter((piece) => piece.kind === 'reasoning').map((piece) => piece.text).join(''),
  };
}

/** How many characters at the end of `text` could be the start of `tag`. */
function partialSuffixLength(text: string, tag: string): number {
  for (let length = Math.min(text.length, tag.length - 1); length > 0; length--) {
    if (tag.startsWith(text.slice(text.length - length))) return length;
  }
  return 0;
}
