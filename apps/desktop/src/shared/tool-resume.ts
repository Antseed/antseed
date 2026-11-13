/**
 * All installed-application names a tool may ship under, preferred first.
 * T3 Code releases per-channel apps (stable/Alpha/Beta/Nightly) that share
 * the same config, so any installed variant is a valid target.
 */
export function toolDesktopAppNames(tool: string): string[] {
  if (tool === 'opencode') return ['OpenCode'];
  // Codex's desktop experience ships inside the ChatGPT app, which shares
  // the CLI's session storage.
  if (tool === 'codex' || tool.startsWith('codex-')) return ['ChatGPT'];
  // Goose Desktop and the goose CLI share ~/.config/goose; Zed is app-only.
  if (tool === 'goose') return ['Goose'];
  if (tool === 'zed') return ['Zed'];
  if (tool === 't3code') return ['T3 Code', 'T3 Code (Alpha)', 'T3 Code (Beta)', 'T3 Code (Nightly)'];
  if (tool === 'gooeypi') return ['GooeyPi'];
  if (tool === 'hermes') return ['Hermes'];
  if (tool === 'cursor') return ['Cursor'];
  return [];
}
