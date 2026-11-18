import type {FaqItem} from '../../parts/Faq';

export const QUESTIONS: readonly FaqItem[] = [
  {
    question: 'What is the main difference between Antseed and OpenRouter?',
    answer: "OpenRouter is a centralized aggregator; Antseed is a peer-to-peer network. OpenRouter curates which providers are listed and routes every request through their servers. Antseed lets any provider join permissionlessly, and requests go directly from the buyer's local gateway to the provider.",
  },
  {
    question: 'Do I need an account to use Antseed?',
    answer: 'No. Antseed has no sign-up, no email, and no platform-issued API keys. A local gateway connects you to the peer-to-peer network, and payments settle on-chain in USDC.',
  },
  {
    question: 'How does Antseed handle payments compared to OpenRouter?',
    answer: "OpenRouter uses credit card top-ups and holds provider earnings until a payout. Antseed settles each request on-chain in USDC, directly to the provider's wallet. There is no platform escrow.",
  },
  {
    question: 'Is Antseed OpenAI SDK compatible like OpenRouter?',
    answer: 'Yes. Point the OpenAI SDK base_url at your local Antseed gateway (http://localhost:8377/v1 by default). Existing OpenAI or OpenRouter code works with no changes beyond the URL.',
  },
];
