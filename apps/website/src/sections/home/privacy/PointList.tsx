import type {CSSProperties, JSX, KeyboardEvent, RefObject} from 'react';
import type {PrivacyPoint} from './points';
import type {ChooseHow} from './usePinnedPoints';
import styles from './Privacy.module.css';

const KEY_STEP: Record<string, (i: number, n: number) => number> = {
  ArrowDown: (i) => i + 1, ArrowRight: (i) => i + 1, ArrowUp: (i) => i - 1, ArrowLeft: (i) => i - 1, Home: () => 0, End: (_, n) => n - 1,
};

export const tabId = (p: PrivacyPoint) => `privacy-tab-${p.id}`;
export const panelId = (p: PrivacyPoint) => `privacy-panel-${p.id}`;
/** A point's place in the stacked layout, read by the CSS to put each panel under its name. */
export const stackIndex = (i: number) => ({'--point': i}) as CSSProperties;

type Props = {
  points: readonly PrivacyPoint[];
  current: number;
  choose: (i: number, how: ChooseHow) => void;
  labelledBy: string;
  listRef: RefObject<HTMLDivElement | null>;
  /** One under another, all shown: the names are headings, nothing to choose. */
  stacked: boolean;
};

const PointName = ({point}: {point: PrivacyPoint}) => (
  <>
    <span className={styles.tabName}>{point.name}</span>
    <span className={styles.tabLine} data-line=""><span>{point.line}</span></span>
  </>
);

/** The points as a vertical tablist: the chosen one shows its line under its name, the others dimmed. Stacked, a list of headings. */
export function PointList({points, current, choose, labelledBy, listRef, stacked}: Props): JSX.Element {
  const onKeyDown = (i: number) => (e: KeyboardEvent) => {
    const to = KEY_STEP[e.key];
    if (!to) return;
    e.preventDefault();
    choose((to(i, points.length) + points.length) % points.length, 'key');
  };
  if (stacked) {
    return (
      <div ref={listRef} className={styles.list} data-rv="">
        {points.map((p, i) => (
          <h3 key={p.id} className={styles.tab} id={tabId(p)} style={stackIndex(i)}><PointName point={p} /></h3>
        ))}
      </div>
    );
  }
  return (
    <div ref={listRef} className={styles.list} role="tablist" aria-labelledby={labelledBy} aria-orientation="vertical" data-rv="">
      {points.map((p, i) => (
        <button
          key={p.id}
          className={styles.tab}
          style={stackIndex(i)}
          type="button"
          role="tab"
          id={tabId(p)}
          aria-controls={panelId(p)}
          aria-selected={i === current}
          tabIndex={i === current ? 0 : -1}
          onClick={() => choose(i, 'click')}
          onKeyDown={onKeyDown(i)}>
          <PointName point={p} />
        </button>
      ))}
    </div>
  );
}
