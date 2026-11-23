import type {JSX} from 'react';
import {SectionHead} from '../../components';
import styles from './Kit.module.css';

export type FileLink = {label: string; href: string; name?: string};

/** Download links; `name` sets the saved file's name when the file is served under another. */
export function Files({items, label}: {items: readonly FileLink[]; label?: string}): JSX.Element {
  return (
    <span className={styles.files}>
      {label && <span className={styles.meta}>{label}</span>}
      {items.map((f) => <a key={f.href} href={f.href} download={f.name ?? true}>{f.label}</a>)}
    </span>
  );
}

/** The strip under an asset: a short note, its downloads, or both. */
export function Bar({note, files}: {note?: string; files?: readonly FileLink[]}): JSX.Element {
  return (
    <div className={styles.bar}>
      {note ? <p className={styles.meta}>{note}</p> : <span />}
      {files && <Files items={files} label="Download" />}
    </div>
  );
}

export function Head({eyebrow, title, id}: {eyebrow: string; title: readonly [string, string]; id: string}): JSX.Element {
  return <SectionHead eyebrow={eyebrow} id={id} title={title} padX className={styles.head} />;
}

export {styles as kit};
