// Maps a conversation's tool slug + session key to the CLI command that
// reopens that session. Shared between the main process (which launches the
// command in a terminal) and the renderer (which only shows the action for
// tools that have a resume command).

/** Session keys reach the shell — restrict to shell-inert characters. */
const SAFE_SESSION_KEY = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * CLI command that resumes the tool session, or null when the tool has no
 * known resume command (or the session key is not shell-safe). Note the
 * command may still need to run from the chat's project directory — Claude
 * Code and OpenCode look sessions up per project, Codex resumes globally.
 */
export function toolResumeCommand(tool: string, sessionKey: string): string | null {
  if (!SAFE_SESSION_KEY.test(sessionKey)) return null;
  if (tool === 'claude-code' || tool === 'claude-cli') return `claude --resume ${sessionKey}`;
  if (tool === 'opencode') return `opencode --session ${sessionKey}`;
  if (tool === 'codex' || tool.startsWith('codex-')) return `codex resume ${sessionKey}`;
  return null;
}

/**
 * Installed-application name for tools that also ship a desktop app sharing
 * the CLI's session storage — launched app-level (`open -a`), since none of
 * them expose a per-session deep link. Null for terminal-only tools.
 */
export function toolDesktopAppName(tool: string): string | null {
  return toolDesktopAppNames(tool)[0] ?? null;
}

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
