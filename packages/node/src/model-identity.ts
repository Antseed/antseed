import { canonicalModelKey, stripModelDecorations } from '@antseed/protocol/model-identity';

// The routing match key lives in @antseed/protocol so packages that only need
// it don't depend on the node SDK; re-exported here for existing callers.
export { CODING_ONLY_SUFFIX_RE, canonicalModelKey, sameCanonicalModel } from '@antseed/protocol/model-identity';

const DISPLAY_TOKEN_CASING: Record<string, string> = {
  ai: 'AI',
  chatgpt: 'ChatGPT',
  deepseek: 'DeepSeek',
  glm: 'GLM',
  gpt: 'GPT',
  llm: 'LLM',
  minimax: 'MiniMax',
  moe: 'MoE',
  openai: 'OpenAI',
  oss: 'OSS',
  xai: 'xAI',
};

const DISPLAY_SLUG_RE = /^[a-z0-9./_:-]+$/;

function titleModelToken(token: string): string {
  const mapped = DISPLAY_TOKEN_CASING[token];
  if (mapped) return mapped;
  if (/^[a-z]\d+(\.\d+)?$/.test(token)) return token.toUpperCase();
  if (/^\d/.test(token)) return token;
  return token.charAt(0).toUpperCase() + token.slice(1);
}

function prettifyModelSlug(value: string): string {
  return stripModelDecorations(value)
    .split(/[-_:/\s]+/)
    .filter(Boolean)
    .map(titleModelToken)
    .join(' ');
}

function takePreferredDecimalVersion(tokens: string[]): string {
  let version = tokens.shift() ?? '';
  if (/^\d$/.test(version) && /^\d$/.test(tokens[0] ?? '')) {
    version = `${version}.${tokens.shift()}`;
  } else if (/^\d{2}$/.test(version)) {
    version = `${version[0]}.${version[1]}`;
  } else {
    const compact = version.match(/^(\d)(\d)([a-z].*)$/);
    if (compact) {
      version = `${compact[1]}.${compact[2]}`;
      tokens.unshift(compact[3] ?? '');
    }
  }
  return version;
}

function preferredGptDisplayName(value: string): string | null {
  const normalized = stripModelDecorations(value);
  if (!/^gpt(?:[-:._\s]|\d)/.test(normalized)) return null;
  const remainder = normalized.slice(3).replace(/^[-:._\s]+/, '');
  if (!/^\d/.test(remainder)) return null;
  const tokens = remainder.split(/[-_:./\s]+/).filter(Boolean);
  if (tokens.length === 0) return 'GPT';
  const version = takePreferredDecimalVersion(tokens);
  const suffix = tokens.map(titleModelToken).join(' ');
  return `GPT ${version}${suffix ? ` ${suffix}` : ''}`.trim();
}

function preferredMiniMaxDisplayName(value: string): string | null {
  const normalized = stripModelDecorations(value);
  if (!/^minimax(?:[-:._\s]|m\d)/.test(normalized)) return null;
  const remainder = normalized.replace(/^minimax[-:._\s]*m?/, '');
  if (!/^\d/.test(remainder)) return null;
  const tokens = remainder.split(/[-_:./\s]+/).filter(Boolean);
  if (tokens.length === 0) return 'MiniMax';
  const version = takePreferredDecimalVersion(tokens);
  const suffix = tokens.map(titleModelToken).join(' ');
  return `MiniMax M${version}${suffix ? ` ${suffix}` : ''}`.trim();
}

function preferredClaudeFamilyDisplayName(value: string): string | null {
  const canonical = canonicalModelKey(value);
  const family = canonical.match(/^(opus|sonnet|haiku|fable)(\d+)(.*)$/);
  if (!family) return null;
  const familyName = titleModelToken(family[1] ?? '');
  const digits = family[2] ?? '';
  const version = digits.length === 2 ? `${digits[0]}.${digits[1]}` : digits;
  const suffix = family[3] ? ` ${titleModelToken(family[3])}` : '';
  return version.startsWith('3')
    ? `Claude ${version} ${familyName}${suffix}`.trim()
    : `Claude ${familyName} ${version}${suffix}`.trim();
}

/**
 * Protocol-wide preferred model display name. Routing identifiers remain
 * untouched; this only gives every client a deterministic human label for
 * equivalent advertised aliases.
 */
export function preferredModelDisplayName(serviceId: string, serviceLabel?: string | null): string {
  const gptName = preferredGptDisplayName(serviceId) ?? preferredGptDisplayName(serviceLabel ?? '');
  if (gptName) return gptName;
  const miniMaxName = preferredMiniMaxDisplayName(serviceId) ?? preferredMiniMaxDisplayName(serviceLabel ?? '');
  if (miniMaxName) return miniMaxName;

  const claudeName = preferredClaudeFamilyDisplayName(serviceId)
    ?? preferredClaudeFamilyDisplayName(serviceLabel ?? '');
  if (claudeName) return claudeName;

  const label = (serviceLabel ?? '').trim();
  if (label && !DISPLAY_SLUG_RE.test(label)) return label;
  const source = label || String(serviceId ?? '').trim();
  if (!source || !DISPLAY_SLUG_RE.test(source)) return source;
  return prettifyModelSlug(source);
}

const PINNED_MODEL_RE = /^(?:0x)?([0-9a-fA-F]{40})@(.+)$/;

/**
 * A request pins a seller with `<peerId>@<model>` (the peer id optionally
 * 0x-prefixed). Returns the model and the lowercase peer id, or null when the
 * value pins no seller. One parser for the gateway's records and the desktop.
 */
export function parsePinnedModel(value: string): { modelId: string; peerId: string } | null {
  const match = PINNED_MODEL_RE.exec(value);
  return match ? { modelId: match[2]!, peerId: match[1]!.toLowerCase() } : null;
}
