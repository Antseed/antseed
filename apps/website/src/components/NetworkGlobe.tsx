import {useEffect, useRef, type CSSProperties} from 'react';
import {createGlobe, type GlobeOptions, type GlobeTheme} from './networkGlobeEngine';

/**
 * NETWORK GLOBE — the rotating "open market" globe from the promo video.
 * Requests arc in from peers anywhere on the sphere and land on providers.
 *
 * Fills its parent (give the parent a size). Transparent background, so it
 * sits on any section: pick the palette for the surface it is on. Pauses
 * when scrolled out of view, and shows a still frame for visitors who
 * prefer reduced motion.
 *
 *   <div style={{position: 'relative', height: 560}}>
 *     <NetworkGlobe />
 *   </div>
 */
export function NetworkGlobe({
  theme = 'light',
  glow = true,
  options,
  className,
  style,
}: {
  /** 'dark' for ink sections, 'light' for light ones. */
  theme?: GlobeTheme;
  /** Soft glow (dark palette only). */
  glow?: boolean;
  /** Loop length, arc rate, dot counts, seed. See networkGlobeEngine.ts. */
  options?: GlobeOptions;
  className?: string;
  style?: CSSProperties;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const optionsKey = JSON.stringify(options ?? {});

  useEffect(() => {
    const canvas = canvasRef.current;
    const host = canvas?.parentElement;
    const ctx = canvas?.getContext('2d', {alpha: true});
    if (!canvas || !host || !ctx) return undefined;

    const globe = createGlobe(JSON.parse(optionsKey) as GlobeOptions);
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let width = 0;
    let height = 0;
    let raf = 0;
    let running = false;
    let startedAt = performance.now();
    let pausedT = 0;
    const STILL_T = 4.2; // a nicely busy moment for the reduced-motion still

    const render = (t: number) => {
      ctx.clearRect(0, 0, width, height);
      const size = Math.min(width, height);
      ctx.save();
      ctx.globalCompositeOperation = 'source-over';
      globe.draw(ctx, t, {cx: width / 2, cy: height / 2, size}, {theme, glow});
      ctx.restore();
    };

    const layout = () => {
      const rect = host.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (reducedMotion || !running) render(reducedMotion ? STILL_T : pausedT);
    };

    const tick = (now: number) => {
      render((now - startedAt) / 1000);
      raf = requestAnimationFrame(tick);
    };
    const start = () => {
      if (running || reducedMotion) return;
      running = true;
      startedAt = performance.now() - pausedT * 1000;
      raf = requestAnimationFrame(tick);
    };
    const stop = () => {
      if (!running) return;
      running = false;
      pausedT = (performance.now() - startedAt) / 1000;
      cancelAnimationFrame(raf);
    };

    layout();
    start();

    let visibility: IntersectionObserver | undefined;
    if (typeof IntersectionObserver !== 'undefined') {
      visibility = new IntersectionObserver(([entry]) => (entry.isIntersecting ? start() : stop()));
      visibility.observe(host);
    }
    const resize = new ResizeObserver(layout);
    resize.observe(host);

    return () => {
      stop();
      visibility?.disconnect();
      resize.disconnect();
    };
  }, [theme, glow, optionsKey]);

  return (
    <canvas
      ref={canvasRef}
      className={className}
      style={{position: 'absolute', inset: 0, width: '100%', height: '100%', ...style}}
      aria-hidden="true"
    />
  );
}
