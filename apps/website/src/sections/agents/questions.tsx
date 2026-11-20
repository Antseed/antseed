import type {FaqItem} from '../../parts/Faq';

/** The three questions only an agent operator asks; the shared ones live in /docs/faq. */
export const QUESTIONS: readonly FaqItem[] = [
  {
    question: 'Does my agent need an account or API key?',
    answer: <>No account, whether you run Antseed Desktop or the Antseed CLI. Antseed Desktop&apos;s gateway needs a real key: copy the base URL and key from <strong>Use with any other tool</strong> under Agents &amp; apps. The CLI&apos;s local endpoint does not validate a key, but most agent SDKs want a non-empty value, so use a placeholder like <code>antseed</code>. A public endpoint you publish with <code>antseed tunnel start</code> uses a real, generated key.</>,
  },
  {
    question: 'Which agents work with Antseed?',
    answer: <>Anything that speaks the OpenAI or Anthropic API: Hermes, OpenClaw, Claude Code, Codex, OpenCode, Pi, or your own. Hermes and OpenClaw have maintained setup skills; Claude Code, Codex, and OpenCode also have CLI wrappers (<code>antseed claude</code>, <code>antseed codex</code>, <code>antseed opencode</code>). Any other agent uses its custom provider settings with the base URL and key above. <a href="/docs/agents/">Read the agent guide →</a></>,
  },
  {
    question: 'My agent runs on a server. Can it still use Antseed?',
    answer: <>Yes. The simplest way is to install the CLI on that server and start the endpoint next to the agent, so it talks to <code>localhost:8377</code> as usual. If the agent must reach an endpoint on a different machine, publish an authenticated endpoint with <code>antseed tunnel start</code>, using ngrok or Cloudflare, and swap in the URL and key it shows. <a href="/docs/tunnels/">Public HTTPS tunnels guide →</a> <a href="/docs/faq/">More questions in the FAQ →</a></>,
  },
];
