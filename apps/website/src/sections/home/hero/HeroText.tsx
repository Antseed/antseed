import type {JSX, RefObject} from 'react';
import Link from '@docusaurus/Link';
import {ASSETS, PILL, TITLE} from './data';
import {InstallPanel} from './install/InstallPanel';
import {UI_ATTR} from './seed/hand';
import styles from './HeroText.module.css';

/** The news pill, the title and the install block, over the painting. */
export function HeroText({installRef}: {installRef: RefObject<HTMLDivElement | null>}): JSX.Element {
  return (
    <div className={styles.content}>
      <Link className={styles.pill} to={PILL.href} {...{[UI_ATTR]: ''}}>
        <span>{PILL.lead}<b>{PILL.amount}</b>{PILL.tail}</span>
        <span className={styles.chevron}><img src={ASSETS.chevron} width={12} height={12} alt="" /></span>
      </Link>
      <h1 className={styles.title} id="hero-title">{TITLE.ink} <span>{TITLE.muted}</span></h1>
      <InstallPanel rootRef={installRef} />
    </div>
  );
}
