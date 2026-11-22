import {useEffect, useState, type JSX} from 'react';
import clsx from 'clsx';
import Head from '@docusaurus/Head';
import Link from '@docusaurus/Link';
import {readLink, recallCard, type CardFacts} from './cardFacts';
import {JoinBar} from './JoinBar';
import {CardByEmail, JoinGroup, NextSteps, ShareCard} from './Share';
import styles from './JoinPage.module.css';

const TITLE = 'You’re on the Mac Colony waitlist · Antseed';
const DESCRIPTION = 'Your card for the first Mac Colony waitlist, ready to share.';

/** /colony/joined/: where the welcome email's card link leads. The link carries the waitlist number and the Mac line; the card adds
 *  the first name this browser kept from the sign-up. Without a number (an old link, or before the email) it points to the email. */
export default function JoinedPage(): JSX.Element {
  const [facts, setFacts] = useState<(CardFacts & {noMac: boolean}) | null>(null);

  // the browser's own storage and the link's #, so both are read after the page renders, and again if the # changes
  useEffect(() => {
    const read = () => {
      const kept = recallCard();
      const link = readLink(window.location.hash);
      setFacts(link ? {name: kept.name, mac: link.mac, number: link.number, noMac: link.noMac} : {...kept, noMac: Boolean(kept.name && !kept.mac)});
    };
    read();
    window.addEventListener('hashchange', read);
    return () => window.removeEventListener('hashchange', read);
  }, []);

  return (
    <>
      <Head>
        <title>{TITLE}</title>
        <meta name="description" content={DESCRIPTION} />
        <meta name="robots" content="noindex" />
        <link rel="icon" href="/site/assets/home/icons/ant-mark.svg" />
      </Head>
      <div className={styles.page} data-cmp="colony/joined">
        <JoinBar progress={100} count="Done" />

        <div className={styles.art} aria-hidden="true"><div className={styles.artLayer} data-art="done" /></div>

        <main className={styles.main}>
          <div className={styles.card}>
            <section className={clsx(styles.step, styles.done)} data-step="done">
              <div className={styles.badge} aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg></div>
              {facts?.name && <p className={clsx(styles.eyebrow, styles.hi)}>Welcome, {facts.name}</p>}
              <h1 className={styles.question}>
                {facts?.number ? <>You’re #{facts.number.toLocaleString('en-US')}<br /> <span>on the waitlist.</span></> : <>You’re on<br /> <span>the waitlist.</span></>}
              </h1>
              <p className={styles.help}>Thanks for signing up for the first Mac Colony. We’ll email you {facts?.noMac ? 'when there’s a way for you to take part' : facts?.mac ? 'when there’s a spot for your Mac' : 'when there’s a spot for you'}.</p>
              <JoinGroup />
              {facts && <>
                <p className={clsx(styles.eyebrow, styles.small)}>Your card</p>
                {/* the card always shows the waitlist number, which only the welcome email's link carries */}
                {facts.number ? <ShareCard name={facts.name} mac={facts.mac} number={facts.number} /> : <CardByEmail sent />}
              </>}
              <NextSteps />
              <div className={styles.go}>
                <Link className={styles.skip} to="/colony/">Back to Colony</Link>
                {/* someone who signed up without a Mac has no other Mac to add, as on the sign-up's own last step */}
                {!facts?.noMac && <Link className={styles.skip} to="/colony/join/">Sign up another Mac</Link>}
              </div>
            </section>
          </div>
        </main>
      </div>
    </>
  );
}
