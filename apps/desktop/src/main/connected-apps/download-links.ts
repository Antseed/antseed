/** Where to get each app that is not installed yet, for the Apps list's "Download" link. */
const DOWNLOAD_URLS: Readonly<Record<string, string>> = {
  opencode: 'https://opencode.ai/download',
  codex: 'https://developers.openai.com/codex',
  'claude-code': 'https://claude.com/product/claude-code',
  hermes: 'https://hermes-agent.nousresearch.com',
  droid: 'https://factory.ai',
  t3code: 'https://t3.codes',
  pi: 'https://github.com/badlogic/pi-mono',
  crush: 'https://github.com/charmbracelet/crush',
  goose: 'https://block.github.io/goose',
  zed: 'https://zed.dev/download',
};

export function appDownloadUrl(profileName: string): string | null {
  return DOWNLOAD_URLS[profileName] ?? null;
}
