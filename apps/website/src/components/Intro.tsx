import type {CSSProperties, JSX, ReactNode} from 'react';
import clsx from 'clsx';
import {ScrollLitText} from '../parts/ScrollLitText';
import {Section} from './Section';
import styles from './Intro.module.css';

type Props = {
  cmp: string;
  label: string;
  /** The label beside the lede, in the pixel face. */
  eyebrow: ReactNode;
  /** The first paragraph, in ink. */
  lede: ReactNode;
  /** Light the lede word by word as it scrolls up the screen instead of revealing it (a string lede). */
  lit?: boolean;
  /** Further paragraphs, in grey. */
  more?: readonly ReactNode[];
  /** Wrap the paragraphs so no line ends with a word on its own. */
  pretty?: boolean;
  /** Balance the last paragraph's lines (a short closing line), instead of filling the first line first. */
  balanceLast?: boolean;
  /** On phones, where the eyebrow sits above the text: the space between them, px (20 by default). */
  phoneLabelGap?: number;
};

/** An eyebrow beside a lede, each paragraph revealed on its own. From 1200px the lede is 20/28 with 124px above and below. */
export function Intro({cmp, label, eyebrow, lede, lit, more = [], pretty, balanceLast, phoneLabelGap}: Props): JSX.Element {
  const style = phoneLabelGap === undefined ? undefined : ({'--intro-phone-gap': `${phoneLabelGap}px`} as CSSProperties);
  return (
    <Section cmp={cmp} label={label} className={styles.intro} railClassName={styles.rail} pad="y" style={style}>
      <div className={clsx(styles.split, pretty && styles.pretty, balanceLast && styles.balanceLast)}>
        <p className={styles.label} data-rv="">{eyebrow}</p>
        <div className={styles.lede}>
          {lit && typeof lede === 'string' ? <ScrollLitText text={lede} /> : <p data-rv="">{lede}</p>}
          {more.map((line, i) => <p key={i} className={styles.dim} data-rv="">{line}</p>)}
        </div>
      </div>
    </Section>
  );
}
