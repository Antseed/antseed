import type {JSX} from 'react';
import {Intro, SitePage} from '../../components';
import Top from './Top';
import Colonies from './ColoniesSection';
import HowItWorks from './HowItWorks';
import FirstColony from './FirstColony';
import Setup from './Setup';
import Privacy from './Privacy';
import Join from './Join';
import {Faq} from '../../parts/Faq';
import {QUESTIONS} from './questions';
import styles from './Page.module.css';

const TITLE = 'Join the first Mac Colony';
const DESCRIPTION = 'Colony joins Macs into one AI provider on Antseed. Join the waitlist for the first Mac Colony. Any Apple silicon Mac can sign up.';
/** The waitlist's share card, so a link to the page looks like the card people post. */
const OG_IMAGE = 'https://antseed.com/site/assets/colony/og-waitlist.jpg';

/** /colony/: the waitlist for the first Mac Colony. Sign-ups happen on /colony/join/. */
export default function Page(): JSX.Element {
  return (
    <SitePage
      title={TITLE}
      description={DESCRIPTION}
      head={<>
        <meta property="og:image" content={OG_IMAGE} />
        <meta property="og:image:width" content="1200" />
        <meta property="og:image:height" content="675" />
        <meta property="og:image:alt" content="Join the waitlist for the first Mac Colony on Antseed" />
        <meta name="twitter:image" content={OG_IMAGE} />
      </>}
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
      <Setup />
      <Privacy />
      <Join />
      <Faq cmp="colony/faq" items={QUESTIONS} widePadding={124} phoneGap={32} />
    </SitePage>
  );
}
