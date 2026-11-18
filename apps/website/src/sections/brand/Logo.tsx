import type {JSX} from 'react';
import clsx from 'clsx';
import {Section, SectionHead} from '../../components';
import {FeatureList} from '../../parts/FeatureList';
import {LOGO_PLATES, LOGO_RULES, type LogoPlate} from './logos';
import styles from './Logo.module.css';

const LOGO_SIZE = {width: 191, height: 66};
const MARK_SIZE = 61;

function Plate({plate}: {plate: LogoPlate}): JSX.Element {
  return (
    <figure className={styles.plate} data-rv="">
      <div className={clsx(styles.ground, plate.ground === 'night' && styles.night)}>
        <img className={styles.logo} src={plate.logo} {...LOGO_SIZE} alt={`The Antseed logo, ${plate.ground === 'night' ? 'near-white' : 'black'}`} loading="lazy" decoding="async" />
        <img className={styles.mark} src={plate.mark} width={MARK_SIZE} height={MARK_SIZE} alt="The Antseed mark" loading="lazy" decoding="async" />
      </div>
      <figcaption className={styles.caption}>
        <span className={styles.title}>{plate.title}</span>
        <span className={styles.files}>
          {plate.files.map((f) => <a key={f.href} href={f.href} download>{f.label}</a>)}
        </span>
      </figcaption>
    </figure>
  );
}

/** The logo on its two grounds, its files, and the three rules for placing it. */
export default function Logo(): JSX.Element {
  return (
    <Section cmp="brand/logo" id="logo" labelledBy="logo-title" pad="all" className={styles.section}>
      <SectionHead
        eyebrow="Logo"
        id="logo-title"
        title={['Black on light,', 'near-white on dark.']}
        sub="One lockup: the ant and the wordmark. It has no colour of its own. At night it is the black logo inverted by 93%."
      />
      <div className={styles.plates}>
        {LOGO_PLATES.map((p) => <Plate key={p.ground} plate={p} />)}
      </div>
      <FeatureList items={LOGO_RULES} className={styles.rules} />
    </Section>
  );
}
