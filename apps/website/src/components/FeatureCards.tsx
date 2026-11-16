import type {ReactNode} from 'react';
import {LinkArrow, Reveal} from './ui';
import styles from './home/WhatYouGet.module.css';

export type FeatureCardItem = {
  tag: string;
  title: string;
  body: string;
  cta: string;
  to: string;
  art: ReactNode;
};

/** Shared card layout; each section supplies its own copy and artwork. */
export function FeatureCards({items, className}: {items: readonly FeatureCardItem[]; className?: string}) {
  return (
    <div className={[styles.grid, className].filter(Boolean).join(' ')}>
      {items.map((item, i) => (
        <Reveal key={item.tag} className={styles.card} delay={i * 60}>
          <div className={styles.art} aria-hidden="true">{item.art}</div>
          <div className={styles.body}>
            <p className={styles.tag}>{item.tag}</p>
            <h3 className={styles.title}>{item.title}</h3>
            <p className={styles.text}>{item.body}</p>
            <LinkArrow to={item.to} className={styles.cta}>{item.cta}</LinkArrow>
          </div>
        </Reveal>
      ))}
    </div>
  );
}
