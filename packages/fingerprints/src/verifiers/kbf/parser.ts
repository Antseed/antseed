/**
 * Position-aware numeric answer parsing for KBF responses.
 *
 * Answers are extracted from numbered lines in any format a KBF prompt variant
 * emits: `(N)`, `N.`, `N)`, or `QN:` followed by the number. Position comes
 * from the index N, never from the line order, so missing or reordered lines do
 * not shift other answers. Unparseable or missing positions yield null.
 *
 * As in the KBF reference code (`extract_nums`), a line's answer is its last
 * number and a repeated index takes the later line: a model that reasons in its
 * reply ("2) … ran from 1923 to 1924 … published 52 issues") ends a line, and the
 * reply, with its answer.
 */

/**
 * Matches a line that starts with an answer index: `(3)`, `3)`, `3.`, `(3):`,
 * `Q3:`, `Q 3:` etc. Captures the index and the remainder of the line. `-` is
 * deliberately not a separator so negative answers like `(5)-430` keep their
 * sign.
 */
const ANSWER_LINE_RE = /^\s*(?:Q\s*)?\(?\s*(\d{1,4})\s*[)\].:;]+\s*(.*)$/i;

/**
 * Numeric tokens in a string: optional sign, digits with optional
 * thousands-commas, optional decimals, optional scientific exponent.
 * Trailing units (`°C`, `km`, …) and leading prose are tolerated.
 */
const NUMBER_RE = /[-+]?\d[\d,]*(?:\.\d+)?(?:[eE][-+]?\d+)?/g;

function numericValue(token: string): number | null {
  const value = Number.parseFloat(token.replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

/** `3.2 × 10^5`, `3.2x10^-4`, `3.2*10**5`: written-out scientific notation, rewritten as `3.2e5`. */
const TIMES_TEN_POWER_RE = /(\d(?:\.\d+)?)\s*(?:[x×*]|\\times)\s*10\s*(?:\^|\*\*)\s*\(?\s*([-+]?\d+)\s*\)?/gi;

/**
 * Whether the numeric token at `index` is part of a unit, not an answer: an exponent (`m/s^2`,
 * `s^-1`) or a digit glued to letters (`m2`, `CO2`, `s-1`).
 */
function isUnitNumber(text: string, index: number): boolean {
  const before = text.slice(0, index).trimEnd();
  const previous = text[index - 1] ?? '';
  return before.endsWith('^') || before.endsWith('**') || /[A-Za-z\u00b5\u03bc]/.test(previous);
}

/**
 * The last numeric token of a string, as the KBF reference code reads an answer line, skipping
 * numbers that belong to a unit (`9.81 m/s^2` is 9.81, not 2). Falls back to the last token when
 * every number looks like a unit.
 */
function parseNumericToken(text: string): number | null {
  const normalized = text.replace(TIMES_TEN_POWER_RE, (_match, mantissa: string, exponent: string) => `${mantissa}e${exponent}`);
  const tokens = [...normalized.matchAll(NUMBER_RE)];
  if (tokens.length === 0) return null;
  const answer = [...tokens].reverse().find((token) => !isUnitNumber(normalized, token.index!)) ?? tokens[tokens.length - 1]!;
  return numericValue(answer[0]);
}

/**
 * A line that holds only `<number>…</number>`, as some models answer the
 * `1) <number>` format: the tag literally, without the index.
 */
const TAGGED_NUMBER_LINE_RE = /^\s*<number>\s*([^<]*?)\s*<\/number>\s*$/i;

/**
 * Parse a KBF batch response into a position-aligned answer array of length
 * `probeCount`. Index N (1-based in the response) maps to slot N-1, and a
 * repeated index takes the later line, as in the KBF reference code.
 */
export function parseKbfAnswers(responseText: string, probeCount: number): Array<number | null> {
  const answers: Array<number | null> = new Array(probeCount).fill(null);
  if (probeCount <= 0) {
    return answers;
  }
  const lines = responseText.split(/\r?\n/).filter((line) => line.trim() !== '');
  // No index on any line, but exactly one `<number>…</number>` line per probe:
  // the lines are the answers in order.
  if (lines.length === probeCount
    && lines.every((line) => TAGGED_NUMBER_LINE_RE.test(line) && !ANSWER_LINE_RE.test(line))) {
    return lines.map((line) => parseNumericToken(TAGGED_NUMBER_LINE_RE.exec(line)![1] ?? ''));
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
    answers[index - 1] = parseNumericToken(lineMatch[2] ?? '');
  }
  return answers;
}

/** Words a short unit may add after an answer (`°C`, `m/s`, `days`). */
const MAX_UNIT_WORDS = 3;

/**
 * True when a reply is only the numbered answers: every line is an answer line
 * holding one number and at most a short unit, apart from one heading line
 * ("Here are the answers:"). A reply that reasons ("2) … ran from 1923 to 1924 …
 * published 52 issues") is not. Thinking discovery requires this, since a
 * strategy that moves the model's reasoning into its reply reports no reasoning
 * tokens.
 */
export function isKbfAnswersOnlyReply(responseText: string): boolean {
  let otherLines = 0;
  for (const raw of responseText.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || /^```/.test(line)) continue;
    if (TAGGED_NUMBER_LINE_RE.test(line)) continue;
    const lineMatch = ANSWER_LINE_RE.exec(line);
    if (!lineMatch) {
      otherLines += 1;
      if (otherLines > 1) return false;
      continue;
    }
    const rest = (lineMatch[2] ?? '').replace(/<\/?number>/gi, ' ');
    const tokens = rest.match(NUMBER_RE) ?? [];
    if (tokens.length === 0) continue;
    const words = rest.replace(NUMBER_RE, ' ').split(/\s+/).filter((word) => /[\p{L}]/u.test(word));
    if (words.length > MAX_UNIT_WORDS) return false;
  }
  return true;
}
