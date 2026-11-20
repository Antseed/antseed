import type {Feature} from '../../parts/FeatureList';
import type {TerminalBlock} from '../../parts/Terminal/Terminal';
import {flag, shell, string, sub, value} from '../../parts/Terminal/tokens';

export const POINTS: readonly Feature[] = [
  {icon: 'plug', text: 'Keep your agent. Swap the providers underneath.'},
  {icon: 'check', text: 'Fallback the moment a provider is slow, expensive, or down.'},
  {icon: 'directions', text: 'Route every call by price, speed, reputation, or privacy.'},
  {icon: 'analytics', text: 'Pay per request, straight to the provider. No subscription.'},
];

const exportVar = (name: string, val: string) => [...shell('export', flag(name)), {text: '='}, string(val)];

export const BLOCKS: readonly TerminalBlock[] = [
  {comment: '# Point any agent at your local endpoint', lines: [exportVar('OPENAI_BASE_URL', '"http://localhost:8377/v1"'), exportVar('OPENAI_API_KEY', '"antseed"')]},
  {comment: '# Point OpenClaw at Antseed', lines: [shell('openclaw', sub('models'), sub('set'), value('"antseed/kimi-k2.6"'))]},
  {comment: '# List the models you can route to', lines: [shell('curl', sub('"$OPENAI_BASE_URL/models"'))]},
];
