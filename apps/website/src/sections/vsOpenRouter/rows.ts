import type {CompareRow} from '../../parts/CompareTable';

/** Antseed, then OpenRouter, per dimension. */
export const ROWS: readonly CompareRow[] = [
  {label: 'Architecture', cells: ['Peer-to-peer network. Requests go direct from buyer to provider.', 'Centralized aggregator. Every request flows through their servers.']},
  {label: 'Provider onboarding', cells: ["Permissionless. Run the node binary; you're live.", 'Approval-based. Models curated by the platform.']},
  {label: 'Payments', cells: ['On-chain USDC, per request, settled directly to provider wallet.', 'Credit card top-ups. Platform holds earnings until payout.']},
  {label: 'Account required', cells: ['No. No email, no API keys issued by a platform.', 'Yes. Sign-up, API key issuance, account-level limits.']},
  {label: 'Platform fee', cells: ['Provider sets the price. Network fees may support ecosystem mechanisms.', 'Platform fee on top of provider pricing.']},
  {
    label: 'Request privacy',
    cells: ['Prompts go peer-to-peer without a central platform account. Independent providers and infrastructure may still process or observe data.', 'Every prompt transits their infrastructure.'],
  },
  {
    label: 'Can be shut down',
    cells: ['Open peer-to-peer software. Independent nodes may continue without reliance on one hosted service.', 'Single company can be sued, acquired, or deplatformed.'],
  },
  {label: 'OpenAI SDK compatible', cells: ['Yes. Point base_url at your local gateway.', 'Yes.']},
  {label: 'Agent-ready', cells: ['Designed for it. USDC-native, no account, always-on discovery.', 'Works via API key, but the account model assumes a human operator.']},
];
