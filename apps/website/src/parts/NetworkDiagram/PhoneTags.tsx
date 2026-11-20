import {useMemo, useRef, type JSX, type RefObject} from 'react';
import clsx from 'clsx';
import {PHONE_TAGS} from './phone';
import {usePhoneTags} from './usePhoneTags';
import styles from './PhoneTags.module.css';

type Props = {
  stage: RefObject<HTMLElement | null>;
  drawings: RefObject<(SVGSVGElement | null)[]>;
  /** The step on show has the ANTS holders. */
  holders: boolean;
};

/** On a phone, who is who over the wordless drawing: buyers, providers and (in Trust) the ANTS holders. */
export function PhoneTags({stage, drawings, holders}: Props): JSX.Element {
  const box = useRef<HTMLDivElement>(null);
  const tags = useRef<(HTMLSpanElement | null)[]>([]);
  const tagRefs = useMemo(() => PHONE_TAGS.map((_, i) => (el: HTMLSpanElement | null) => { tags.current[i] = el; }), []);
  usePhoneTags(stage, box, drawings, tags);
  return (
    <div ref={box} className={styles.tags} aria-hidden="true">
      {PHONE_TAGS.map((t, i) => (
        <span key={t.name} ref={tagRefs[i]} className={clsx(styles.tag, t.holders && styles.holders, t.holders && holders && styles.on)}>{t.name}</span>
      ))}
    </div>
  );
}
