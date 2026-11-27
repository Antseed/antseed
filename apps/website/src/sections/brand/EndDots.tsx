import {useEffect, useRef, useState, type JSX, type RefObject} from 'react';
import {canvasDpr} from '../../lib/ledGrid';
import {useFrameLoop} from '../../lib/useFrameLoop';
import {useInView} from '../../lib/useInView';
import {usePageVisible} from '../../lib/usePageVisible';
import {useSiteTheme} from '../../lib/useSiteTheme';
import {useStill} from '../../lib/useStill';
import {DotField} from '../../parts/PrivacyDots/field';
import {layOutGrid} from '../../parts/PrivacyDots/gridLayout';
import {loadMosaic, type Box, type DotGroup} from '../../parts/PrivacyDots/mosaic';
import {usePointerAndCalls} from '../../parts/PrivacyDots/usePointerAndCalls';
import styles from './EndDots.module.css';

const QUIET_X = 40;   // room the ants leave round the title, px
const QUIET_Y = 32;
const LOAD_MARGIN = '400px 0px';

type Props = {step: number; quietRef: RefObject<HTMLElement | null>};

function quietBox(host: HTMLElement, quiet: HTMLElement | null): Box | null {
  if (!quiet) return null;
  const b = host.getBoundingClientRect();
  const q = quiet.getBoundingClientRect();
  return {l: q.left - b.left - QUIET_X, r: q.right - b.left + QUIET_X, t: q.top - b.top - QUIET_Y, b: q.bottom - b.top + QUIET_Y};
}

/** The brand page's closing band: the privacy dot mosaic laid on a `step` grid filling its positioned parent, with the moving layer
 *  (twinkles, warm dots, ants). The mosaic is fetched once the band nears; the moving layer runs only on screen, with the tab visible
 *  and motion allowed. */
export default function EndDots({step, quietRef}: Props): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const stillCanvas = useRef<HTMLCanvasElement>(null);
  const liveCanvas = useRef<HTMLCanvasElement>(null);
  const field = useRef<DotField | null>(null);
  const night = useSiteTheme() === 'dark';
  const still = useStill();
  const visible = usePageVisible();
  const near = useInView(host, {rootMargin: LOAD_MARGIN, once: true});
  const onScreen = useInView(host);
  const [groups, setGroups] = useState<DotGroup[] | null>(null);
  const [ready, setReady] = useState(false);
  const stillRef = useRef(still);
  stillRef.current = still;

  useEffect(() => {
    if (!near) return;
    let live = true;
    loadMosaic(night).then((g) => { if (live) setGroups(g); }, (err: unknown) => console.warn('brand end dots not drawn', err));
    return () => { live = false; };
  }, [near, night]);

  useEffect(() => {
    const el = host.current;
    const bgCanvas = stillCanvas.current;
    const fgCanvas = liveCanvas.current;
    const bg = bgCanvas?.getContext('2d');
    const fg = fgCanvas?.getContext('2d');
    if (!el || !bgCanvas || !fgCanvas || !bg || !fg || !groups) return;
    const dots = (field.current ??= new DotField(fg));
    const draw = () => {
      const w = el.clientWidth;
      const h = el.clientHeight;
      if (!w || !h) return;
      const dpr = canvasDpr();
      for (const c of [bgCanvas, fgCanvas]) { c.width = w * dpr; c.height = h * dpr; c.style.width = `${w}px`; c.style.height = `${h}px`; }
      bg.setTransform(dpr, 0, 0, dpr, 0, 0);
      fg.setTransform(dpr, 0, 0, dpr, 0, 0);
      const layout = layOutGrid(groups, w, h, step);
      for (const {fill, path} of layout.paths) { bg.fillStyle = fill; bg.fill(path); }
      const quiet = quietBox(el, quietRef.current);
      dots.reset(layout, w, h, quiet ? [quiet] : [], step);
      if (stillRef.current) dots.frame(performance.now());   // still: one frame, the ants where they start
      setReady(true);
    };
    const ro = new ResizeObserver(draw);
    ro.observe(el);
    return () => { ro.disconnect(); bg.clearRect(0, 0, bgCanvas.width, bgCanvas.height); fg.clearRect(0, 0, fgCanvas.width, fgCanvas.height); };
  }, [groups, step, quietRef]);

  // the cursor over the band warms the dots; a click on its background (not a link or the words) calls the ants
  usePointerAndCalls(host, field, 'a, button, h2, p');

  useFrameLoop(ready && onScreen && visible && !still, (now) => field.current?.frame(now));

  return (
    <div ref={host} className={styles.host} aria-hidden="true">
      <canvas ref={stillCanvas} className={styles.mosaic} />
      <canvas ref={liveCanvas} className={styles.live} />
    </div>
  );
}
