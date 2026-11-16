export type SensitiveChatArtifact =
  | { type: 'wallet-address'; value: string; chainHint: string };

export type ChatTextSegment =
  | { type: 'text'; text: string }
  | { type: 'artifact'; artifact: SensitiveChatArtifact };

type MatchCandidate = {
  start: number;
  end: number;
  artifact: SensitiveChatArtifact;
  priority: number;
};

const ZERO_WIDTH_CHARS = /[\u200B-\u200D\uFEFF]/g;
const EVM_ADDRESS_PATTERN = /\b0x[a-fA-F0-9]{40}\b/g;
const BITCOIN_ADDRESS_PATTERN = /\b(?:bc1[ac-hj-np-z02-9]{25,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})\b/gi;
const COSMOS_ADDRESS_PATTERN = /\b[a-z]{2,16}1[0-9a-z]{38,58}\b/gi;
// Broad enough to catch common Solana/base58 addresses, but constrained to avoid
// ordinary prose: base58 only, 32-44 chars, and at least one digit. Case is not
// required — real base58 addresses with no uppercase letter are valid and must
// still trigger the safety gate; recall matters more than precision here.
const SOLANA_ADDRESS_PATTERN = /\b(?=[1-9A-HJ-NP-Za-km-z]{32,44}\b)(?=[1-9A-HJ-NP-Za-km-z]*\d)[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;

function stripZeroWidthChars(text: string): string {
  return text.replace(ZERO_WIDTH_CHARS, '');
}

function pushRegexMatches(
  candidates: MatchCandidate[],
  text: string,
  pattern: RegExp,
  chainHint: string,
  priority: number,
): void {
  pattern.lastIndex = 0;
  for (const match of text.matchAll(pattern)) {
    const value = match[0];
    if (!value || match.index === undefined) continue;
    candidates.push({
      start: match.index,
      end: match.index + value.length,
      artifact: { type: 'wallet-address', value, chainHint },
      priority,
    });
  }
}

function collectSensitiveArtifacts(text: string): MatchCandidate[] {
  const candidates: MatchCandidate[] = [];

  pushRegexMatches(candidates, text, EVM_ADDRESS_PATTERN, 'EVM', 5);
  pushRegexMatches(candidates, text, BITCOIN_ADDRESS_PATTERN, 'Bitcoin', 4);
  pushRegexMatches(candidates, text, COSMOS_ADDRESS_PATTERN, 'Cosmos', 3);
  pushRegexMatches(candidates, text, SOLANA_ADDRESS_PATTERN, 'wallet-like', 2);

  candidates.sort((a, b) => a.start - b.start || b.priority - a.priority || (b.end - b.start) - (a.end - a.start));

  const selected: MatchCandidate[] = [];
  let cursor = 0;
  for (const candidate of candidates) {
    if (candidate.start < cursor) continue;
    selected.push(candidate);
    cursor = candidate.end;
  }
  return selected;
}

export function segmentSensitiveChatText(text: string): ChatTextSegment[] {
  const cleanText = stripZeroWidthChars(text);
  if (!cleanText) return [{ type: 'text', text: '' }];
  const matches = collectSensitiveArtifacts(cleanText);
  if (matches.length === 0) return [{ type: 'text', text: cleanText }];

  const segments: ChatTextSegment[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.start > cursor) {
      segments.push({ type: 'text', text: cleanText.slice(cursor, match.start) });
    }
    segments.push({ type: 'artifact', artifact: match.artifact });
    cursor = match.end;
  }
  if (cursor < cleanText.length) {
    segments.push({ type: 'text', text: cleanText.slice(cursor) });
  }
  return segments;
}

export function findSensitiveChatArtifacts(text: string): SensitiveChatArtifact[] {
  return collectSensitiveArtifacts(stripZeroWidthChars(text)).map((match) => match.artifact);
}
