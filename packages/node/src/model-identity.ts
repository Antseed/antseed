/** Trailing "coding only" restriction suffix on an advertised service id. */
export const CODING_ONLY_SUFFIX_RE = /(?:[-:._\s]+coding[-:._\s]+only|codingonly)$/i;

/**
 * Strip cosmetic decorations shared by canonical keys and display names:
 * vendor paths, `latest` and trailing release dates, flattened
 * anthropic/openai prefixes, Claude family reordering, and the coding-only
 * suffix on Claude family models.
 */
function stripModelDecorations(value: string): string {
  let normalized = String(value ?? '').trim().toLowerCase();
  // Drop only the leading vendor segment: "openai/gpt-5" is "gpt-5", but
  // "bytedance/seedance-2.5/text-to-video" must not collapse into every other
  // "<vendor>/<model>/text-to-video" endpoint. "accounts/x/models/<id>" paths
  // keep only the model id.
  const modelsPath = normalized.match(/^accounts\/[^/]+\/models\/(.+)$/);
  if (modelsPath) normalized = modelsPath[1] ?? '';
  else {
    const slash = normalized.indexOf('/');
    if (slash >= 0) normalized = normalized.slice(slash + 1);
  }
  normalized = normalized.replace(/[-:._\s]+(latest|\d{6,8}|\d{4}-\d{2}(-\d{2})?)$/, '');
  normalized = normalized.replace(/^anthropic[-:._\s]+(?=claude(?:[-:._\s]|\d|$))/, '');
  normalized = normalized.replace(/^openai[-:._\s]+(?=gpt(?:[-:._\s]|\d|$))/, '');
  normalized = normalized.replace(
    /^claude[-:._\s]+(\d+(?:[-:._\s]+\d+)?)[-:._\s]+(opus|sonnet|haiku|fable)(?=([-:._\s]|$))/,
    '$2-$1',
  );
  normalized = normalized.replace(/^claude[-:._\s]+(?=(opus|sonnet|haiku|fable)(?:[-:._\s]|\d|$))/, '');
  if (/^(?:opus|sonnet|haiku|fable)(?:[-:._\s]|\d)/.test(normalized)) {
    normalized = normalized.replace(CODING_ONLY_SUFFIX_RE, '');
  }
  return normalized;
}

/**
 * Normalize advertised model names into a conservative cross-provider match
 * key. Cosmetic separators, vendor paths, `latest`, and trailing release dates
 * are ignored. Known flattened vendor prefixes are ignored only when followed
 * by their established model family. Numeric version punctuation is compacted
 * for established versioned families, covering equivalent forms such as
 * `gpt-5.6`, `gpt-5-6`, and `gpt-56` without changing arbitrary service ids.
 */
export function canonicalModelKey(serviceId: string): string {
  const cached = canonicalKeyCache.get(serviceId);
  if (cached !== undefined) return cached;
  const key = computeCanonicalModelKey(serviceId);
  // Hot path: callers canonicalize the same few hundred advertised service
  // ids over and over (catalog projection, per-row selected checks, routing).
  // The bound only guards against pathological unbounded inputs.
  if (canonicalKeyCache.size >= CANONICAL_KEY_CACHE_LIMIT) canonicalKeyCache.clear();
  canonicalKeyCache.set(serviceId, key);
  return key;
}

const CANONICAL_KEY_CACHE_LIMIT = 8192;
const canonicalKeyCache = new Map<string, string>();

function computeCanonicalModelKey(serviceId: string): string {
  let value = stripModelDecorations(serviceId);
  value = value.replace(/^google[-:._\s]+(?=gemma(?:[-:._\s]|\d|$))/, '');
  value = value.replace(/^aion[-:._\s]+labs[-:._\s]+(?=aion(?:[-:._\s]|\d|$))/, '');
  value = value.replace(/^(?:zai[-:._\s]+org|z[-:._\s]+ai)[-:._\s]+(?=glm(?:[-:._\s]|\d|$))/, '');
  // "stealth-ox-alpha" is the same anonymized preview model as "ox-alpha".
  value = value.replace(/^stealth[-:._\s]+(?=ox[-:._\s]+alpha(?:[-:._\s]|$))/, '');
  const compactVersionPunctuation = /^(?:aion|opus|sonnet|haiku|fable|deepseek|e2ee[-:._\s]*glm|gemini|gemma|glm|gpt|grok|hermes|kimi|llama|mimo|minimax|mistral|qwen|venice[-:._\s]*uncensored)(?:[-:._\s]|\d)/.test(value);
  return compactVersionPunctuation
    ? value.replace(/[^a-z0-9]+/g, '')
    : value.replace(/[^a-z0-9.]+/g, '').replace(/^\.+|\.+$/g, '');
}

export function sameCanonicalModel(a: string, b: string): boolean {
  const keyA = canonicalModelKey(a);
  return keyA.length > 0 && keyA === canonicalModelKey(b);
}

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
