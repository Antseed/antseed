import {useRef, type JSX, type KeyboardEvent} from 'react';
import clsx from 'clsx';
import {useTabIndicator} from './useTabIndicator';
import styles from './MediaTabs.module.css';

type Tab<T extends string> = {id: T; label: string};

type Props<T extends string> = {
  tabs: ReadonlyArray<Tab<T>>;
  selected: T;
  onSelect: (id: T) => void;
  /** id of the tab panel they control; each tab's id is `${panelId}-${tab.id}`. */
  panelId: string;
  label: string;
  className?: string;
};

const KEYS: Record<string, (i: number, n: number) => number> = {
  ArrowRight: (i) => i + 1, ArrowLeft: (i) => i - 1, Home: () => 0, End: (_, n) => n - 1,
};

/** Full-width tabs over a hairline, a green line sliding under the chosen one. Arrow keys, Home and End move between them. */
export function MediaTabs<T extends string>({tabs, selected, onSelect, panelId, label, className}: Props<T>): JSX.Element {
  const barRef = useRef<HTMLDivElement>(null);
  const index = tabs.findIndex((t) => t.id === selected);
  useTabIndicator(barRef, index);

  const onKey = (e: KeyboardEvent<HTMLButtonElement>, i: number) => {
    const to = KEYS[e.key]?.(i, tabs.length);
    if (to === undefined) return;
    e.preventDefault();
    const next = (to + tabs.length) % tabs.length;
    barRef.current?.querySelectorAll<HTMLElement>('[role="tab"]')[next]?.focus();
    onSelect(tabs[next].id);
  };

  return (
    <div ref={barRef} className={clsx(styles.tabs, className)} role="tablist" aria-label={label} data-rv="">
      {tabs.map((t, i) => (
        <button key={t.id} type="button" role="tab" id={`${panelId}-${t.id}`} aria-controls={panelId} aria-selected={i === index}
          tabIndex={i === index ? 0 : -1} className={styles.tab} onClick={() => onSelect(t.id)} onKeyDown={(e) => onKey(e, i)}>
          {t.label}
        </button>
      ))}
    </div>
  );
}
