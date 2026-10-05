/**
 * Position-aware numeric answer parsing for KBF responses.
 *
 * Answers are extracted from `(N) <number>` lines. Position comes from the
 * `(N)` index, never from the line order, so missing or reordered lines do
 * not shift other answers. Unparseable or missing positions yield null.
 */

/**
 * Matches a line that starts with an answer index: `(3)`, `3)`, `3.`, `(3):`
 * etc. Captures the index and the remainder of the line. `-` is deliberately
 * not a separator so negative answers like `(5)-430` keep their sign.
 */
const ANSWER_LINE_RE = /^\s*\(?\s*(\d{1,4})\s*[)\].:;]+\s*(.*)$/;

/**
 * First numeric token in a string: optional sign, digits with optional
 * thousands-commas, optional decimals, optional scientific exponent.
 * Trailing units (`°C`, `km`, …) and leading prose are tolerated.
 */
const NUMBER_RE = /[-+]?\d[\d,]*(?:\.\d+)?(?:[eE][-+]?\d+)?/;

function parseNumericToken(text: string): number | null {
  const match = NUMBER_RE.exec(text);
  if (!match) {
    return null;
  }
  const cleaned = match[0].replace(/,/g, '');
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

/**
 * Parse a KBF batch response into a position-aligned answer array of length
 * `probeCount`. Index N (1-based in the response) maps to slot N-1.
 * The first parsed value wins if an index repeats.
 */
export function parseKbfAnswers(responseText: string, probeCount: number): Array<number | null> {
  const answers: Array<number | null> = new Array(probeCount).fill(null);
  if (probeCount <= 0) {
    return answers;
  }
  for (const line of responseText.split(/\r?\n/)) {
    const lineMatch = ANSWER_LINE_RE.exec(line);
    if (!lineMatch) {
      continue;
    }
    const index = Number.parseInt(lineMatch[1]!, 10);
    if (!Number.isInteger(index) || index < 1 || index > probeCount) {
      continue;
    }
    if (answers[index - 1] !== null) {
      continue; // first parsed value wins
    }
    answers[index - 1] = parseNumericToken(lineMatch[2] ?? '');
  }
  return answers;
}
