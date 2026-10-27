/**
 * Pure matcher for connected-app first-request detection; kept free of
 * Electron imports so it runs under node --test.
 */
/**
 * Requests carry the app's slug or a variant of it (Codex reports
 * `codex-exec`, `codex-desktop`, `codex-cli-rs`), so a variant counts too;
 * `codexfoo` does not.
 */
function toolMatchesSlug(tool: string, slug: string): boolean {
  return tool === slug || tool.startsWith(`${slug}-`);
}

/** True when a conversation for one of `slugs` was active at or after `sinceMs`. */
export function conversationsShowRequestSince(
  conversations: unknown,
  slugs: readonly string[],
  sinceMs: number,
): boolean {
  if (!Array.isArray(conversations) || slugs.length === 0) return false;
  const wanted = slugs.map((slug) => slug.toLowerCase()).filter((slug) => slug.length > 0);
  return conversations.some((entry) => {
    if (!entry || typeof entry !== 'object') return false;
    const record = entry as Record<string, unknown>;
    return typeof record['tool'] === 'string'
      && wanted.some((slug) => toolMatchesSlug((record['tool'] as string).toLowerCase(), slug))
      && typeof record['lastActiveAt'] === 'number'
      && record['lastActiveAt'] >= sinceMs;
  });
}
