import type {FaqItem} from '../../parts/Faq';

/** Integration, fallback and payment. */
export const QUESTIONS: readonly FaqItem[] = [
  {
    question: 'Do I have to change my code?',
    answer: <>If your app uses the OpenAI or Anthropic API, start by updating the API address, key, and model. The gateway supports Chat Completions, Responses, and Messages. Features such as tool calling depend on the model and provider, so test the features your app uses before switching production traffic. <a href="/docs/gateway/api/#sdks">See code examples →</a></>,
  },
  {
    question: 'What happens if a provider fails?',
    answer: <>With automatic routing, retryable provider failures can move to another eligible provider. Fallback does not happen after streaming starts or when you pin a specific provider. If no eligible provider can serve, your app receives an error. <a href="/docs/api/routing/">How fallback works →</a></>,
  },
  {
    question: 'Do I need crypto to pay?',
    answer: <>No. Top up by card from the console, or use USDC if you prefer. Provider payments settle in USDC on Base. <a href="/docs/gateway/funding/">How funding works →</a></>,
  },
];
