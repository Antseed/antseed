import {useEffect, useRef, useState, type MutableRefObject, type RefObject, type ReactNode} from 'react';
import styles from '../pages/index.module.css';
import cli from './HeroCliVisual.module.css';
import ag from './HeroAgentVisual.module.css';
import {useLatestDesktopDownload} from '../lib/useLatestDesktopDownload';
import {AllVersionsLink} from '../lib/AllVersionsLink';
import {useMobileGetStarted} from '../lib/useMobileGetStarted';
import {useNetworkStats} from '../lib/useNetworkStats';
import {SkillChip} from './SkillChip';
import {Button, ArrowRight} from './ui';
import Link from '@docusaurus/Link';
import {HeroDemo, DEMO_BEATS, DEMO_TOTAL_FRAMES} from './HeroDemo';

/**
 * Homepage hero building blocks, shared with /network: the count-up stats,
 * the ant dot canvas, the rotating subtitle, the download CTA, and the
 * original centred "stacked" hero composition.
 */

/* ============================================================
   COUNT-UP — numbers tick up (expo ease) when scrolled into view.
   Keeps prefix/suffix and digit grouping: "$143K+", "18,440".
   ============================================================ */
export function CountUp({value, duration = 1100}: {value: string; duration?: number}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [text, setText] = useState(value);

  useEffect(() => {
    const el = ref.current;
    const match = value.match(/^(\D*)([\d,.]+)(.*)$/);
    if (!el || !match) return undefined;
    if (
      typeof IntersectionObserver === 'undefined' ||
      window.matchMedia('(prefers-reduced-motion: reduce)').matches
    ) {
      return undefined;
    }
    const prefix = match[1];
    const digits = match[2].replace(/,/g, '');
    const suffix = match[3];
    const target = parseFloat(digits) || 0;
    const decimals = digits.includes('.') ? digits.split('.')[1].length : 0;
    const format = (n: number) =>
      prefix +
      n.toLocaleString('en-US', {minimumFractionDigits: decimals, maximumFractionDigits: decimals}) +
      suffix;
    setText(format(0));
    let raf = 0;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        observer.disconnect();
        const start = performance.now();
        const tick = (now: number) => {
          const t = Math.min((now - start) / duration, 1);
          const eased = t === 1 ? 1 : 1 - Math.pow(2, -10 * t);
          setText(format(t >= 1 ? target : target * eased));
          if (t < 1) raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      },
      {threshold: 0.4},
    );
    observer.observe(el);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [value, duration]);

  return <span ref={ref}>{text}</span>;
}

/* ============================================================
   HERO DOT CANVAS — dot grid that ripples out from the demo and
   surfaces the Antseed ant, in sync with the live demo timeline.
   Ported from the design prototype (Remotion beats at 30 fps).
   ============================================================ */
const BEATS = DEMO_BEATS;
const ANT_H = 800;
const ANT_W = Math.round((15.2738 / 18) * ANT_H);
const DOT_LIGHT = '213,217,215';
const DOT_DARK = '197,208,203';
const SPARKLE_RGB = [16, 185, 129] as const;
const SAMPLE_OFFSETS = [-4, 0, 4];

const parseRgb = (s: string) => s.split(',').map(Number);

const isDarkTheme = () =>
  document.documentElement.dataset.theme === 'dark' ||
  (document.documentElement.dataset.theme !== 'light' &&
    window.matchMedia('(prefers-color-scheme: dark)').matches);

interface HeroDot {
  x: number;
  y: number;
  arrival: number;
  isAnt: boolean;
  sizeFactor: number;
  appearAt: number;
  dissolveAt: number;
  sparkles: {start: number; end: number}[];
}

