import {useState, type JSX} from 'react';
import clsx from 'clsx';
import {Section} from '../../components';
import {Bar, Head, kit} from './Kit';
import styles from './Colour.module.css';

type Swatch = {name: string; hex: string; ink: string};

const INK = '#30382c';
const WHITE = '#ffffff';
const DARK = '#0f1312';
const LIGHT = '#eceee9';

const DAY: readonly (readonly Swatch[])[] = [
  [{name: 'Ink', hex: INK, ink: WHITE}, {name: 'Paper', hex: WHITE, ink: INK}],
  [{name: 'Green', hex: '#4f7a24', ink: WHITE}],
  [{name: 'Night green', hex: '#98c463', ink: INK}, {name: 'Grey', hex: '#929292', ink: DARK}, {name: 'Acid', hex: '#c8f53c', ink: INK}],
];

const NIGHT: readonly (readonly Swatch[])[] = [
  [{name: 'Night', hex: DARK, ink: LIGHT}, {name: 'Rail', hex: '#181d1b', ink: LIGHT}, {name: 'Text', hex: LIGHT, ink: DARK}],
  [{name: 'Green', hex: '#4f7a24', ink: WHITE}],
  [{name: 'Night green', hex: '#98c463', ink: INK}, {name: 'Grey', hex: '#9ba49e', ink: DARK}, {name: 'Acid', hex: '#c8f53c', ink: INK}],
];

function Chip({name, hex, ink}: Swatch): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(hex).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }).catch(() => {});
  };
  return (
    <button type="button" className={styles.chip} style={{background: hex, color: ink}} aria-label={`Copy ${name}, ${hex}`} onClick={copy}>
      <span>{name}</span>
      <code>{copied ? 'Copied' : hex}</code>
    </button>
  );
}

function Palette({columns, className}: {columns: readonly (readonly Swatch[])[]; className: string}): JSX.Element {
  return (
    <div className={clsx(styles.palette, className)}>
      {columns.map((column) => (
        <div key={column[0].name} className={styles.column}>
          {column.map((s) => <Chip key={s.name} {...s} />)}
        </div>
      ))}
    </div>
  );
}

/** The palette as flat blocks, by day and by night; a click copies a colour. */
export default function Colour(): JSX.Element {
  return (
    <Section cmp="brand/colour" id="colour" labelledBy="colour-title" railClassName={kit.rail}>
      <Head eyebrow="Colour" id="colour-title" title={['Paper and ink,', 'a touch of green.']} />
      <Palette columns={DAY} className={styles.dayOnly} />
      <Palette columns={NIGHT} className={styles.nightOnly} />
      <Bar note="Click a colour to copy it. Keep Acid for small dots and glows on dark." />
    </Section>
  );
}
