import type {JSX, ReactNode} from 'react';
import Link from '@docusaurus/Link';
import clsx from 'clsx';
import styles from './ListingCard.module.css';

const SHOT_WIDTH = 800;
const SHOT_HEIGHT = 600;

type Props = {
  href: string;
  name: string;
  line: string;
  /** The card's picture: a screenshot (`shot`) or any panel (`panel`). */
  shot?: {src: string; alt: string};
  panel?: ReactNode;
};

/** A directory card: the whole card links to where it leads, its picture 4:3, then its name in ink and its line. */
export default function ListingCard({href, name, line, shot, panel}: Props): JSX.Element {
  const body = (
    <>
      {shot ? (
        <div className={clsx(styles.picture, styles.shot)}>
          <img src={shot.src} alt={shot.alt} width={SHOT_WIDTH} height={SHOT_HEIGHT} loading="lazy" decoding="async" />
        </div>
      ) : panel}
      <p className={styles.caption}><b>{name}</b> {line}</p>
    </>
  );
  return /^https?:\/\//.test(href)
    ? <a className={styles.card} href={href} target="_blank" rel="noopener noreferrer">{body}</a>
    : <Link className={styles.card} to={href}>{body}</Link>;
}

/** The class a custom `panel` takes to sit in the card as a picture does. */
export const pictureClass = styles.picture;
