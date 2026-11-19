import {useRef, useState, type JSX, type KeyboardEvent, type RefObject} from 'react';
import clsx from 'clsx';
import Link from '@docusaurus/Link';
import {OS_NAMES, useDesktopDownload, type Os} from '../../../../parts/DownloadButton/useDesktopDownload';
import {ASSETS, GATEWAY_COMMAND, GATEWAY_DOCS} from '../data';
import {UI_ATTR} from '../seed/hand';
import {OsIcon} from './OsIcon';
import {VersionsDialog} from './VersionsDialog';
import {useCopy} from '../../../../lib/useCopy';
import {useTabThumb} from './useTabThumb';
import styles from './InstallPanel.module.css';

type TabId = 'app' | 'gateway';
const TABS: {id: TabId; label: string}[] = [
  {id: 'app', label: 'Desktop app'},
  {id: 'gateway', label: 'Set Up Gateway'},
];
const KEY_STEP: Record<string, (i: number, n: number) => number> = {
  ArrowRight: (i) => i + 1, ArrowLeft: (i) => i - 1, Home: () => 0, End: (_, n) => n - 1,
};
const CHECK_ICON = `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M2.9 7.4l2.7 2.7 5.5-5.9" stroke="#E9F1EC" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>')}`;

const others = (os: Os) => (Object.keys(OS_NAMES) as Os[]).filter((o) => o !== os).map((o) => OS_NAMES[o]).join(' and ');

function GatewayPanel(): JSX.Element {
  const {copied, copy} = useCopy();
  return (
    <>
      <div className={styles.row}>
        <em className={styles.prompt}>$</em><code className={styles.command}>{GATEWAY_COMMAND}</code>
        <button className={styles.copy} type="button" aria-label={copied ? 'Copied' : 'Copy'} onClick={() => copy(GATEWAY_COMMAND)}>
          <img src={copied ? CHECK_ICON : ASSETS.copy} width={14} height={14} alt="" />
        </button>
      </div>
      <p className={styles.foot}>Paste it into a terminal or your agent. <Link to={GATEWAY_DOCS}>Gateway docs →</Link></p>
    </>
  );
}

function AppPanel(): JSX.Element {
  const target = useDesktopDownload();
  const dialog = useRef<HTMLDialogElement>(null);
  return (
    <>
      <div className={clsx(styles.row, styles.appRow)}>
        <span className={styles.appName}>Antseed Desktop</span>
        <a className={styles.get} href={target.href} target="_blank" rel="noopener noreferrer" onClick={target.onClick}>
          {target.os && <OsIcon os={target.os} />}
          <span className={styles.long}>{target.os ? `Download for ${OS_NAMES[target.os]}` : 'Download'}</span>
          <span className={styles.short}>Download</span>
        </a>
      </div>
      <p className={styles.foot}>
        <span>{target.os ? `Also on ${others(target.os)}.` : 'For macOS, Windows and Linux.'}</span>{' '}
        <button type="button" onClick={() => dialog.current?.showModal()}>All versions →</button>
      </p>
      <VersionsDialog dialogRef={dialog} detected={target.detected} />
    </>
  );
}

const PANELS: Record<TabId, () => JSX.Element> = {app: AppPanel, gateway: GatewayPanel};

/** How to start: the Desktop app's download, or the AI gateway's install command. */
export function InstallPanel({rootRef}: {rootRef?: RefObject<HTMLDivElement | null>}): JSX.Element {
  const [selected, setSelected] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const panels = useRef<(HTMLDivElement | null)[]>([]);
  useTabThumb(list, selected, panels, styles.ready);

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const step = KEY_STEP[e.key];
    if (!step) return;
    e.preventDefault();
    const next = (step(i, TABS.length) + TABS.length) % TABS.length;
    setSelected(next);
    list.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus();
  };

  return (
    <div ref={rootRef} className={styles.install} {...{[UI_ATTR]: ''}}>
      <div ref={list} className={styles.tabs} role="tablist" aria-label="How to start">
        {TABS.map((t, i) => (
          <button key={t.id} type="button" role="tab" id={`hero-tab-${t.id}`} aria-selected={i === selected} aria-controls={`hero-panel-${t.id}`}
            tabIndex={i === selected ? 0 : -1} onClick={() => setSelected(i)} onKeyDown={(e) => onKey(e, i)}>{t.label}</button>
        ))}
      </div>
      <div className={styles.panels}>
        {TABS.map((t, i) => {
          const Panel = PANELS[t.id];
          return (
            <div key={t.id} ref={(el) => { panels.current[i] = el; }} className={styles.panel} id={`hero-panel-${t.id}`} role="tabpanel"
              aria-labelledby={`hero-tab-${t.id}`} inert={i !== selected}>
              <Panel />
            </div>
          );
        })}
      </div>
    </div>
  );
}
