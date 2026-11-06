/**
 * Position-aware numeric answer parsing for KBF responses.
 *
 * Answers are extracted from numbered lines in any format a KBF prompt variant
 * emits: `(N)`, `N.`, `N)`, or `QN:` followed by the number. Position comes
 * from the index N, never from the line order, so missing or reordered lines do
 * not shift other answers. Unparseable or missing positions yield null.
 *
 * Like `extract_nums` in the KBF reference code, a line's answer is its last
 * number and a repeated index takes the later line: a model that reasons in its
 * reply ("2) … ran from 1923 to 1924 … published 52 issues") ends a line, and the
 * reply, with its answer. A Unicode minus sign is read as `-`, as there.
 *
 * Where this parser differs from `extract_nums`: it also accepts `QN:` and
 * `(N):` labels; it reads written-out scientific notation and skips unit
 * exponents; a dash between two numbers is a range, not a sign; and a reply
 * without any index is read in line order only when it has exactly one
 * number-only line per probe (the reference code reads any such reply in order).
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

/**
 * `3.2 × 10^5`, `3.2x10^-4`, `3.2*10**5`, `6.02 \times 10^{23}`, `1.6 · 10^{-19}`: written-out
 * scientific notation, rewritten as `3.2e5`.
 */
const TIMES_TEN_POWER_RE = /(\d(?:\.\d+)?)\s*(?:[x×*·]|\\times|\\cdot)\s*10\s*(?:\^|\*\*)\s*[({]?\s*([-+]?\d+)\s*[)}]?/gi;

/**
 * Whether the numeric token at `index` is part of a unit, not an answer: an exponent, bare or
 * bracketed (`m/s^2`, `s^-1`, `m/s^{2}`, `m s^{-1}`, `m**(2)`), or a digit glued to letters
 * (`m2`, `CO2`, `s-1`).
 */
function isUnitNumber(text: string, index: number): boolean {
  const before = text.slice(0, index).trimEnd().replace(/[({]$/, '').trimEnd();
  const previous = text[index - 1] ?? '';
  return before.endsWith('^') || before.endsWith('**') || /[A-Za-z\u00b5\u03bc]/.test(previous);
}

/**
 * Reads Unicode minus signs as `-`, so `−78.5` is not read as 78.5. U+2212 is always a minus (the
 * KBF reference code replaces it too). Dashes (U+2012, U+2013, U+FE63, U+FF0D) count only where a
 * sign can stand, directly before a digit at the start or after a space, bracket, colon or equals
 * sign: between two numbers (`10–20`) they mark a range.
 */
function normalizeMinus(text: string): string {
  return text
    .replace(/−/g, '-')
    .replace(/(^|[\s([:=~≈])[‒–﹣－](?=\d)/g, '$1-');
}

/** `3.14` is a decimal, not answer 3: a bare `N.` label needs something other than a digit after the dot. */
const BARE_DECIMAL_LINE_RE = /^\s*\d{1,4}\.\d/;

/**
 * The last numeric token of a string, as the KBF reference code reads an answer line, skipping
 * numbers that belong to a unit (`9.81 m/s^2` is 9.81, not 2). Falls back to the last token when
 * every number looks like a unit.
 */
function parseNumericToken(text: string): number | null {
  const normalized = normalizeMinus(text)
    .replace(TIMES_TEN_POWER_RE, (_match, mantissa: string, exponent: string) => `${mantissa}e${exponent}`);
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
  let labelled = false;
  for (const line of responseText.split(/\r?\n/)) {
    if (BARE_DECIMAL_LINE_RE.test(line)) {
      continue;
    }
    const lineMatch = ANSWER_LINE_RE.exec(line);
    if (!lineMatch) {
      continue;
    }
    labelled = true;
    const index = Number.parseInt(lineMatch[1]!, 10);
    if (!Number.isInteger(index) || index < 1 || index > probeCount) {
      continue;
    }
    answers[index - 1] = parseNumericToken(lineMatch[2] ?? '');
  }
  // No label on any line, but exactly one number-only line per probe (`126`, `-138.8 °C`): the
  // lines are the answers in order. Anything else without labels stays unread.
  if (!labelled && lines.length === probeCount && lines.every(isNumberOnlyLine)) {
    return lines.map((line) => parseNumericToken(line));
  }
  return answers;
}

/** A line that is one number with at most a short unit and no label, such as `126` or `-138.8 °C`. */
function isNumberOnlyLine(line: string): boolean {
  const normalized = normalizeMinus(line.trim())
    .replace(TIMES_TEN_POWER_RE, (_match, mantissa: string, exponent: string) => `${mantissa}e${exponent}`);
  const tokens = [...normalized.matchAll(NUMBER_RE)].filter((token) => !isUnitNumber(normalized, token.index!));
  if (tokens.length !== 1) return false;
  const words = normalized.replace(NUMBER_RE, ' ').split(/\s+/).filter((word) => /[\p{L}]/u.test(word));
  return words.length <= MAX_UNIT_WORDS;
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
