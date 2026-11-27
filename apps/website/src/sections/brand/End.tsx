import {useRef, type JSX} from 'react';
import {Button, Eyebrow, Heading, Section} from '../../components';
import {STEP} from '../../parts/PrivacyDots/mosaic';
import {BRAND_GUIDE, BRAND_KIT, BRAND_KIT_SIZE} from './logos';
import EndDots from './EndDots';
import styles from './End.module.css';

/** The closing band: the Private section's dark ground, dot frame and walking ants. */
export default function End(): JSX.Element {
  const text = useRef<HTMLDivElement>(null);
  return (
    <Section cmp="brand/end" labelledBy="end-title" className={styles.band} bare>
      <EndDots step={STEP} quietRef={text} />
      <div ref={text} className={styles.text}>
        <Eyebrow className={styles.eyebrow}>Brand assets</Eyebrow>
        <Heading id="end-title" secondLine="break" title={['Everything,', 'in one file.']} className={styles.title} />
        <div className={styles.actions}>
          <Button href={`pathname://${BRAND_KIT}`} size="page">Download all assets</Button>
          <span className={styles.size}>{BRAND_KIT_SIZE}</span>
        </div>
        <a className={styles.guide} href={BRAND_GUIDE} download>Brand guide for agents (.md)&nbsp;→</a>
      </div>
    </Section>
  );
}
