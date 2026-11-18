import type {FaqItem} from '../../parts/Faq';

/** Grounded in the integration guides, the docs FAQ and the Claude Code pricing post. */
export const QUESTIONS: readonly FaqItem[] = [
  {
    question: 'Do I have to cancel my Claude or ChatGPT plan?',
    answer: 'No. Keep it if it earns its price. When the plan’s window runs out, launch the same tool through Antseed and keep working, then switch back whenever you like. Nothing about your projects or settings changes between the two.',
  },
  {
    question: 'Is it the same model I get on the plan?',
    answer: <>The live board lists what providers serve, including frontier models, each at the provider’s own price. Every response is signed by the provider and matched against the model’s fingerprint; providers who serve something else lose reputation and stop getting routed. <a href="/docs/verify-tee/">How verification works →</a></>,
  },
  {
    question: 'Does Cursor work?',
    answer: <>Yes, through a public endpoint. Some Cursor requests come from Cursor&apos;s own servers, which cannot reach your <code>localhost</code>, so publish an authenticated HTTPS endpoint with <code>antseed tunnel start</code>, then in Cursor&apos;s model settings paste the Antseed key as the OpenAI API key and the endpoint as the OpenAI base URL. <a href="/docs/tunnels/#use-it-with-cursor">Cursor setup →</a></>,
  },
  {
    question: 'How do I pick which model my tool uses?',
    answer: <>Leave it on auto and every request goes to the cheapest verified provider for the model your tool asks for. To pin a model for one run, pass <code>--model &lt;id&gt;</code> to the wrapper, using an id from <code>curl http://localhost:8377/v1/models</code>. To pin a specific provider, use <code>&lt;peerId&gt;@&lt;model&gt;</code>. <a href="/docs/faq/">More questions in the FAQ →</a></>,
  },
];
