import type {JSX} from 'react';
import clsx from 'clsx';
import {Section} from '../../components';
import {Bar, Head, kit} from './Kit';
import {REFERENCE_ANT} from './assets';
import styles from './Ant.module.css';

const RULES = [
  {title: 'Body', text: 'A round head, two arms, two legs. Never three or four feet.'},
  {title: 'In the background', text: 'Huge white eyes looking two ways, a tiny flat mouth, a derpy stare.'},
  {title: 'In action', text: 'Eyes on what it is doing, or the expression that fits the moment.'},
  {title: 'Costume', text: 'Whatever fits its role: a lime bandana by default, otherwise a hoodie, a beanie, glasses.'},
] as const;

/** The one reference ant and how it behaves. */
export default function Ant(): JSX.Element {
  return (
    <Section cmp="brand/ant" id="ant" labelledBy="ant-title" railClassName={kit.rail}>
      <Head eyebrow="The ant" id="ant-title" title={['One round ant,', 'a little derpy.']} />
      <div className={kit.pair}>
        <div className={clsx(kit.cell, kit.lineTop, styles.picture)}>
          <img src="/brand/art/ant.webp" width={676} height={1027} loading="lazy" decoding="async" alt="The Antseed ant: round brown head, huge white eyes looking apart, a lime bandana, two arms and two legs." />
        </div>
        <div className={clsx(kit.cell, kit.lineTop, kit.lineLeft, styles.rules)}>
          {RULES.map((r) => (
            <div key={r.title} className={styles.rule}>
              <h3>{r.title}</h3>
              <p>{r.text}</p>
            </div>
          ))}
        </div>
      </div>
      <Bar files={[{label: 'PNG', href: REFERENCE_ANT}]} />
    </Section>
  );
}
