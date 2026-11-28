import type {JSX} from 'react';
import clsx from 'clsx';
import {Section, SectionHead} from '../../components';
import ListingCard from './ListingCard';
import {PLACES} from './directory';
import styles from './Ecosystem.module.css';

/** Where builders start, one screen: the head centred over three cards. */
export default function Build(): JSX.Element {
  return (
    <Section cmp="ecosystem/build" snap="narrow" labelledBy="build-title" className={clsx(styles.section, styles.build)} railClassName={clsx(styles.rail, styles.buildRail)} pad="y">
      <SectionHead
        center
        padX
        className={styles.head}
        titleClassName={styles.title}
        subClassName={clsx(styles.sub, styles.centeredSub)}
        eyebrow="Build, explore, connect"
        title={[<>An <span className={styles.nowrap}>AI-first</span> market</>, 'for builders.']}
        id="build-title"
        sub="Antseed gives projects a local API surface, open provider marketplace, and onchain payments so teams can build products on top of independent AI supply."
      />
      <div className={clsx(styles.grid, styles.places)}>
        {PLACES.map((p) => <ListingCard key={p.href} href={p.href} name={p.name} line={p.line} shot={{src: p.shot, night: p.shotNight, alt: p.alt}} />)}
      </div>
    </Section>
  );
}
