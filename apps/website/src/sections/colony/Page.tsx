import type {JSX} from 'react';
import {Intro, SitePage} from '../../components';
import Top from './Top';
import Colonies from './ColoniesSection';
import HowItWorks from './HowItWorks';
import FirstColony from './FirstColony';
import Privacy from './Privacy';
import Join from './Join';
import {Faq} from '../../parts/Faq';
import {QUESTIONS} from './questions';
import styles from './Page.module.css';

const TITLE = 'Join the first Mac Colony';
const DESCRIPTION = 'Colony joins Macs into one AI provider on Antseed. Sign up for early access to the first Mac Colony, starting with Mac Studios.';

/** /colony/: early access to the first Mac Colony. */
export default function Page(): JSX.Element {
  return (
    <SitePage
      title={TITLE}
      description={DESCRIPTION}
      className={styles.page}>
      <Top />
      <Intro
        cmp="colony/intro"
        label="Where this goes"
        eyebrow="Where this goes"
        lede="AI on the machines people own."
        lit
        phoneLabelGap={16}
        more={['Powerful Macs sit idle on desks for most of the day. A Colony lets them work together and serve AI to anyone on Antseed, with every Mac paid for the answers it gives. It starts with the Mac, and the idea is a network of many Colonies.']}
      />
      <Colonies />
      <HowItWorks />
      <FirstColony />
      <Privacy />
      <Join />
      <Faq cmp="colony/faq" items={QUESTIONS} widePadding={124} phoneGap={32} />
    </SitePage>
  );
}
