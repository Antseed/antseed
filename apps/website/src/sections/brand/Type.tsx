import type {JSX} from 'react';
import clsx from 'clsx';
import {Section} from '../../components';
import {Files, Head, kit} from './Kit';
import styles from './Type.module.css';

/** The two faces, as one big letter each. */
export default function Type(): JSX.Element {
  return (
    <Section cmp="brand/type" id="type" labelledBy="type-title" railClassName={kit.rail}>
      <Head eyebrow="Type" id="type-title" title={['Letters and dots,', 'one family.']} />
      <div className={kit.pair}>
        <div className={clsx(kit.cell, kit.lineTop, styles.face)}>
          <div className={clsx(styles.letters, styles.pixel)} aria-hidden="true">Aa</div>
          <div className={kit.cap}>
            <div><p className={kit.capTitle}>Geist Pixel</p><p className={kit.meta}>Titles</p></div>
            <Files items={[{label: 'TTF', href: '/brand/downloads/fonts/GeistPixel-VariableFont_ELSH.ttf'}]} />
          </div>
        </div>
        <div className={clsx(kit.cell, kit.lineTop, kit.lineLeft, styles.face)}>
          <div className={clsx(styles.letters, styles.sans)} aria-hidden="true">Aa</div>
          <div className={kit.cap}>
            <div><p className={kit.capTitle}>Geist</p><p className={kit.meta}>Everything else</p></div>
            <span className={styles.external}><a href="https://fonts.google.com/specimen/Geist" target="_blank" rel="noopener noreferrer">Google Fonts&nbsp;↗</a></span>
          </div>
        </div>
      </div>
    </Section>
  );
}