export function HeroDotCanvas({
  frameRef,
  shutdownRef,
  originRef,
  compact = false,
}: {
  frameRef: MutableRefObject<number>;
  /** 0 while the demo loops; otherwise the manual power-off's virtual frame. */
  shutdownRef: MutableRefObject<number>;
  originRef: RefObject<HTMLDivElement>;
  /** Split hero: the demo sits near the top of a shorter hero, so the ant is
      drawn smaller and centred on the demo instead of riding 120px above it
      (which clipped its head at the hero's top edge). */
  compact?: boolean;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return undefined;
    const ctx = canvas.getContext('2d', {alpha: true});
    if (!ctx) return undefined;
    const host = canvas.parentElement;
    if (!host) return undefined;

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let color = isDarkTheme() ? DOT_DARK : DOT_LIGHT;
    let disposed = false;
    let width = 0;
    let height = 0;
    let dots: HeroDot[] = [];
    let dotScale = 1;

    // Offscreen raster of the ant silhouette, alpha-sampled per dot.
    const antCanvas = document.createElement('canvas');
    antCanvas.width = ANT_W;
    antCanvas.height = ANT_H;
    const antCtx = antCanvas.getContext('2d');
    let antAlpha: Uint8ClampedArray | null = null;
    const antImg = new Image();

    const antCoverage = (x: number, y: number, data: Uint8ClampedArray) => {
      let hit = 0;
      let total = 0;
      for (const dy of SAMPLE_OFFSETS) {
        const py = Math.round(y + dy);
        if (py < 0 || py >= ANT_H) continue;
        for (const dx of SAMPLE_OFFSETS) {
          const px = Math.round(x + dx);
          if (px < 0 || px >= ANT_W) continue;
          total++;
          if (data[(py * ANT_W + px) * 4 + 3] > 40) hit++;
        }
      }
      return total > 0 ? hit / total : 0;
    };

    const layout = () => {
      const rect = host.getBoundingClientRect();
      width = Math.max(1, Math.round(rect.width));
      height = Math.max(1, Math.round(rect.height));
      dotScale = width <= 640 ? 0.6 : 1;
      const step = 9 * dotScale;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // Ripple origin: the demo card (falls back to hero center).
      let originX = width / 2;
      let originY = 0.375 * height;
      const origin = originRef.current;
      if (origin) {
        const o = origin.getBoundingClientRect();
        originX = o.left - rect.left + 0.5 * o.width;
        originY = o.top - rect.top + 0.375 * o.height;
      }
      // Ant placement — scaled and centred on the demo in the split hero.
      let antScale = compact ? 0.5 : 1;
      let antCenterY = originY - 120;
      if (compact && origin) {
        // Size the ant to the demo box (card + "Finding best seller" pill) so
        // its top and bottom line up with the box, and centre it behind it.
        const o = origin.getBoundingClientRect();
        antScale = Math.min(0.75, o.height / ANT_H);
        antCenterY = o.top - rect.top + 0.5 * o.height;
      }
      const antLeft = originX - (ANT_W * antScale) / 2;
      const antTop = antCenterY - (ANT_H * antScale) / 2;
      const diagonal = Math.hypot(width, height);

      const next: HeroDot[] = [];
      for (let y = 0; y <= height + step; y += step) {
        for (let x = 0; x <= width + step; x += step) {
          const dist = Math.hypot(x - originX, y - originY);
          const coverage = antAlpha
            ? antCoverage((x - antLeft) / antScale, (y - antTop) / antScale, antAlpha)
            : 0;
          const isAnt = coverage > 0;
          const sizeFactor = isAnt ? (0.4 + 0.6 * coverage) * (0.85 + 0.3 * Math.random()) : 1;

          // A sparse subset of ant dots twinkle green once the ant has settled.
          const sparkles: {start: number; end: number}[] = [];
          if (isAnt && Math.random() < 0.035) {
            const lifeStart = BEATS.surfaceStart + 70;
            const lifeEnd = BEATS.fadeOutStart - 20;
            let t = lifeStart + Math.random() * (lifeEnd - lifeStart);
            while (t < lifeEnd) {
              const dur = 22 + Math.random() * 12;
              sparkles.push({start: t, end: t + dur});
              t += dur + 200 + Math.random() * 300;
            }
          }

          next.push({
            x,
            y,
            arrival: BEATS.surfaceStart + (dist / diagonal) * 36,
            isAnt,
            sizeFactor,
            appearAt: isAnt ? BEATS.surfaceStart + 40 * Math.random() : 0,
            dissolveAt: isAnt
              ? BEATS.fadeOutStart + Math.random() * (BEATS.fadeOutEnd - BEATS.fadeOutStart)
              : 0,
            sparkles,
          });
        }
      }
      dots = next;
    };

    const antAlphaAt = (frame: number, appearAt: number, dissolveAt: number) => {
      if (frame < appearAt) return 0;
      const fadeIn = Math.min(1, (frame - appearAt) / 3);
      if (frame < dissolveAt) return fadeIn;
      return fadeIn * Math.max(0, 1 - (frame - dissolveAt) / 3);
    };

    const rippleAlphaAt = (sinceArrival: number) => {
      if (sinceArrival < 0) return 0;
      if (sinceArrival < 5) return sinceArrival / 5;
      if (sinceArrival < 8) return 1;
      const fading = sinceArrival - 8;
      return fading < 12 ? 1 - fading / 12 : 0;
    };

    /**
     * Manual power-off: the scene frame is frozen, so the dots dissolve off
     * `shut` — a virtual frame sweeping the loop's own fade-out window. Each
     * dot keeps its staggered `dissolveAt`, so the ant melts away exactly the
     * way it does at the end of a loop.
     */
    const shutdownAlphaAt = (shut: number, dot: HeroDot) => {
      if (shut <= 0) return 1;
      if (!dot.isAnt) return Math.max(0, 1 - (shut - BEATS.fadeOutStart) / 6);
      if (shut < dot.dissolveAt) return 1;
      return Math.max(0, 1 - (shut - dot.dissolveAt) / 3);
    };

    const drawFrame = (frame: number, shut: number) => {
      ctx.clearRect(0, 0, width, height);
      const baseRgb = parseRgb(color);
      const shutT = shut > 0 ? (shut - BEATS.fadeOutStart) / (BEATS.fadeOutEnd - BEATS.fadeOutStart) : 0;
      for (const dot of dots) {
        const alpha =
          (dot.isAnt
            ? antAlphaAt(frame, dot.appearAt, dot.dissolveAt)
            : rippleAlphaAt(frame - dot.arrival)) * shutdownAlphaAt(shut, dot);
        if (alpha <= 0.01) continue;

        let pulse = 0;
        for (const s of dot.sparkles) {
          if (frame >= s.start && frame <= s.end) {
            const progress = (frame - s.start) / (s.end - s.start);
            pulse = Math.sin(progress * Math.PI); // smooth ease in/out, 0 -> 1 -> 0
            break;
          }
        }
        if (shut > 0) pulse *= Math.max(0, 1 - shutT);

        const radius = 2.6 * dotScale * dot.sizeFactor * (0.5 + 0.5 * alpha) * (1 + 0.6 * pulse);

        if (pulse > 0.02) {
          const glowRadius = radius * (1 + 1.6 * pulse);
          ctx.beginPath();
          ctx.fillStyle = `rgba(${SPARKLE_RGB[0]},${SPARKLE_RGB[1]},${SPARKLE_RGB[2]},${0.16 * pulse})`;
          ctx.arc(dot.x, dot.y, glowRadius, 0, 2 * Math.PI);
          ctx.fill();
        }

        ctx.beginPath();
        if (pulse > 0.02) {
          const sparkleT = pulse * 0.7;
          const r = Math.round(baseRgb[0] + (SPARKLE_RGB[0] - baseRgb[0]) * sparkleT);
          const g = Math.round(baseRgb[1] + (SPARKLE_RGB[1] - baseRgb[1]) * sparkleT);
          const b = Math.round(baseRgb[2] + (SPARKLE_RGB[2] - baseRgb[2]) * sparkleT);
          ctx.fillStyle = `rgba(${r},${g},${b},${Math.min(1, 0.75 * alpha + 0.25 * pulse)})`;
        } else {
          ctx.fillStyle = `rgba(${color},${0.75 * alpha})`;
        }
        ctx.arc(dot.x, dot.y, radius, 0, 2 * Math.PI);
        ctx.fill();
      }
    };

    const drawStatic = () => {
      ctx.clearRect(0, 0, width, height);
      for (const dot of dots) {
        ctx.beginPath();
        ctx.fillStyle = `rgba(${color},${dot.isAnt ? 0.4 : 0.16})`;
        ctx.arc(dot.x, dot.y, 2.6 * dotScale * dot.sizeFactor, 0, 2 * Math.PI);
        ctx.fill();
      }
    };

    antImg.src = '/ant-icon.svg';
    antImg.onload = () => {
      if (disposed || !antCtx) return;
      antCtx.clearRect(0, 0, ANT_W, ANT_H);
      antCtx.drawImage(antImg, 0, 0, ANT_W, ANT_H);
      antAlpha = antCtx.getImageData(0, 0, ANT_W, ANT_H).data;
      layout();
      if (reducedMotion) drawStatic();
    };
    layout();

    if (reducedMotion) {
      drawStatic();
      const resize = new ResizeObserver(() => {
        layout();
        drawStatic();
      });
      resize.observe(host);
      return () => {
        disposed = true;
        resize.disconnect();
      };
    }

    let raf = 0;
    const loop = () => {
      drawFrame(frameRef.current % DEMO_TOTAL_FRAMES, shutdownRef.current);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const resize = new ResizeObserver(layout);
    resize.observe(host);
    const themeWatch = new MutationObserver(() => {
      color = isDarkTheme() ? DOT_DARK : DOT_LIGHT;
    });
    themeWatch.observe(document.documentElement, {attributes: true, attributeFilter: ['data-theme']});

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      resize.disconnect();
      themeWatch.disconnect();
    };
  }, [frameRef, shutdownRef, originRef, compact]);

  return <canvas ref={canvasRef} className={styles.heroCanvas} aria-hidden="true" />;
}

