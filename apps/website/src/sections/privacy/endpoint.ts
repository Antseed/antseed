import type {Feature} from '../../parts/FeatureList';
import type {TerminalBlock} from '../../parts/Terminal/Terminal';
import {flag, shell, sub, value} from '../../parts/Terminal/tokens';

export const POINTS: readonly Feature[] = [
  {icon: 'lock', text: 'Anonymous by default: no account, no email, no platform key.'},
  {icon: 'directions', text: 'Route by privacy: set a minimum trust score, prefer TEE-verified\u00a0providers.'},
  {icon: 'check', text: "Verify a provider's TEE on your own machine. No special hardware needed."},
  {icon: 'analytics', text: 'Pay per request in USDC. No subscription tied to your name.'},
];

/** Commands from the Verify a Provider's TEE guide. */
export const BLOCKS: readonly TerminalBlock[] = [
  {comment: '# Verification on, best-effort (the default)', lines: [shell('antseed', sub('buyer'), sub('start'))]},
  {
    comment: '# Strict: refuse to route unless the provider passes',
    lines: [shell('antseed', sub('buyer'), sub('start'), flag('--verifiers'), value('antseed-verifier'), flag('--require-verifier'))],
  },
  {comment: '# Find providers that advertise a TEE verifier', lines: [shell('antseed', sub('network'), sub('browse'))]},
  {comment: "# Inspect a provider's verifier before you trust it", lines: [shell('antseed', sub('network'), sub('peer'), value('<peer-id>'))]},
];
