import type {JSX} from 'react';
import Link from '@docusaurus/Link';
import styles from './RunFirst.module.css';

/** The terms every integration guide uses, in one list. */
export function Glossary(): JSX.Element {
  return (
    <div className={styles.glossary}>
      <p className={styles.glossaryTitle}>The model in your head</p>
      <ul className={styles.terms}>
        <li>
          <strong>Gateway</strong> - the API server you run with{' '}
          <code>antseed gateway start</code> (or in the background with{' '}
          <code>antseed gateway service install</code>) or the server installer, at{' '}
          <code>/v1</code> on port 8379. It gives every tool its own API key with
          budgets, routing policy and usage logs, and passes requests to a buyer.
          Reach it locally, on your network, behind a{' '}
          <Link to="/docs/tunnels/">tunnel</Link>, or on a server. Tools send the
          key as <code>Authorization: Bearer</code>.
        </li>
        <li>
          <strong>Buyer proxy</strong> - the server on{' '}
          <code>localhost:8377</code> that finds sellers and pays them, forwarding
          your requests to the Antseed network. It only listens on localhost and
          checks no key, so tools can call it directly only on the same computer;
          everything else goes through a gateway. It speaks{' '}
          <em>all four LLM protocols</em> at once -{' '}
          <code>/v1/messages</code> (Anthropic),{' '}
          <code>/v1/chat/completions</code> (OpenAI Chat),{' '}
          <code>/v1/responses</code> (OpenAI Responses), and{' '}
          <code>/v1/completions</code> (legacy) - and translates between them via{' '}
          <a
            href="https://github.com/Antseed/antseed/tree/main/packages/api-adapter"
            target="_blank"
            rel="noreferrer">
            <code>@antseed/api-adapter</code>
          </a>
          . So a tool that only knows Anthropic Messages can still reach an OpenAI
          peer (and vice versa).
        </li>
        <li>
          <strong>Peer</strong> - someone selling inference. Every peer has a{' '}
          <code>peerId</code> (40-char hex), a display name, and a list of services.
        </li>
        <li>
          <strong>Service</strong> - a single model id like{' '}
          <code>kimi-k2.6</code> or <code>deepseek-v4-flash</code>. <em>This
          is what you pass as <code>model</code> in your tool's config.</em>
          Each service has its own native protocol list and{' '}
          <code>in</code>/<code>cachedIn</code>/<code>out</code> pricing.
        </li>
        <li>
          <strong>Protocols</strong> (per service) - the wire formats a service
          accepts <em>natively</em>, advertised on each peer in{' '}
          <code>providerServiceApiProtocols[provider].services[service]</code>. Values:{' '}
          <code>anthropic-messages</code>, <code>openai-chat-completions</code>,{' '}
          <code>openai-responses</code>, <code>openai-completions</code>. <strong>
          This is the field to match your tool against.</strong> If your tool's
          wire format is in this list, traffic passes through untouched. If not,
          the api-adapter translates on the fly.
        </li>
        <li>
          <strong>Cached input pricing</strong> - services charge a separate,
          much lower rate (typically 4–10×) for tokens that are reused across
          requests: system prompts, tool schemas, prior conversation turns, long
          files you keep referencing. The CLI exposes it as{' '}
          <code>cachedInputUsdPerMillion</code>. For long-running agents and
          chatbots, this is often the dominant cost line.
        </li>
        <li>
          <strong>Pin</strong> - optionally telling Antseed “route
          requests to <em>this</em> peer.” Without a pin, the buyer
          ranks eligible offers with the same Price + Trust preferences used
          by the desktop and can fail over on retryable peer failures. A
          recognized conversation softly prefers its previous successful
          seller; pin only when you want one specific seller: a session-wide pin via{' '}
          <code>antseed buyer connection set --peer &lt;id&gt;</code> (saved to{' '}
          <code>~/.antseed/buyer.state.json</code>), or a per-request{' '}
          <code>x-antseed-pin-peer: &lt;id&gt;</code> header (no session state
          needed). See Step 4.
        </li>
      </ul>
    </div>
  );
}
