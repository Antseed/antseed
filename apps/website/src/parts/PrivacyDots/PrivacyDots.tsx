import {useEffect, useRef, useState, type JSX, type RefObject} from 'react';
import {useFrameLoop} from '../../lib/useFrameLoop';
import {useInView} from '../../lib/useInView';
import {usePageVisible} from '../../lib/usePageVisible';
import {useSiteTheme} from '../../lib/useSiteTheme';
import {useStill} from '../../lib/useStill';
import {DotField, type Box} from './field';
import {layOut, loadMosaic, type DotGroup} from './mosaic';
import styles from './PrivacyDots.module.css';

const MAX_DPR = 2;
/** Room the ants leave round the title, px. */
const QUIET_X = 40;
const QUIET_Y = 32;

type Props = {
  /** The band's title block: the ants keep clear of it. */
  quietRef?: RefObject<HTMLElement | null>;
};

/** The dot mosaic behind a dark privacy band: fills its positioned parent. The still dots are drawn once per size and theme; the moving
 *  layer runs only while the band is on screen, the tab visible and motion allowed. The cursor warms the dots; a click calls the ants. */
export function PrivacyDots({quietRef}: Props): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null);
  const stillRef = useRef<HTMLCanvasElement>(null);
  const liveRef = useRef<HTMLCanvasElement>(null);
  const fieldRef = useRef<DotField | null>(null);
  const theme = useSiteTheme();
  const still = useStill();
  const visible = usePageVisible();
  const onScreen = useInView(hostRef);
  const [groups, setGroups] = useState<DotGroup[] | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let current = true;
    loadMosaic(theme === 'dark')
      .then((g) => { if (current) setGroups(g); })
      .catch((err: unknown) => console.warn('privacy dots not drawn', err));
    return () => { current = false; };
  }, [theme]);

  useDotLayout(hostRef, stillRef, liveRef, fieldRef, groups, quietRef, setReady);
  usePointerAndCalls(hostRef, fieldRef);
  useFrameLoop(ready && onScreen && visible && !still, (now) => fieldRef.current?.frame(now));

  return (
    <div ref={hostRef} className={styles.host} aria-hidden="true">
      <canvas ref={stillRef} className={styles.canvas} />
      <canvas ref={liveRef} className={styles.canvas} />
    </div>
  );
}

/** Lays the mosaic out at the host's size (again on resize or a new theme) and resets the moving field. */
function useDotLayout(
  hostRef: RefObject<HTMLDivElement | null>, stillRef: RefObject<HTMLCanvasElement | null>, liveRef: RefObject<HTMLCanvasElement | null>,
  fieldRef: RefObject<DotField | null>, groups: DotGroup[] | null, quietRef: RefObject<HTMLElement | null> | undefined,
  setReady: (v: boolean) => void,
): void {
  useEffect(() => {
    const host = hostRef.current;
    const bgCanvas = stillRef.current;
    const fgCanvas = liveRef.current;
    const bg = bgCanvas?.getContext('2d');
    const fg = fgCanvas?.getContext('2d');
    if (!host || !bgCanvas || !fgCanvas || !bg || !fg || !groups) return;
    const field = (fieldRef.current ??= new DotField(fg));
    let size = '';
    const draw = () => {
      const w = host.clientWidth;
      const h = host.clientHeight;
      if (!w || !h || `${w}x${h}` === size) return;
      size = `${w}x${h}`;
      const dpr = Math.min(MAX_DPR, window.devicePixelRatio || 1);
      for (const c of [bgCanvas, fgCanvas]) { c.width = w * dpr; c.height = h * dpr; c.style.width = `${w}px`; c.style.height = `${h}px`; }
      bg.setTransform(dpr, 0, 0, dpr, 0, 0);
      fg.setTransform(dpr, 0, 0, dpr, 0, 0);
      bg.clearRect(0, 0, w, h);
      const layout = layOut(groups, w, h);
      for (const {fill, path} of layout.paths) { bg.fillStyle = fill; bg.fill(path); }
      field.reset(layout, w, h, quietBox(host, quietRef?.current ?? null));
      setReady(true);
    };
    const ro = new ResizeObserver(draw);
    ro.observe(host);
    return () => { ro.disconnect(); bg.clearRect(0, 0, bgCanvas.width, bgCanvas.height); };
  }, [hostRef, stillRef, liveRef, fieldRef, groups, quietRef, setReady]);
}

function quietBox(host: HTMLElement, quiet: HTMLElement | null): Box | null {
  if (!quiet) return null;
  const b = host.getBoundingClientRect();
  const q = quiet.getBoundingClientRect();
  return {l: q.left - b.left - QUIET_X, r: q.right - b.left + QUIET_X, t: q.top - b.top - QUIET_Y, b: q.bottom - b.top + QUIET_Y};
}

/** The cursor over the band warms the dots; a click on its background (not on a card, link or the title) calls the ants. */
function usePointerAndCalls(hostRef: RefObject<HTMLDivElement | null>, fieldRef: RefObject<DotField | null>): void {
  useEffect(() => {
    const band = hostRef.current?.parentElement;
    const host = hostRef.current;
    if (!band || !host) return;
    const at = (e: MouseEvent) => { const b = host.getBoundingClientRect(); return {x: e.clientX - b.left, y: e.clientY - b.top}; };
    const move = (e: PointerEvent) => fieldRef.current?.setPointer(at(e));
    const leave = () => fieldRef.current?.setPointer(null);
    const click = (e: MouseEvent) => {
      if ((e.target as Element).closest('a, button, article, h2, p')) return;
      fieldRef.current?.callAnts(at(e));
    };
    band.addEventListener('pointermove', move, {passive: true});
    band.addEventListener('pointerleave', leave);
    band.addEventListener('click', click);
    return () => {
      band.removeEventListener('pointermove', move);
      band.removeEventListener('pointerleave', leave);
      band.removeEventListener('click', click);
    };
  }, [hostRef, fieldRef]);
}