/* ============================================================
   ROTATING SUBTITLE — cycles hero phrases, then snaps back.
   (From the hero prototype; the Figma frame shows the first.)
   ============================================================ */
const HERO_PHRASES = [
  'Every AI model at a fraction of the regular cost.',
  'No usage limits. No middleman. Always anonymous.',
];

export function RotatingSub({phrases = HERO_PHRASES}: {phrases?: string[]}) {
  const loop = [...phrases, phrases[0]];
  const [index, setIndex] = useState(0);
  const [animated, setAnimated] = useState(true);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const timer = setTimeout(() => {
      setAnimated(true);
      setIndex((i) => i + 1);
    }, 2400);
    return () => clearTimeout(timer);
  }, [index]);

  useEffect(() => {
    if (index !== loop.length - 1) return undefined;
    const timer = setTimeout(() => {
      setAnimated(false);
      setIndex(0);
    }, 600);
    return () => clearTimeout(timer);
  }, [index]);

  return (
    <span className={styles.heroSub}>
      <span
        className={styles.heroSubTrack}
        style={{
          transform: `translateY(-${1.6 * index}em)`,
          transition: animated ? 'transform 600ms cubic-bezier(0.65, 0, 0.35, 1)' : 'none',
        }}>
        {loop.map((phrase, i) => (
          <span key={i} className={styles.heroSubLine}>
            {phrase}
          </span>
        ))}
      </span>
    </span>
  );
}

