import type {LinkRow} from '../../parts/LinkRows';
import {ToolMark, type ToolName} from '../../parts/ToolMark';

const agent = (name: ToolName, text: string, href: string): LinkRow => ({
  name, text, href, action: 'Setup guide', label: `${name} setup guide`, mark: <ToolMark name={name} />,
});

/** One row per supported agent, each to its own setup guide. */
export const AGENT_ROWS: readonly LinkRow[] = [
  agent('Claude Code', "Point Anthropic's CLI at one local address. Same projects, same chats.", '/integrations/claude-code/'),
  agent('Codex', "Run OpenAI's Codex CLI through Antseed with a single command.", '/integrations/codex/'),
  agent('Hermes', 'Register Antseed as a custom provider in your Hermes config.', '/integrations/hermes/'),
  agent('OpenClaw', "Add Antseed to OpenClaw's provider catalog and run any model.", '/integrations/openclaw/'),
  agent('OpenCode', 'Launch OpenCode through Antseed and pick any model on the network.', '/integrations/opencode/'),
  agent('Pi', 'Use your local endpoint as a model provider in Pi.', '/integrations/pi/'),
];
