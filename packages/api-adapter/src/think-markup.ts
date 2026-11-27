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
  /** Whatever is still held when the answer ends. */
  end(): ThinkMarkupPiece[];
}

const LEADING_WHITESPACE = /^\s*/;

/** Strips a leading think block or a lone closing think tag from an answer's text, streamed delta by delta. */
export function createLeadingThinkMarkupFilter(): LeadingThinkMarkupFilter {
  // start: still deciding whether the text opens with a tag. block: inside a leading <tag>…</tag>.
  // afterTag: a tag was dropped; whitespace after it is dropped too. text: the rest passes as it comes.
  let state: 'start' | 'block' | 'afterTag' | 'text' = 'start';
  let held = '';
  let closeTag = '';

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
      if (reasoning.length > 0) pieces.push({ kind: 'reasoning', text: reasoning });
      afterTag(rest, pieces);
      return;
    }
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
      if (state === 'block') inBlock(pieces);
      else atStart(pieces);
      return pieces;
    },
    end() {
      const rest = held;
      held = '';
      if (rest.length === 0) return [];
      // A start that never became a tag is the answer's text; a block that never closed is reasoning.
      return [{ kind: state === 'block' ? 'reasoning' : 'text', text: rest }];
    },
  };
}

/** A whole answer text without its leading think markup, and the reasoning a leading block held. */
export function stripLeadingThinkMarkup(text: string): { text: string; reasoning: string } {
  const filter = createLeadingThinkMarkupFilter();
  const pieces = [...filter.push(text), ...filter.end()];
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
