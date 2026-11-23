import {useState, type JSX} from 'react';
import clsx from 'clsx';
import {Section} from '../../components';
import {Files, Head, kit} from './Kit';
import {STYLE_REFERENCE} from './assets';
import {PROMPT_PARTS, WATERCOLOUR_PROMPT} from './watercolourPrompt';
import styles from './Prompt.module.css';

/** The illustration style: an image that shows it, then the prompt that painted it, its subject marked to be replaced. */
export default function Prompt(): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard.writeText(WATERCOLOUR_PROMPT).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    }).catch(() => {});
  };
  return (
    <Section cmp="brand/prompt" id="prompt" labelledBy="prompt-title" railClassName={clsx(kit.rail, styles.rail)}>
      <Head eyebrow="Illustration style" id="prompt-title" title={['Watercolour,', 'mostly white paper.']} />
      <div className={clsx(kit.cell, kit.lineTop)}>
        <div className={styles.picture}>
          <img src={STYLE_REFERENCE} width={1376} height={768} loading="lazy" decoding="async" alt="A watercolour meadow, painted by the prompt below." />
        </div>
        <div className={clsx(kit.cap, styles.cap)}>
          <div><p className={kit.capTitle}>Style reference</p><p className={kit.meta}>Painted by the prompt below</p></div>
          <Files items={[{label: 'Download', href: STYLE_REFERENCE}]} />
        </div>
      </div>
      <div className={clsx(kit.cell, kit.lineTop, styles.last)}>
        <pre className={styles.text}>{PROMPT_PARTS.before}<mark>{PROMPT_PARTS.subject}</mark>{PROMPT_PARTS.after}</pre>
        <div className={clsx(kit.cap, styles.cap)}>
          <div><p className={kit.capTitle}>Example prompt</p><p className={kit.meta}>Replace the green part with your subject</p></div>
          <button type="button" className={styles.copy} onClick={copy}>{copied ? 'Copied' : 'Copy prompt'}</button>
        </div>
      </div>
    </Section>
  );
}
