import type {JSX} from 'react';
import {SitePage} from '../../components';
import {EndpointDuo} from '../../parts/EndpointDuo';
import {PrivacyPair} from '../../parts/PrivacyPair';
import {Faq} from '../../parts/Faq';
import Top from './Top';
import Sees from './Sees';
import {BLOCKS, POINTS} from './endpoint';
import {QUESTIONS} from './questions';

const TITLE = 'Private AI: no account, no email, no one in the middle';
const DESCRIPTION =
  'Use AI without giving up who you are. No account, no email, requests route peer-to-peer, and a TEE-verified provider keeps even your prompt sealed.';

/** /privacy/: anonymous by default, private with a TEE-verified provider. */
export default function Page(): JSX.Element {
  return (
    <SitePage
      title={TITLE}
      description={DESCRIPTION}
      head={<link rel="canonical" href="https://antseed.com/privacy/" />}>
      <Top />
      <PrivacyPair cmp="privacy/design" title="Privacy by design" />
      <Sees />
      <EndpointDuo
        cmp="privacy/machine"
        title={['Everything stays', 'on your machine.']}
        lead="Antseed Desktop runs on your computer. Your settings, your signing key, and every routing decision stay on your device. Each request goes peer-to-peer over an encrypted connection to the provider you picked."
        points={POINTS}
        pointsAlign="first-line"
        action={{label: 'Read the TEE guide', href: '/docs/verify-tee/'}}
        code={{blocks: BLOCKS, status: 'Connected Localhost:8377', typed: true}}
      />
      <Faq cmp="privacy/faq" items={QUESTIONS} />
    </SitePage>
  );
}
