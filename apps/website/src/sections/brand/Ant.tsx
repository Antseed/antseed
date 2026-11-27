import type {JSX} from 'react';
import clsx from 'clsx';
import {Section} from '../../components';
import {Bar, Head, kit} from './Kit';
import {ANTS_COIN, REFERENCE_ANT} from './assets';
import styles from './Ant.module.css';

const RULES = [
  {title: 'Body', text: 'One round ant. A head close to half its height, a round abdomen behind with nothing growing from it, two thin arms without joints, exactly two legs under the body.'},
  {title: 'In the background', text: 'Two ball-tipped antennae, huge white eyes with tiny pupils looking two ways, a small straight mouth: a deadpan, slightly lost stare. Never scary.'},
  {title: 'In action', text: 'Eyes on what it is doing, or the expression that fits the moment.'},
  {title: 'Costume', text: 'A lime bandana by default. Props tell the roles apart: round glasses and a hoodie for a provider, small black sunglasses only for Private.'},
  {title: 'Line and night', text: 'A thin dark-brown ink line on the ant only, never on scenery. At night it takes the night filter and keeps its costume.'},
  {title: 'Never', text: 'A realistic insect: no mandibles, jointed legs or six legs. Never a second ant design, and never a pose built from parts: re-render it.'},
  {title: 'The $ANTS coin', text: 'Green like the buttons, the Antseed mark raised in white. Never gold.'},
] as const;

/** The one reference ant and how it behaves. */
export default function Ant(): JSX.Element {
  return (
    <Section cmp="brand/ant" id="ant" labelledBy="ant-title" railClassName={kit.rail}>
      <Head eyebrow="The ant" id="ant-title" title={['One round ant,', 'a little derpy.']} />
      <div className={kit.pair}>
        <div className={clsx(kit.cell, kit.lineTop, styles.picture)}>
          <img src="/brand/art/ant.webp" width={676} height={1027} loading="lazy" decoding="async" alt="The Antseed ant: round brown head, huge white eyes looking apart, a lime bandana, two arms and two legs." />
          <img className={styles.coin} src={ANTS_COIN} width={557} height={603} loading="lazy" decoding="async" alt="The $ANTS coin: a green watercolour coin, tilted, the Antseed mark raised in white." />
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
      <Bar files={[{label: 'Ant PNG', href: REFERENCE_ANT}, {label: '$ANTS coin', href: ANTS_COIN}]} />
    </Section>
  );
}
