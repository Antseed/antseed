import {useRef, type JSX} from 'react';
import clsx from 'clsx';
import {Actions} from '../../components/Button';
import {Heading, Sub} from '../../components/Heading';
import {Section} from '../../components/Section';
import {ALL_VERSIONS_URL} from '../../lib/useLatestDesktopDownload';
import {DownloadButton} from '../DownloadButton/DownloadButton';
import CtaDots from './CtaDots';
import styles from './CtaBand.module.css';

export type CtaBandProps = {
  /** Put the title's second half on its own line (the network and providers pages). */
  titleBreak?: boolean;
  /** Balance the sub line's two lines (default) or fill the first line first. */
  subWrap?: 'balance' | 'pretty';
};

/** The closing call to action above the footer of every marketing page: download Antseed Desktop. */
export default function CtaBand({titleBreak = false, subWrap = 'balance'}: CtaBandProps): JSX.Element {
  const content = useRef<HTMLDivElement>(null);

  return (
    <Section cmp="site/cta" snap={false} railClassName={styles.rail} labelledBy="cta-title">
      <div className={styles.card}>
        <CtaDots contentRef={content} />
        <div ref={content} className={styles.content}>
          <div className={styles.text}>
            <Heading id="cta-title" className={styles.title} title={['Ask anything,', 'on any model.']} secondLine={titleBreak ? 'break' : 'inline'} />
            <Sub className={clsx(styles.sub, subWrap === 'pretty' && styles.subPretty)}>Antseed runs on your computer. Your chat, your agents and your apps all go through it.</Sub>
          </div>
          <Actions className={styles.actions}>
            <DownloadButton label="os" size="page" />
            <a className={styles.allVersions} href={ALL_VERSIONS_URL} target="_blank" rel="noopener noreferrer">All versions&nbsp;→</a>
          </Actions>
        </div>
      </div>
    </Section>
  );
}
