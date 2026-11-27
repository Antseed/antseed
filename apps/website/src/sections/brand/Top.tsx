import type {JSX} from 'react';
import {Button, Eyebrow, Heading, Section, ThemedImg} from '../../components';
import {BRAND_KIT, BRAND_KIT_SIZE} from './logos';
import {kit} from './Kit';
import styles from './Top.module.css';

/** The first screen: plain paper from edge to edge, so the meadow's dots never meet the margin's. */
export default function Top(): JSX.Element {
  return (
    <Section cmp="brand/top" labelledBy="brand-title" className={styles.hero} bare>
      <ThemedImg className={styles.art} day="/brand/art/hero-day.webp" night="/brand/art/hero-night.webp" width={1584} height={404} alt="" />
      <div className={styles.text}>
        <Eyebrow>Brand assets</Eyebrow>
        <Heading as="h1" id="brand-title" secondLine="break" title={['The Open', 'Intelligence Network']} className={styles.title} />
        <div className={styles.actions}>
          {/* pathname:// keeps the router out of it: the kit is a static file */}
          <Button href={`pathname://${BRAND_KIT}`} size="page">Download all assets</Button>
          <span className={kit.meta}>{BRAND_KIT_SIZE}</span>
        </div>
      </div>
    </Section>
  );
}
