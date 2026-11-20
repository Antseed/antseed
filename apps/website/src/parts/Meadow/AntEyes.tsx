import {useEffect, useRef, useState, type CSSProperties, type JSX} from 'react';
import clsx from 'clsx';
import {ANTS, KIT_DIR, antCentres, cellPosition, type EyeKit, type Phase} from './eyeKit';
import styles from './Meadow.module.css';

/** One eye's live parts, moved per frame by useEyeTracking. */
export type EyeNode = {ant: number; rest: [number, number]; travel: [number, number]; pupil: HTMLElement; lid: HTMLElement;
  lids: string[]; blinks: number[]; blinkState: number; transform: string};
export type EyeSet = {frame: HTMLElement; ants: [number, number][]; eyes: EyeNode[]};

type Props = {kit: EyeKit; phase: Phase; className?: string; onReady: (phase: Phase, set: EyeSet | null) => void};

/** The awake ants' eyes for one theme, drawn over its film once the sheet is decoded (so they never flash in half-loaded). */
export default function AntEyes({kit, phase, className, onReady}: Props): JSX.Element | null {
  const sheet = kit[phase];
  const src = KIT_DIR + sheet.sheet;
  const [decoded, setDecoded] = useState(false);
  const frame = useRef<HTMLDivElement>(null);
  const pupils = useRef<(HTMLElement | null)[]>([]);
  const lids = useRef<(HTMLElement | null)[]>([]);
  const entries = Object.entries(sheet.eyes);

  useEffect(() => {
    let live = true;
    const img = new Image();
    img.src = src;
    img.decode().then(() => { if (live) setDecoded(true); }, () => {});
    return () => { live = false; };
  }, [src]);

  useEffect(() => {
    if (!decoded || !frame.current) return;
    const eyes = entries.map(([name, eye], i): EyeNode => {
      const blinks = new Array<number>(kit.frames).fill(0);
      for (const [f, cell] of Object.entries(eye.blink)) blinks[Number(f)] = cell;
      return {ant: ANTS.findIndex((a) => a.includes(name)), rest: eye.rest, travel: eye.travel, pupil: pupils.current[i]!, lid: lids.current[i]!,
        lids: eye.cells.slice(2).map((c) => cellPosition(sheet, eye, c)), blinks, blinkState: 0, transform: ''};
    });
    onReady(phase, {frame: frame.current, ants: antCentres(sheet), eyes});
    return () => onReady(phase, null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decoded, kit, phase]);

  if (!decoded) return null;
  const [vw, vh] = kit.video;
  const [sw, sh] = sheet.sheetSize;
  return (
    <div className={clsx(styles.eyes, className)}>
      <div ref={frame} className={styles.eyeFrame}>
        {entries.map(([name, eye], i) => {
          const [x, y, w, h] = eye.box;
          const [iw, ih] = eye.size;
          const style = {left: `${(x / vw) * 100}%`, top: `${(y / vh) * 100}%`, width: `${(w / vw) * 100}%`, height: `${(h / vh) * 100}%`,
            '--sheet': `url("${src}")`, '--sheet-size': `${(sw / iw) * 100}% ${(sh / ih) * 100}%`,
            '--white': cellPosition(sheet, eye, eye.cells[0]), '--pupil': cellPosition(sheet, eye, eye.cells[1])} as CSSProperties;
          return (
            <i key={name} className={styles.eye} style={style}>
              <b className={clsx(styles.eyePart, styles.white)} />
              <b className={clsx(styles.eyePart, styles.iris)}><b ref={(el) => { pupils.current[i] = el; }} className={clsx(styles.eyePart, styles.pupil)} /></b>
              <b ref={(el) => { lids.current[i] = el; }} className={clsx(styles.eyePart, styles.lid)} />
            </i>
          );
        })}
      </div>
    </div>
  );
}
