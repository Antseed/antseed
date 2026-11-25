import type {JSX} from 'react';
import {HeadBeside} from '../../parts/HeadBeside';
import {LinkRows, type LinkRow} from '../../parts/LinkRows';
import {ToolMark, type ToolName} from '../../parts/ToolMark';

const app = (name: ToolName, href: string): LinkRow => ({name, href, action: 'Setup guide', label: `${name} setup guide`, mark: <ToolMark name={name} />});

/** One row per coding app, each to its setup guide. */
const APPS: readonly LinkRow[] = [
  app('Claude Code', '/integrations/claude-code/'),
  app('Codex', '/integrations/codex/'),
  app('Cursor', '/docs/tunnels/#use-it-with-cursor'),
  app('OpenCode', '/integrations/opencode/'),
  app('Pi', '/integrations/pi/'),
];

/** Works with the coding apps you already use: the promise beside a row per app. */
export default function Connect(): JSX.Element {
  return (
    <HeadBeside
      cmp="coding/connect"
      id="connect"
      titleId="connect-title"
      title="Works with the coding apps you already use."
      sub="One command launches the tool through Antseed. Your projects, chats, and settings stay the way they were.">
      <LinkRows rows={APPS} />
    </HeadBeside>
  );
}
