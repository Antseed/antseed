import type {JSX} from 'react';
import {FORMAT_ENDPOINT, FORMAT_LABELS, FORMAT_TO_PROTOCOL, type Integration} from '../../../integrations/integrations';
import {GuideSection} from './GuideSection';
import styles from './Guide.module.css';

const API_ADAPTER = 'https://github.com/Antseed/antseed/tree/main/packages/api-adapter';
const MULTI_FORMATS = ['anthropic-messages', 'openai-chat', 'openai-responses'] as const;

/**
 * What the tool sends, what peers advertise per service (`protocols`) and what happens when they differ. A peer's `provider` is a
 * seller-plugin label; the wire format a service accepts natively is `providerServiceApiProtocols[provider].services[service]`.
 */
export function WireFormat({integration: i}: {integration: Integration}): JSX.Element {
  if (i.format === 'multi') {
    return (
      <GuideSection id="wire-format" eyebrow="Wire format" title="Multi-protocol">
        <p className={styles.para}>
          {i.name} can send <strong>any</strong> of Antseed's supported protocols - configure per call. Antseed will match each request
          to the peer's advertised service protocols (see <code>providerServiceApiProtocols</code> on a peer) and translate when they
          don't match.
        </p>
        <dl className={styles.env}>
          {MULTI_FORMATS.map((f) => (
            <div key={f} className={styles.envRow}>
              <dt>{FORMAT_ENDPOINT[f]}</dt>
              <dd>{FORMAT_LABELS[f]}: service <code>protocols</code> includes <code>{FORMAT_TO_PROTOCOL[f]}</code></dd>
            </div>
          ))}
        </dl>
      </GuideSection>
    );
  }

  const fmt = i.format;
  const protocol = FORMAT_TO_PROTOCOL[fmt];
  return (
    <GuideSection id="wire-format" eyebrow="Wire format" title={`How ${i.name} talks to Antseed`}>
      <ul className={styles.facts}>
        <li>
          <strong>Wire format sent by {i.name}:</strong> <code>{FORMAT_LABELS[fmt]}</code>{' '}
          (hits <code>{FORMAT_ENDPOINT[fmt]}</code> on your gateway or buyer proxy)
        </li>
        <li>
          <strong>Best-fit services:</strong> any service whose <code>protocols</code> array contains <code>{protocol}</code>. That's
          what the peer advertises as natively-supported - zero translation overhead, no transform edge cases.
        </li>
        <li>
          <strong>How to check a peer:</strong> run <code>antseed network peer &lt;peerId&gt; --json</code> and look at{' '}
          <code>providerServiceApiProtocols[provider].services[service]</code>. The browse command exposes the same field per peer.
        </li>
        <li>
          <strong>What happens when protocols don't match:</strong> Antseed's{' '}
          <a href={API_ADAPTER} target="_blank" rel="noopener noreferrer"><code>@antseed/api-adapter</code></a> translates between{' '}
          {FORMAT_LABELS[fmt]} and the service's native protocol on the fly, inside the buyer. So a request from {i.name} can still
          reach a service that only advertises{' '}
          <code>{fmt === 'anthropic-messages' ? 'openai-chat-completions' : 'anthropic-messages'}</code> - just with a small transform
          step.
        </li>
        {fmt !== 'openai-responses' && (
          <li className={styles.caveat}>
            <strong>One known caveat:</strong> services whose only advertised protocol is <code>openai-responses</code> require
            streaming. If {i.name} sends a non-streaming request and Antseed routes it to one of those services, the call fails with{' '}
            <code>HTTP 400: Stream must be set to true</code>. Pick a service whose <code>protocols</code> includes{' '}
            <code>{protocol}</code> (or another non-responses protocol) to avoid this.
          </li>
        )}
      </ul>
    </GuideSection>
  );
}
