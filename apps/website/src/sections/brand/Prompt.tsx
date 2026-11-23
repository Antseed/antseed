import {useState, type JSX} from 'react';
import clsx from 'clsx';
import {Section, ThemedImg} from '../../components';
import {Bar, Head, kit} from './Kit';
import {MEADOW, backgroundFiles} from './assets';
import {WATERCOLOUR_PROMPT} from './watercolourPrompt';
import styles from './Prompt.module.css';

/** The prompt that paints the hero's meadow, beside the painting. */
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
      <Head eyebrow="Prompt" id="prompt-title" title={['Watercolour,', 'mostly white paper.']} />
      <div className={kit.pair}>
        <div className={clsx(kit.cell, kit.lineTop, styles.picture)}>
          <ThemedImg day={MEADOW.day} night={MEADOW.night} alt="The Antseed meadow watercolour." className={styles.image} />
        </div>
        <div className={clsx(kit.cell, kit.lineTop, kit.lineLeft, styles.text)}>
          <pre>{WATERCOLOUR_PROMPT}</pre>
          <div><button type="button" className={styles.copy} onClick={copy}>{copied ? 'Copied' : 'Copy prompt'}</button></div>
        </div>
      </div>
      <div className={styles.close}><Bar files={backgroundFiles(MEADOW)} /></div>
    </Section>
  );
}
