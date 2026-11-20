import type {JSX} from 'react';
import type {Integration} from '../../integrations/integrations';
import {MonoMark, ToolMark, type ToolName} from '../../parts/ToolMark';
import styles from './IntegrationMark.module.css';

/** Tools the site already draws a mark for. */
const TOOL_MARKS: Partial<Record<string, ToolName>> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  pi: 'Pi',
  openclaw: 'OpenClaw',
  hermes: 'Hermes',
};

/** An integration's logo, 22px, decorative: the site's tool mark, else its logo in the text colour, else its glyph. */
export function IntegrationMark({integration}: {integration: Integration}): JSX.Element {
  const tool = TOOL_MARKS[integration.slug];
  if (tool) return <ToolMark name={tool} />;
  if (integration.logo) return <MonoMark src={`/logos/${integration.logo}`} />;
  return <span className={styles.glyph}>{integration.glyph ?? integration.name[0]}</span>;
}
