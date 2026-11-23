import type {JSX} from 'react';
import clsx from 'clsx';
import {Section, ThemedImg} from '../../components';
import {Files, Head, kit} from './Kit';
import {TEXTURES, WATERCOLOURS, backgroundFiles, type Background} from './assets';
import styles from './Backgrounds.module.css';

function Tile({item, square}: {item: Background; square?: boolean}): JSX.Element {
  return (
    <figure className={clsx(kit.cell, kit.lineTop, styles.tile)}>
      <div className={clsx(styles.picture, square ? styles.square : styles.paint)}>
        <ThemedImg day={item.day} night={item.night} alt={square ? `${item.name} breaking into dots` : `${item.name}, a watercolour`} className={styles.image} />
      </div>
      <figcaption className={styles.caption}>
        <span>{item.name}</span>
        <Files items={backgroundFiles(item)} />
      </figcaption>
    </figure>
  );
}

/** Square textures, then watercolours, each by day and by night. */
export default function Backgrounds(): JSX.Element {
  return (
    <Section cmp="brand/backgrounds" id="backgrounds" labelledBy="backgrounds-title" railClassName={kit.rail}>
      <Head eyebrow="Backgrounds" id="backgrounds-title" title={['Paintings and dots,', 'ready to use.']} />
      <div className={styles.row}>{TEXTURES.map((t) => <Tile key={t.key} item={t} square />)}</div>
      <div className={styles.row}>{WATERCOLOURS.map((w) => <Tile key={w.key} item={w} />)}</div>
    </Section>
  );
}