/* ============================================================
   HERO
   ============================================================ */
export function DownloadCta({
  caption,
  size = 'lg',
  versionsLink = true,
}: {
  caption?: string;
  size?: 'md' | 'lg';
  versionsLink?: boolean;
}) {
  const download = useLatestDesktopDownload();
  const onGetStarted = useMobileGetStarted();
  return (
    <div className={styles.ctaBlock}>
      {versionsLink && caption ? (
        <>
          <div className={styles.ctaRow}>
            <Button href={download.href} osIcons size={size} className="vprBtn" onClick={onGetStarted}>
              <span className="vprLabelDesktop">Download the AI VPN</span>
              <span className="vprLabelMobile">Get the AI VPN<ArrowRight /></span>
            </Button>
            <AllVersionsLink />
          </div>
          <span className={`${styles.ctaCaption} ${styles.ctaCheck}`}><i aria-hidden="true" />{caption}</span>
        </>
      ) : (
        <>
          <Button href={download.href} osIcons size={size} className="vprBtn" onClick={onGetStarted}>
            <span className="vprLabelDesktop">Download AI VPN</span>
            <span className="vprLabelMobile">Get Started<ArrowRight /></span>
          </Button>
          {versionsLink && <AllVersionsLink />}
          {caption && <span className={styles.ctaCaption}>{caption}</span>}
        </>
      )}
    </div>
  );
}

/* Hero use switch — three ways in. The desktop app is the default; the CLI
   path reuses the commands documented in docs/guides/using-the-api.md and
   the agent path installs skills/join-buyer (also served at /skill.md). */
export type HeroUse = 'app' | 'cli' | 'agent';

const HERO_USES: {id: HeroUse; label: string}[] = [
  {id: 'app', label: 'Download the AI VPN'},
  {id: 'cli', label: 'Install the CLI'},
  {id: 'agent', label: 'For agents'},
];

