import type {JSX} from 'react';
import clsx from 'clsx';
import {FORMAT_ENDPOINT, FORMAT_LABELS, FORMAT_TO_PROTOCOL, type Integration} from '../../../integrations/integrations';
import {Code} from '../../../parts/Ticks';
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
          to the peer's advertised service protocols (see <Code>providerServiceApiProtocols</Code> on a peer) and translate when they
          don't match.
        </p>
        <dl className={styles.env}>
          {MULTI_FORMATS.map((f) => (
            <div key={f} className={clsx(styles.envRow, styles.wireRow)}>
              <dt>{FORMAT_ENDPOINT[f]}</dt>
              <dd>{FORMAT_LABELS[f]}: service <Code>protocols</Code> includes <Code>{FORMAT_TO_PROTOCOL[f]}</Code></dd>
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
          <strong>Wire format sent by {i.name}:</strong> <Code>{FORMAT_LABELS[fmt]}</Code>{' '}
          (hits <Code>{FORMAT_ENDPOINT[fmt]}</Code> on your gateway or buyer proxy)
        </li>
        <li>
          <strong>Best-fit services:</strong> any service whose <Code>protocols</Code> array contains <Code>{protocol}</Code>. That's
          what the peer advertises as natively-supported - zero translation overhead, no transform edge cases.
        </li>
        <li>
          <strong>How to check a peer:</strong> run <Code>antseed network peer &lt;peerId&gt; --json</Code> and look at{' '}
          <Code>providerServiceApiProtocols[provider].services[service]</Code>. The browse command exposes the same field per peer.
        </li>
        <li>
          <strong>What happens when protocols don't match:</strong> Antseed's{' '}
          <a href={API_ADAPTER} target="_blank" rel="noopener noreferrer"><Code>@antseed/api-adapter</Code></a> translates between{' '}
          {FORMAT_LABELS[fmt]} and the service's native protocol on the fly, inside the buyer. So a request from {i.name} can still
          reach a service that only advertises{' '}
          <Code>{fmt === 'anthropic-messages' ? 'openai-chat-completions' : 'anthropic-messages'}</Code> - just with a small transform
          step.
        </li>
        {fmt !== 'openai-responses' && (
          <li className={styles.caveat}>
            <strong>One known caveat:</strong> services whose only advertised protocol is <Code>openai-responses</Code> require
            streaming. If {i.name} sends a non-streaming request and Antseed routes it to one of those services, the call fails with{' '}
            <Code>HTTP 400: Stream must be set to true</Code>. Pick a service whose <Code>protocols</Code> includes{' '}
            <Code>{protocol}</Code> (or another non-responses protocol) to avoid this.
          </li>
        )}
      </ul>
    </GuideSection>
  );
}
