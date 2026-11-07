export interface ToolHint {
  name: string
  envVar: string
}

export const WELL_KNOWN_TOOL_HINTS: ToolHint[] = [
  { name: 'Claude Code', envVar: 'ANTHROPIC_BASE_URL' },
  { name: 'Aider', envVar: 'OPENAI_API_BASE' },
  { name: 'Continue.dev', envVar: 'OPENAI_BASE_URL' },
  { name: 'Codex', envVar: 'OPENAI_BASE_URL' },
]

// OpenAI clients expect the base URL to end in /v1 and append /chat/completions
// themselves. Anthropic clients (and Claude Code) append /v1/messages, so their
// base URL is the proxy root.
const OPENAI_STYLE_ENV_VARS = new Set(['OPENAI_BASE_URL', 'OPENAI_API_BASE'])

/** The base URL a tool should be given for the env var it reads. */
export function toolHintBaseUrl(envVar: string, proxyUrl: string): string {
  const root = proxyUrl.replace(/\/+$/, '')
  return OPENAI_STYLE_ENV_VARS.has(envVar) ? `${root}/v1` : root
}

export function formatToolHints(hints: ToolHint[], proxyUrl: string): string[] {
  return hints.map(hint => `export ${hint.envVar}=${toolHintBaseUrl(hint.envVar, proxyUrl)}   # ${hint.name}`)
}