type HeroTermToken = {text: string; cls?: 'tGreen' | 'tOrange' | 'tYellow' | 'tPurple' | 'tBlue' | 'tWhite' | 'tComment'};
type HeroTermLine = {kind: 'comment' | 'cmd' | 'out'; tokens: HeroTermToken[]};

const cm = (text: string): HeroTermLine => ({kind: 'comment', tokens: [{text, cls: 'tComment'}]});
const out = (text: string): HeroTermLine => ({kind: 'out', tokens: [{text, cls: 'tComment'}]});
const cmd = (...tokens: HeroTermToken[]): HeroTermLine => ({kind: 'cmd', tokens});
const sp = {text: ' '};

/* Same palette as the TerminalCard in the localhost section: purple binary,
   blue subcommand / URL, yellow flag, orange package / model, green string. */
const HERO_CLI_LINES: HeroTermLine[] = [
  cm('# Install the CLI'),
  cmd({text: 'npm', cls: 'tPurple'}, sp, {text: 'install', cls: 'tBlue'}, sp, {text: '-g', cls: 'tYellow'}, sp, {text: '@antseed/cli', cls: 'tOrange'}),
  cm('# Start your local endpoint'),
  cmd({text: 'antseed', cls: 'tPurple'}, sp, {text: 'buyer start', cls: 'tBlue'}),
  out('→ localhost:8377'),
];

const HERO_CLI_STEPS = [
  {label: 'Connect', lines: HERO_CLI_LINES},
  {label: 'Discover', lines: [
    cm('# Find available models'),
    cmd({text: 'curl', cls: 'tPurple'}, {text: ' -s \\\n  localhost:8377/v1/models', cls: 'tBlue'}),
    cm('# One endpoint. Your choice.'),
  ]},
  {label: 'Track usage', lines: [
    cm('# Inspect tokens and spend'),
    cmd({text: 'antseed', cls: 'tPurple'}, sp, {text: 'buyer metering', cls: 'tBlue'}),
    cm('# Fund access to paid models'),
    cmd({text: 'antseed', cls: 'tPurple'}, sp, {text: 'buyer deposit', cls: 'tBlue'}),
  ]},
];

function useCopy(text: string) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const t = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(t);
  }, [copied]);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      /* clipboard unavailable — text stays selectable */
    }
  };
  return {copied, copy};
}

function CopyButton({text, label = 'Copy'}: {text: string; label?: string}) {
  const {copied, copy} = useCopy(text);
  return (
    <button type="button" className={styles.useCopyBtn} onClick={copy} aria-live="polite">
      {copied ? 'Copied' : label}
    </button>
  );
}

/** Typed terminal demo; copying always includes the complete command script. */
function HeroTerminal({lines, footer}: {lines: HeroTermLine[]; footer?: ReactNode}) {
  const total = lines.reduce((n, l) => n + l.tokens.reduce((s, t) => s + t.text.length, 0), 0);
  const [visible, setVisible] = useState(0);
  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setVisible(total);
      return;
    }
    const timer = window.setInterval(() => setVisible(n => {
      if (n >= total) window.clearInterval(timer);
      return Math.min(total, n + 4);
    }), 24);
    return () => window.clearInterval(timer);
  }, [total]);
  let position = 0;
  const script = HERO_CLI_STEPS.flatMap(step => step.lines)
    .filter((l) => l.kind === 'cmd')
    .map((l) => l.tokens.map((t) => t.text).join(''))
    .join('\n');
  return (
    <div className={`${styles.terminal} ${styles.heroTerminal}`}>
      <div className={styles.terminalBar}>
        <span className={styles.tDots}>
          <i style={{background: '#EF4444'}} />
          <i style={{background: '#F59E0B'}} />
          <i style={{background: '#676663'}} />
        </span>
        <span className={styles.terminalStatus}>Antseed CLI</span>
        <CopyButton text={script} label="Copy all" />
      </div>
      <pre className={styles.heroTerminalBody}>
        {lines.map((l, i) => {
          const start = position;
          position += l.tokens.reduce((n, t) => n + t.text.length, 0);
          if (visible <= start) return null;
          let tokenPosition = start;
          return <span key={i}>
            {l.kind === 'cmd' && <span className={styles.tGreen}>$ </span>}
            {l.tokens.map((t, j) => {
              const count = Math.max(0, Math.min(t.text.length, visible - tokenPosition));
              tokenPosition += t.text.length;
              return <span key={j} className={t.cls ? styles[t.cls] : undefined}>{t.text.slice(0, count)}</span>;
            })}
            {'\n'}
          </span>;
        })}
      </pre>
      {footer}
    </div>
  );
}

