import type {JSX} from 'react';
import {SitePage} from '../../components';
import {PricingDuo} from '../../parts/PricingDuo';
import {EndpointDuo} from '../../parts/EndpointDuo';
import {PrivacyPair} from '../../parts/PrivacyPair';
import {Faq} from '../../parts/Faq';
import Top from './Top';
import Connect from './Connect';
import {BLOCKS, POINTS} from './endpoint';
import {QUESTIONS} from './questions';

const TITLE = 'Coding apps without usage limits, at a fraction of the price';
const DESCRIPTION =
  'Claude Code, Codex, Cursor, OpenCode, Pi. Keep the tool you like, point it at Antseed, and pay a fraction of what the same work costs on a plan. No five-hour window, no weekly cap, no sign-up.';

/** /coding/: your coding app on the open market. */
export default function Page(): JSX.Element {
  return (
    <SitePage
      title={TITLE}
      description={DESCRIPTION}
      head={<link rel="canonical" href="https://antseed.com/coding/" />}>
      <Top />
      <PricingDuo
        cmp="coding/pricing"
        title="Frontier models,"
        accent="at a fraction of the plan price."
        lead="Pay per request at the lowest market price. No usage limits, no subscription."
      />
      <Connect />
      <EndpointDuo
        cmp="coding/endpoint"
        title={['Point your tools', 'at localhost.']}
        lead={<>Your local endpoint at <code>localhost:8377</code> speaks the OpenAI and Anthropic APIs. One command launches your tool through it.</>}
        points={POINTS}
        action={{label: 'Browse the integrations', href: '/integrations/'}}
        code={{blocks: BLOCKS, status: 'Connected Localhost:8377', typed: true}}
      />
      <PrivacyPair
        cmp="coding/privacy"
        title="Your code stays yours."
        anonymous={{text: 'Your coding app talks to localhost. There is no account or API key on file, so no one can tie a session to you.', href: '/privacy/'}}
        private={{text: 'Working on something you cannot share? Route to a TEE-verified provider and your source is processed inside a secure enclave the provider cannot read.', href: '/docs/verify-tee/'}}
      />
      <Faq cmp="coding/faq" items={QUESTIONS} />
    </SitePage>
  );
}
