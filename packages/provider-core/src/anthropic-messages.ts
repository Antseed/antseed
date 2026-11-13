import type { RelayConfig } from './http-relay.js';

/** The Messages API version sent for a request that names none. */
export const ANTHROPIC_DEFAULT_VERSION = '2023-06-01';

const SAMPLING_FIELDS = ['temperature', 'top_p', 'top_k'] as const;

/**
 * First version of each Claude family that accepts only the default sampling
 * values, so a request that sets one gets a 400. Dropping the fields there
 * changes nothing the model would have done. Older models still honor them.
 */
const SAMPLING_REMOVED_SINCE: Record<string, readonly [major: number, minor: number]> = {
  opus: [4, 7],
  sonnet: [5, 0],
  haiku: [5, 0],
};

// `claude-<family>-<major>[-<minor>]`, with any vendor prefix and any release
// date or `latest` after it. A date is not read as a version: it has more than
// two digits, and neither is a size suffix such as `-32k`. `claude-3-5-sonnet-...`
// puts the version first and is older than every threshold, so it does not match.
const CLAUDE_MODEL_RE = /claude[-._](opus|sonnet|haiku)[-._](\d{1,2})(?:[-._](\d{1,2}))?(?![\da-z])/;
// Every Fable and Mythos model accepts only the defaults, `claude-mythos-preview` included.
const CLAUDE_FABLE_OR_MYTHOS_RE = /claude[-._](fable|mythos)(?![a-z])/;

/**
 * The sampling fields Anthropic rejects for this model. Empty for a model that
 * accepts them and for an id that names no Claude model.
 */
export function anthropicRejectedSamplingFields(model: string | undefined): readonly string[] {
  const id = String(model ?? '').trim().toLowerCase();
  if (CLAUDE_FABLE_OR_MYTHOS_RE.test(id)) return SAMPLING_FIELDS;
  const match = CLAUDE_MODEL_RE.exec(id);
  if (!match) return [];
  const since = SAMPLING_REMOVED_SINCE[match[1]!]!;
  const major = Number(match[2]);
  const minor = Number(match[3] ?? 0);
  return major > since[0] || (major === since[0] && minor >= since[1]) ? SAMPLING_FIELDS : [];
}

/**
 * Relay settings for an upstream that is the Anthropic API: a request without
 * `anthropic-version` gets the default one, and a Messages request loses the
 * sampling fields its model rejects. A request on an API version that rejects
 * them for a model that still honors them is left alone: dropping them there
 * would change the output, so the upstream's own error goes back to the buyer.
 */
export const anthropicMessagesRelay = {
  defaultHeaders: { 'anthropic-version': ANTHROPIC_DEFAULT_VERSION },
  omitJsonFields: ({ path, model }) => (path === '/v1/messages' ? anthropicRejectedSamplingFields(model) : []),
} satisfies Pick<RelayConfig, 'defaultHeaders' | 'omitJsonFields'>;
