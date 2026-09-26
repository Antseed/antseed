import styles from '../pages/index.module.css';
import {useLatestDesktopDownload} from '../lib/useLatestDesktopDownload';
import {AllVersionsLink} from '../lib/AllVersionsLink';
import {useMobileGetStarted} from '../lib/useMobileGetStarted';
import type {ReactNode} from 'react';
import {Button, Reveal, ArrowRight} from './ui';

/** The ink closing band from the homepage, shared with /network. */
export function FinalCtaBand({
  title = 'Every model. No middleman. No account.',
  sub = 'Free models to start. Pay per request for the rest, with no usage limits.',
  caption,
  secondary,
  versionsLink = true,
}: {
  title?: string;
  sub?: string;
  /** optional small line under the button */
  caption?: string;
  /** optional second button beside the download pill */
  secondary?: ReactNode;
  versionsLink?: boolean;
}) {
  return (
    <section className={styles.finalCta}>
      <Reveal className={styles.finalCtaInner}>
        <h2 className={styles.finalTitle}>{title}</h2>
        <p className={styles.finalSub}>{sub}</p>
        <div className={styles.ctaBlock}>
          {secondary ? (
            <div className={styles.finalBtnRow}>
              <FinalCtaButton />
              {secondary}
            </div>
          ) : (
            <FinalCtaButton />
          )}
          {versionsLink && <AllVersionsLink light />}
          {caption && <span className={styles.ctaCaptionLight}>{caption}</span>}
        </div>
      </Reveal>
    </section>
  );
}

function FinalCtaButton() {
  const download = useLatestDesktopDownload();
  const onGetStarted = useMobileGetStarted();
  return (
    <Button href={download.href} variant="white" size="lg" osIcons className="vprBtn" onClick={onGetStarted}>
      <span className="vprLabelDesktop">Download the AI VPN</span>
      <span className="vprLabelMobile">Get the AI VPN<ArrowRight /></span>
    </Button>
  );
}
