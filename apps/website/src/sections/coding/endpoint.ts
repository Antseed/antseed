import type {Feature} from '../../parts/FeatureList';
import type {TerminalBlock} from '../../parts/Terminal/Terminal';
import {flag, shell, sub, value} from '../../parts/Terminal/tokens';

export const POINTS: readonly Feature[] = [
  {icon: 'plug', text: 'Keep your tool. Swap the model and provider underneath.'},
  {icon: 'check', text: 'Fallback the moment a provider is slow, expensive, or down.'},
  {icon: 'directions', text: 'Route by price, speed, reputation, or privacy.'},
  {icon: 'analytics', text: 'Pay per request, straight to the provider. No subscription.'},
];

/** Commands from the integration guides. */
export const BLOCKS: readonly TerminalBlock[] = [
  {comment: '# Run Claude Code through Antseed', lines: [shell('antseed', sub('claude'))]},
  {comment: '# Codex, pinned to one model for this run', lines: [shell('antseed', sub('codex'), flag('--model'), value('deepseek-v4-flash'))]},
  {comment: '# OpenCode on an open model', lines: [shell('antseed', sub('opencode'), flag('--model'), value('gpt-oss-120b'))]},
];
