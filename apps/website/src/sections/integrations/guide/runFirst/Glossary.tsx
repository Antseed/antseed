import type {JSX} from 'react';
import Link from '@docusaurus/Link';
import {Code} from '../../../../parts/Ticks';
import styles from './RunFirst.module.css';

/** The terms every integration guide uses, in one list. */
export function Glossary(): JSX.Element {
  return (
    <div className={styles.glossary}>
      <p className={styles.glossaryTitle}>The model in your head</p>
      <ul className={styles.terms}>
        <li>
          <strong>Gateway</strong> - the API server you run with{' '}
          <Code>antseed gateway start</Code> (or in the background with{' '}
          <Code>antseed gateway service install</Code>) or the server installer, at{' '}
          <Code>/v1</Code> on port 8379. It gives every tool its own API key with
          budgets, routing policy and usage logs, and passes requests to a buyer.
          Reach it locally, on your network, behind a{' '}
          <Link to="/docs/tunnels/">tunnel</Link>, or on a server. Tools send the
          key as <Code>Authorization: Bearer</Code>.
        </li>
        <li>
          <strong>Buyer proxy</strong> - the server on{' '}
          <Code>localhost:8377</Code> that finds sellers and pays them, forwarding
          your requests to the Antseed network. It only listens on localhost and
          checks no key, so tools can call it directly only on the same computer;
          everything else goes through a gateway. It speaks{' '}
          <em>all four LLM protocols</em> at once -{' '}
          <Code>/v1/messages</Code> (Anthropic),{' '}
          <Code>/v1/chat/completions</Code> (OpenAI Chat),{' '}
          <Code>/v1/responses</Code> (OpenAI Responses), and{' '}
          <Code>/v1/completions</Code> (legacy) - and translates between them via{' '}
          <a
            href="https://github.com/Antseed/antseed/tree/main/packages/api-adapter"
            target="_blank"
            rel="noreferrer">
            <Code>@antseed/api-adapter</Code>
          </a>
          . So a tool that only knows Anthropic Messages can still reach an OpenAI
          peer (and vice versa).
        </li>
        <li>
          <strong>Peer</strong> - someone selling inference. Every peer has a{' '}
          <Code>peerId</Code> (40-char hex), a display name, and a list of services.
        </li>
        <li>
          <strong>Service</strong> - a single model id like{' '}
          <Code>kimi-k2.6</Code> or <Code>deepseek-v4-flash</Code>. <em>This
          is what you pass as <Code>model</Code> in your tool's config.</em>{' '}
          Each service has its own native protocol list and{' '}
          <Code>in</Code>/<Code>cachedIn</Code>/<Code>out</Code> pricing.
        </li>
        <li>
          <strong>Protocols</strong> (per service) - the wire formats a service
          accepts <em>natively</em>, advertised on each peer in{' '}
          <Code>providerServiceApiProtocols[provider].services[service]</Code>. Values:{' '}
          <Code>anthropic-messages</Code>, <Code>openai-chat-completions</Code>,{' '}
          <Code>openai-responses</Code>, <Code>openai-completions</Code>. <strong>
          This is the field to match your tool against.</strong> If your tool's
          wire format is in this list, traffic passes through untouched. If not,
          the api-adapter translates on the fly.
        </li>
        <li>
          <strong>Cached input pricing</strong> - services charge a separate,
          much lower rate (typically 4–10×) for tokens that are reused across
          requests: system prompts, tool schemas, prior conversation turns, long
          files you keep referencing. The CLI exposes it as{' '}
          <Code>cachedInputUsdPerMillion</Code>. For long-running agents and
          chatbots, this is often the dominant cost line.
        </li>
        <li>
          <strong>Pin</strong> - optionally telling Antseed “route
          requests to <em>this</em> peer.” Without a pin, the buyer
          ranks eligible offers with the same Price + Trust preferences used
          by the desktop and can fail over on retryable peer failures. A
          recognized conversation softly prefers its previous successful
          seller; pin only when you want one specific seller: a session-wide pin via{' '}
          <Code>antseed buyer connection set --peer &lt;id&gt;</Code> (saved to{' '}
          <Code>~/.antseed/buyer.state.json</Code>), or a per-request{' '}
          <Code>x-antseed-pin-peer: &lt;id&gt;</Code> header (no session state
          needed). See Step 4.
        </li>
      </ul>
    </div>
  );
}
