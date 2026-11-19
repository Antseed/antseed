import {useEffect, useState, type JSX} from 'react';
import clsx from 'clsx';
import Head from '@docusaurus/Head';
import Link from '@docusaurus/Link';
import {readLink, recallCard, type CardFacts} from './cardFacts';
import {JoinGroup, NextSteps, ShareCard} from './Share';
import styles from './JoinPage.module.css';

const TITLE = 'You’re on the Mac Colony waitlist · Antseed';
const DESCRIPTION = 'Your card for the first Mac Colony waitlist, ready to share.';

/** /colony/joined/: where Google's thank-you note and the welcome email lead. The card uses the first name this browser kept from
 *  the sign-up. The Mac comes from the welcome email's link when there is one, with the waitlist number, else from the browser. */
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
        <header className={styles.bar}>
          <Link className={styles.logo} to="/colony/" aria-label="Antseed Colony"><img src="/site/assets/hero/logo.svg" width={95} height={33} alt="Antseed" /></Link>
          <div className={styles.progress} aria-hidden="true"><i className={styles.progressFill} style={{width: '100%'}} /></div>
          <p className={styles.count}>Done</p>
          <Link className={styles.close} to="/colony/" aria-label="Close and go back to Colony">
            <svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" /></svg>
          </Link>
        </header>

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
                <ShareCard name={facts.name} mac={facts.mac} number={facts.number} />
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