function readUseParam(): HeroUse | null {
  if (typeof window === 'undefined') return null;
  const v = new URLSearchParams(window.location.search).get('use');
  return v === 'cli' || v === 'agent' || v === 'app' ? v : null;
}

const CLI_ALL = [
  'npm install -g @antseed/cli',
  'antseed buyer start',
  "curl localhost:8377/v1/chat/completions -H 'content-type: application/json' -d '{\"model\": \"deepseek-v4-flash\", \"messages\": [{\"role\": \"user\", \"content\": \"Hello\"}]}'",
  'antseed buyer deposit',
].join('\n');
const CLI_ACTIVITY = ['Proxy listening on localhost:8377', 'Works with any OpenAI-compatible app', 'Antseed routes each request to a provider'];
type CliTok = {cls: 'c'|'g'|'p'|'b'|'y'|'o'|'w'; text: string};
const CLI_LINES: CliTok[][] = [
  [{cls:'c',text:'# Install the CLI'}],
  [{cls:'g',text:'$ '},{cls:'p',text:'npm'},{cls:'b',text:' install'},{cls:'y',text:' -g'},{cls:'o',text:' @antseed/cli'}],
  [{cls:'c',text:'# Start your local endpoint'}],
  [{cls:'g',text:'$ '},{cls:'p',text:'antseed'},{cls:'b',text:' buyer start'}],
  [{cls:'w',text:'→ listening on localhost:8377'}],
  [{cls:'c',text:'# Call it like any OpenAI API'}],
  [{cls:'g',text:'$ '},{cls:'p',text:'curl'},{cls:'b',text:' localhost:8377/v1/chat/completions'},{cls:'w',text:' \\'}],
  [{cls:'y',text:'    -H'},{cls:'o',text:" 'content-type: application/json'"},{cls:'w',text:' \\'}],
  [{cls:'y',text:'    -d'},{cls:'o',text:' \'{"model": "deepseek-v4-flash", "messages": [{"role": "user", "content": "Hello"}]}\''}],
  [{cls:'c',text:'# Fund it for paid models (free ones need nothing)'}],
  [{cls:'g',text:'$ '},{cls:'p',text:'antseed'},{cls:'b',text:' buyer deposit'}],
];

export function HeroCliVisual({active = true}: {active?: boolean}) {
  const [step, setStep] = useState(0);
  const all = useCopy(CLI_ALL);
  useEffect(() => {
    if (!active) return undefined;
    setStep(0);
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    const timer = window.setInterval(() => setStep(s => (s + 1) % CLI_ACTIVITY.length), 2600);
    return () => window.clearInterval(timer);
  }, [active]);
  return (
    <div className={`${ag.card} ${!active ? ag.paused : ''}`}>
      <div className={ag.top}><span><i /> Running on localhost.</span><small>:8377</small></div>
      <div className={`${ag.scene} ${cli.scene}`}>
        <div className={cli.terminal}>
          <div className={cli.bar}>
            <span className={cli.dots}><i style={{background: '#EF4444'}} /><i style={{background: '#F59E0B'}} /><i style={{background: '#676663'}} /></span>
            <span className={cli.barTitle}>Antseed CLI</span>
            <button type="button" className={cli.copy} onClick={all.copy} aria-live="polite">{all.copied ? 'Copied' : 'Copy commands'}</button>
          </div>
          <pre className={cli.body}>
            {CLI_LINES.map((line, i) => <span key={i}>{line.map((t, j) => <span key={j} className={cli[t.cls]}>{t.text}</span>)}{'\n'}</span>)}
          </pre>
        </div>
      </div>
      <div className={ag.activity}><span className={ag.indicator} /><span key={step} className={ag.activityText}>{CLI_ACTIVITY[step]}</span><span className={ag.steps}>{CLI_ACTIVITY.map((_, i) => <i key={i} className={step === i ? ag.current : ''} />)}</span></div>
    </div>
  );
}

