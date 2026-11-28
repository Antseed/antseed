// A word longer than this (in characters) may not fit a phone's column (288px at 320, about 32 mono characters at the
// chip's size), so it is left free to wrap inside instead of being kept whole.
export const KEEP_WHOLE_MAX = 32;

// A chip this short (in characters) stays on one line: a three-word command is easier to read whole than cut.
export const ONE_LINE_MAX = 24;

// A word may break after one of its punctuation marks, never at a hyphen (`--no-buyer` stays whole); a word kept whole breaks
// nowhere else.
export type Piece = {text: string; whole: boolean; parts: string[]};

// Splits an inline code chip into its words and the spaces between them: a short word is kept whole, a space is where the
// chip may break; a word lists the parts it may break between (after `.`, `_`, `/`, `:`, `=`, `,` or `|`).
export function words(text: string): Piece[] {
  return text
    .split(/(\s+)/)
    .filter(Boolean)
    .map((part) => {
      const space = /^\s/.test(part);
      return {text: part, whole: !space && part.length <= KEEP_WHOLE_MAX, parts: space ? [part] : part.split(/(?<=[._/:=,|])(?=.)/)};
    });
}

// A part's words: where a table on a phone may also break a long key, between camelCase words (`maxInbound` `Connections`) or
// after a hyphen inside a name (`metadata-` `v2`), never in a flag's leading `--`.
export function softParts(part: string): string[] {
  return part.split(/(?<=[a-z\d])(?=[A-Z])|(?<=[A-Za-z\d]-)(?=[A-Za-z\d])/);
}
