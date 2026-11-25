import type {JSX, ReactNode} from 'react';
import clsx from 'clsx';
import {Heading, Section, Wash} from '../../components';
import {GlassChip, GlassWindow} from '../../parts/Glass/Glass';
import {PixelIcon} from '../../parts/PixelIcon';
import styles from './Where.module.css';
import {PAINTINGS, type PaintingName} from '../../lib/paintings';

type Place = {name: string; text: string; painting: PaintingName; scene: ReactNode};

const ICON_SIZE = 14;
const laptop = <PixelIcon name="laptop" size={ICON_SIZE} className={styles.icon} />;
const server = <PixelIcon name="server" size={ICON_SIZE} className={styles.icon} />;
const base = <img className={styles.logo} src="/site/assets/home/icons/base.svg" alt="" width={12} height={12} loading="lazy" />;
const on = <i className={styles.on} />;
const onRows = (terms: readonly string[]) => terms.map((term) => ({term, value: on}));

const PLACES: readonly Place[] = [
  {
    name: 'On your machine',
    text: 'Routing preferences, local history and your allow and block rules.',
    painting: 'clover',
    scene: <GlassWindow className={clsx(styles.glass, styles.middle)} icon={laptop} title="Your machine" rows={onRows(['Routing preferences', 'Local history', 'Allow and block rules'])} />,
  },
  {
    name: 'Between the peers',
    text: 'Requests and responses. The provider you chose can read the request it serves, unless it runs inside a verified TEE.',
    painting: 'river',
    scene: (
      <>
        <GlassChip className={clsx(styles.glass, styles.from)}>{laptop}You</GlassChip>
        <GlassChip className={clsx(styles.glass, styles.request)}>Request →</GlassChip>
        <GlassChip className={clsx(styles.glass, styles.response)}>← Response</GlassChip>
        <GlassWindow className={clsx(styles.glass, styles.provider)} icon={server} title="The provider you chose" text="Reads the request it serves, unless in a verified TEE" />
      </>
    ),
  },
  {
    name: 'On Base',
    text: 'Deposits, payment authorizations, usage totals, stake and rewards. Prompts and outputs never go onchain.',
    painting: 'ferns',
    scene: (
      <>
        <GlassWindow className={clsx(styles.glass, styles.chain)} icon={base} title="Base" rows={onRows(['Deposits', 'Payment authorizations', 'Usage totals', 'Stake and rewards'])} />
        <GlassChip className={clsx(styles.glass, styles.never)}><i className={styles.ring} />Prompts and outputs: never onchain</GlassChip>
      </>
    ),
  },
];

/** What lives where: your machine, between the peers, and Base. */
export default function Where(): JSX.Element {
  return (
    <Section cmp="network/where" snap="narrow" labelledBy="where-title" className={styles.where} railClassName={styles.rail}>
      <Heading id="where-title" title={['What lives where.', 'Three places, nothing else.']} secondLine="block" className={styles.heading} />
      <div className={styles.cards}>
        {PLACES.map((p) => (
          <article key={p.name} className={styles.place}>
            <Wash unveil className={styles.card} {...PAINTINGS[p.painting]}>{p.scene}</Wash>
            <p className={styles.caption} data-rv=""><b>{p.name}</b> {p.text}</p>
          </article>
        ))}
      </div>
    </Section>
  );
}
