import type {JSX} from 'react';
import {SitePage} from '../../components';
import {PricingDuo} from '../../parts/PricingDuo';
import {EndpointDuo} from '../../parts/EndpointDuo';
import {PrivacyPair} from '../../parts/PrivacyPair';
import {Faq} from '../../parts/Faq';
import Top from './Top';
import Connect from './Connect';
import Skill from './Skill';
import {BLOCKS, POINTS} from './endpoint';
import {QUESTIONS} from './questions';

const TITLE = 'Run AI agents for a fraction of the price';
const DESCRIPTION =
  'Hermes, OpenClaw, Codex, OpenCode, your own. Your agent installs Antseed from one skill and every request goes to the cheapest verified provider. No usage caps, no sign-up.';

/** /agents/: run your agents on the open market. */
export default function Page(): JSX.Element {
  return (
    <SitePage
      title={TITLE}
      description={DESCRIPTION}
      head={<>
        <link rel="canonical" href="https://antseed.com/agents/" />
        <link rel="alternate" type="text/markdown" href="/skill.md" title="Agent-readable setup skill" />
      </>}>
      <Top />
      <PricingDuo
        cmp="agents/pricing"
        title="Run your agents all day,"
        accent="for a fraction of the cost."
        lead="Agents make hundreds of context-heavy calls. Antseed routes each one to the cheapest verified provider in real time."
      />
      <Connect />
      <EndpointDuo
        cmp="agents/endpoint"
        title={['Point your agents', 'at localhost.']}
        lead={<>Your local endpoint at <code>localhost:8377</code> speaks the OpenAI and Anthropic APIs. The key is a placeholder; there is no account behind it.</>}
        points={POINTS}
        action={{label: 'Read the agent guide', href: '/docs/agents/'}}
        code={{blocks: BLOCKS, status: 'Connected Localhost:8377', typed: true}}
      />
      <Skill />
      <PrivacyPair
        cmp="agents/privacy"
        title="Your agent runs without a name."
        anonymous={{text: 'No signup, no email, no platform key. The agent pays per request from a wallet, so the provider never learns whose agent it is.', href: '/privacy/'}}
        private={{text: 'Require TEE verification when you start its endpoint and the agent only talks to verified providers. Its prompts and tool calls run in a secure enclave, hidden even from the provider.', href: '/docs/verify-tee/'}}
      />
      <Faq cmp="agents/faq" items={QUESTIONS} />
    </SitePage>
  );
}
