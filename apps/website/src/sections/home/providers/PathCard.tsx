import {useRef, type CSSProperties, type JSX} from 'react';
import clsx from 'clsx';
import {Actions, Button, Heading, Wash} from '../../../components';
import {usePlayOnView} from '../../../lib/usePlayOnView';
import {ProviderFilm} from '../../../parts/ProviderFilm/ProviderFilm';
import {ColonyLabel, ListingCard} from './Glass';
import type {ProviderPath} from './paths';
import styles from './Providers.module.css';

const ENTRANCE_SHARE = 0.2;

/** One way to provide: the moving painting with its glass, then its title, line and button, on rows shared with its neighbour. */
export function PathCard({path, index}: {path: ProviderPath; index: number}): JSX.Element {
  const ref = useRef<HTMLElement>(null);
  const pending = usePlayOnView(ref, ENTRANCE_SHARE);
  const own = path.scene === 'stall';
  return (
    <article ref={ref} className={clsx(styles.path, pending && styles.pending)} id={path.id} style={{'--card-i': index} as CSSProperties}>
      <Wash unveil className={clsx(styles.panel, own && styles.ownPanel)} day={path.painting.day} night={path.painting.night} label={path.painting.label}>
        <ProviderFilm scene={path.scene} className={own ? styles.ownFilm : undefined} />
        {own ? <ListingCard /> : <ColonyLabel />}
      </Wash>
      <Heading as="h3" title={path.title} className={styles.pathTitle} />
      <p className={styles.copy}>{path.copy}</p>
      <Actions className={styles.actions}><Button href={path.cta.href}>{path.cta.label}</Button></Actions>
    </article>
  );
}
