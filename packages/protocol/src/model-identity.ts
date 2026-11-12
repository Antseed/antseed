/** Trailing "coding only" restriction suffix on an advertised service id. */
export const CODING_ONLY_SUFFIX_RE = /(?:[-:._\s]+coding[-:._\s]+only|codingonly)$/i;

/**
 * Strip cosmetic decorations shared by canonical keys and display names:
 * vendor paths, `latest` and trailing release dates, flattened
 * anthropic/openai prefixes, Claude family reordering, and the coding-only
 * suffix on Claude family models. Exported for display naming in
 * `@antseed/node`; routing should compare `canonicalModelKey` instead.
 */
export function stripModelDecorations(value: string): string {
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