export function HeroUseSwitch({use, setUse}: {use: HeroUse; setUse: (value: HeroUse) => void}) {
  return (
    <div className={styles.useSwitch} role="tablist" aria-label="How do you want to use Antseed?">
      {HERO_USES.map((u) => (
        <button
          key={u.id}
          type="button"
          role="tab"
          aria-selected={use === u.id}
          className={`${styles.useSwitchBtn} ${use === u.id ? styles.useSwitchBtnActive : ''}`}
          aria-controls="hero-use-visual"
          id={`hero-tab-${u.id}`}
          onClick={() => setUse(u.id)}>
          {u.label}
        </button>
      ))}
    </div>
  );
}

export function HeroUseCta({use, setUse, showSwitch = true}: {use: HeroUse; setUse: (value: HeroUse) => void; showSwitch?: boolean}) {
  // ?use=cli / ?use=agent preselects a path (docs and social links). Read after
  // mount so server and client render the same default.
  useEffect(() => {
    const fromUrl = readUseParam();
    if (fromUrl) setUse(fromUrl);
  }, []);
  return (
    <div className={styles.ctaBlock}>
      {showSwitch && <HeroUseSwitch use={use} setUse={setUse} />}
      <div className={styles.heroCtaStack}>
        <div className={styles.heroCtaPane} aria-hidden={use !== 'app'} inert={use !== 'app'} data-active={use === 'app'}>
          <DownloadCta caption="No signup required" />
        </div>
        <div className={styles.heroCtaPane} aria-hidden={use !== 'cli'} inert={use !== 'cli'} data-active={use === 'cli'}>
          <Button to="/docs/install" size="lg" arrow>Install the CLI</Button>
          <span className={`${styles.useNote} ${styles.ctaCheck}`}><i aria-hidden="true" />Mac, Windows, Linux, or your server. No account.</span>
        </div>
        <div className={styles.heroCtaPane} aria-hidden={use !== 'agent'} inert={use !== 'agent'} data-active={use === 'agent'}>
          <SkillChip />
          <span className={`${styles.useNote} ${styles.ctaCheck}`}><i aria-hidden="true" />Give your agent the skill. It takes it from there.</span>
        </div>
      </div>
    </div>
  );
}

/* Hero stats — tokens/revenue/providers stream from Antscan's on-chain
   snapshot via useNetworkStats (fallbacks in the hook). Models is still
   hand-maintained: the model directory lives in the network DHT and has
   no public API yet. */

export const HERO_MODELS_STAT = {value: '700+', label: 'Models', accent: true};

/** Tokens / revenue / providers / models, streamed from Antscan. */
export function HeroStatsRow() {
  const stats = useNetworkStats();
  const heroStats: {value: string; label: string; accent?: boolean}[] = [
    {value: stats.tokens, label: 'Tokens processed'},
    {value: stats.revenue, label: 'Network revenue'},
    {value: stats.providers, label: 'Providers'},
    HERO_MODELS_STAT,
  ];
  return (
    <dl className={styles.statsRow}>
      {heroStats.map((s) => (
        <div key={s.label} className={styles.stat}>
          <dd className={`${styles.statValue} ${s.accent ? styles.statAccent : ''}`}>
            <CountUp value={s.value} />
          </dd>
          <dt className={styles.statLabel}>{s.label}</dt>
        </div>
      ))}
    </dl>
  );
}

/** The original centred hero: title, rotating line, CTA, full demo scene, stats. */
export function StackedHero({
  title,
  phrases,
  caption,
}: {
  title: ReactNode;
  phrases?: string[];
  caption?: string;
}) {
  const demoRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef(0);
  const shutdownRef = useRef(0);
  return (
    <header className={styles.hero}>
      <HeroDotCanvas frameRef={frameRef} shutdownRef={shutdownRef} originRef={demoRef} />
      <div className={styles.heroInner}>
        <h1 className={styles.heroTitle}>{title}</h1>
        <RotatingSub phrases={phrases} />
        <DownloadCta caption={caption} />
        <div className={styles.demoFrame} ref={demoRef}>
          <HeroDemo frameRef={frameRef} shutdownRef={shutdownRef} />
        </div>
        <HeroStatsRow />
      </div>
    </header>
  );
}
