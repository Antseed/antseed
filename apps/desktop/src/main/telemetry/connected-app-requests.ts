/**
 * Pure matcher for connected-app first-request detection; kept free of
 * Electron imports so it runs under node --test.
 */
/** True when a conversation for one of `slugs` was active at or after `sinceMs`. */
export function conversationsShowRequestSince(
  conversations: unknown,
  slugs: readonly string[],
  sinceMs: number,
): boolean {
  if (!Array.isArray(conversations) || slugs.length === 0) return false;
  const wanted = new Set(slugs.map((slug) => slug.toLowerCase()));
  return conversations.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const record = entry as Record<string, unknown>;
    return typeof record['tool'] === 'string'
      && wanted.has(record['tool'].toLowerCase())
      && typeof record['lastActiveAt'] === 'number'
      && record['lastActiveAt'] >= sinceMs;
  });
}
