import type {JSX} from 'react';
import clsx from 'clsx';
import {Section, ThemedImg} from '../../components';
import {Bar, Files, Head, kit} from './Kit';
import {logoFiles, logoSrc, type LogoKind} from './logos';
import styles from './Logo.module.css';

function Plate({kind, name, width, height}: {kind: LogoKind; name: string; width: number; height: number}): JSX.Element {
  return (
    <div className={clsx(kit.cell, kit.lineTop, kind === 'mark' && kit.lineLeft, styles.plate)}>
      <div className={styles.stage}>
        <ThemedImg className={styles[kind]} day={logoSrc(kind, 'black')} night={logoSrc(kind, 'white')} width={width} height={height} alt={`Antseed ${name.toLowerCase()}`} />
      </div>
      <div className={kit.cap}>
        <p className={kit.capTitle}>{name}</p>
        <span className={kit.day}><Files items={logoFiles(kind, 'black')} /></span>
        <span className={kit.night}><Files items={logoFiles(kind, 'white')} /></span>
      </div>
    </div>
  );
}

/** The logo and the mark, side by side, each with the file for the current theme. */
export default function Logo(): JSX.Element {
  return (
    <Section cmp="brand/logo" id="logo" labelledBy="logo-title" railClassName={kit.rail}>
      <Head eyebrow="Logo" id="logo-title" title={['Black on light,', 'near-white on dark.']} />
      <div className={kit.pair}>
        <Plate kind="logo" name="Logo" width={191} height={66} />
        <Plate kind="mark" name="Mark" width={61} height={61} />
      </div>
      <Bar note="Leave the height of the capitals clear all around. Never stretch it, recolour it or set it on a painting." />
    </Section>
  );
}
