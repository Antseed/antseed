/**
 * Friendly display names for conversation tool slugs.
 *
 * The buyer derives the slug from the wire (the `x-<tool>-session-id` header
 * name, the `originator` header value, or the User-Agent product token), so
 * raw values like 'codex-cli-rs' or 'codex-tui' reach the UI. The slug stays
 * untouched in identity keys and payloads — only the rendered label is
 * prettified here.
 */

const TOOL_DISPLAY_NAMES: Record<string, string> = {
  'claude-code': 'Claude Code',
  droid: 'Droid',
  opencode: 'OpenCode',
  pi: 'pi',
  vpr: 'AI VPN',
  // Chats created before the AntStation → AI VPN rename keep their stored slug.
  antstation: 'AI VPN',
};

export function displayToolName(tool: string): string {
  const known = TOOL_DISPLAY_NAMES[tool];
  if (known) return known;
  // Codex ships several originators (codex_cli_rs, codex_tui, ...) that are
  // all the same product to the user.
  if (tool === 'codex' || tool.startsWith('codex-')) return 'Codex';
  if (!tool || tool === 'unknown') return 'App';
  // Fallback: prettify the slug ('some-tool' -> 'Some Tool').
  return tool
    .split('-')
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}
