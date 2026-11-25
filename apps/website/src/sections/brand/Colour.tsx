import type {CSSProperties, JSX} from 'react';
import {Section, SectionHead} from '../../components';
import {PALETTE, type Swatch} from './palette';
import styles from './Colour.module.css';

function SwatchCard({swatch}: {swatch: Swatch}): JSX.Element {
  return (
    <li className={styles.swatch}>
      {/* the chip reads the live token, so it follows the theme switch */}
      <span className={styles.chip} style={{'--chip': `var(${swatch.token})`} as CSSProperties} aria-hidden="true" />
      <span className={styles.name}>{swatch.name}</span>
      <code className={styles.token}>{swatch.token}</code>
      <span className={styles.values}>
        <span>Day <code>{swatch.day}</code></span>
        <span>Night <code>{swatch.night}</code></span>
      </span>
      <span className={styles.role}>{swatch.role}</span>
    </li>
  );
}

/** The palette: paper, ink and one green, with their day and night values. */
export default function Colour(): JSX.Element {
  return (
    <Section cmp="brand/colour" id="colour" labelledBy="colour-title" pad="all">
      <SectionHead
        eyebrow="Colour"
        id="colour-title"
        title={['Paper and ink,', 'with one green.']}
        sub="Night swaps the paper, not the green: the page darkens, every grey becomes one, and green text lifts to #98c463. The paintings keep their own colours, which never become interface colours."
      />
      {PALETTE.map((group) => (
        <div key={group.title} className={styles.group} data-rv="">
          <h3 className={styles.groupTitle}>{group.title}</h3>
          <ul className={styles.swatches}>
            {group.swatches.map((s) => <SwatchCard key={s.token} swatch={s} />)}
          </ul>
        </div>
      ))}
    </Section>
  );
}
