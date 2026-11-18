import type {JSX, ReactNode} from 'react';
import Link from '@docusaurus/Link';
import {Heading, Section, Wash} from '../components';
import {Glass} from './Glass/Glass';
import {PixelIcon, type PixelIconName} from './PixelIcon';
import styles from './PrivacyPair.module.css';
import {PAINTINGS, type PaintingName} from '../lib/paintings';

export type PrivacySide = {text: ReactNode; href: string};

type Card = {name: string; icon: PixelIconName; painting: PaintingName; side: PrivacySide};

const DEFAULT_ANONYMOUS: PrivacySide = {
  text: 'No account or email needed, so neither the provider nor Antseed knows who sent the request.',
  href: '/blog/trust-without-a-middleman',
};
const DEFAULT_PRIVATE: PrivacySide = {
  text: 'Choose a TEE-verified provider. Your request runs in a secure enclave, keeping your prompt hidden – even from the provider.',
  href: '/blog/dont-trust-the-tee-label',
};

type Props = {
  cmp: string;
  id?: string;
  title: string;
  anonymous?: PrivacySide;
  private?: PrivacySide;
};

/** Anonymous and Private side by side: each a painting with its name on glass, the promise and a link under it. */
export function PrivacyPair({cmp, id, title, anonymous = DEFAULT_ANONYMOUS, private: privateSide = DEFAULT_PRIVATE}: Props): JSX.Element {
  const titleId = `${cmp.replace('/', '-')}-title`;
  const cards: readonly Card[] = [
    {name: 'Anonymous', icon: 'user', painting: 'pond', side: anonymous},
    {name: 'Private', icon: 'lock', painting: 'ferns', side: privateSide},
  ];
  return (
    <Section cmp={cmp} id={id} labelledBy={titleId} pad="all" railClassName={styles.rail}>
      <Heading id={titleId} title={title} reveal className={styles.title} />
      <div className={styles.cards}>
        {cards.map((c) => (
          <article key={c.name} className={styles.card}>
            <Wash unveil className={styles.painting} {...PAINTINGS[c.painting]}>
              <Glass as="h3" className={styles.badge}><PixelIcon name={c.icon} className={styles.icon} />{c.name}</Glass>
            </Wash>
            <div className={styles.caption} data-rv="">
              <p className={styles.text}>{c.side.text}</p>
              <Link to={c.side.href} className={styles.more}>Learn more<span aria-hidden="true">&nbsp;→</span></Link>
            </div>
          </article>
        ))}
      </div>
    </Section>
  );
}
