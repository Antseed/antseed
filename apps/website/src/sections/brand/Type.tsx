import type {JSX} from 'react';
import {Section, SectionHead} from '../../components';
import {PixelAxis} from './PixelAxis';
import {TYPEFACES, type Typeface} from './typefaces';
import styles from './Type.module.css';

function Specimen({face}: {face: Typeface}): JSX.Element {
  return (
    <li className={styles.row} data-rv="">
      <div className={styles.meta}>
        <h3 className={styles.name}>{face.name}</h3>
        <p className={styles.use}>{face.use}</p>
        <p className={styles.detail}><code>{face.token}</code> · {face.weights}</p>
      </div>
      <div className={styles.specimen}>
        {face.specimen === 'pixel'
          ? <PixelAxis />
          : <p className={styles[face.specimen]}>{face.sample}</p>}
      </div>
    </li>
  );
}

/** The four faces, each with a specimen; Geist Pixel with its ELSH axis. */
export default function Type(): JSX.Element {
  return (
    <Section cmp="brand/type" id="type" labelledBy="type-title" pad="all">
      <SectionHead
        eyebrow="Type"
        id="type-title"
        title={['Letters and dots,', 'one family.']}
        sub="Titles are set in a face made of round dots. Everything people read is Geist, controls are Instrument Sans, and code is Geist Mono. Sentence case everywhere, two weights only: 400 and 500."
      />
      <ul className={styles.rows}>
        {TYPEFACES.map((f) => <Specimen key={f.name} face={f} />)}
      </ul>
    </Section>
  );
}
