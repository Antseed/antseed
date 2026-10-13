import {useEffect, useRef, useState, type KeyboardEvent} from 'react';
import {CommandChip} from '../CommandChip';
import {LinkArrow} from '../ui';
import {DownloadCta, GATEWAY_INSTALL_COMMAND, HeroDotCanvas, HeroStatsRow} from '../HomeHero';
import {ModelMarquee} from './ModelMarquee';
import home from '../../pages/index.module.css';
import styles from './LaunchHero.module.css';

/**
 * LAUNCH HERO — the homepage's first fold: headline, a launcher card with
 * the two ways in (set up the gateway, or download the desktop app), the
 * dot ant rising behind the card, the model price marquee and the live
 * network stats band.
 *
 * Both launcher panels are in the static HTML and share one grid cell, so
 * switching tabs never changes the card's height (no layout shift). The
 * dot canvas runs its own clock (there is no demo in this hero to drive it)
 * and pauses off-screen, like the rest of the site's canvases.
 */

type LaunchPath = 'gateway' | 'app';

const PATHS: {id: LaunchPath; label: string}[] = [
  {id: 'gateway', label: 'Set up AI gateway'},
  {id: 'app', label: 'Desktop app'},
];

/** ?use=app opens the desktop tab; ?use=cli / agent / gateway the gateway tab. */
function readUseParam(): LaunchPath | null {
  if (typeof window === 'undefined') return null;
  const use = new URLSearchParams(window.location.search).get('use');
  if (use === 'app') return 'app';
  if (use === 'cli' || use === 'agent' || use === 'gateway') return 'gateway';
  return null;
}

export function LaunchHero() {
  const [path, setPath] = useState<LaunchPath>('gateway');
  const cardRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef(0);
  const shutdownRef = useRef(0);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);

  // Read after mount so server and client render the same default.
  useEffect(() => {
    const fromUrl = readUseParam();
    if (fromUrl) setPath(fromUrl);
  }, []);

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const next = PATHS[(PATHS.findIndex((p) => p.id === path) + 1) % PATHS.length];
    setPath(next.id);
    tabRefs.current[PATHS.indexOf(next)]?.focus();
  };

  return (
    <header className={styles.hero}>
      <HeroDotCanvas
        frameRef={frameRef}
        shutdownRef={shutdownRef}
        originRef={cardRef}
        selfClock
        antScale={0.8}
        antScaleSmall={0.55}
        antLift={60}
      />
      <div className={styles.heroInner}>
        <h1 className={styles.title}>
          The open market
          <br />
          for AI inference
        </h1>
        <p className={styles.sub}>
          Give your agents, apps, and team access to 700+ AI models at lower prices, with built-in
          privacy and full control.
        </p>

        <div className={styles.card} ref={cardRef}>
          <div className={styles.tabs} role="tablist" aria-label="How to start" onKeyDown={onTabKey}>
            {PATHS.map((p, i) => (
              <button
                key={p.id}
                ref={(el) => {
                  tabRefs.current[i] = el;
                }}
                type="button"
                role="tab"
                id={`launch-tab-${p.id}`}
                aria-selected={path === p.id}
                aria-controls={`launch-panel-${p.id}`}
                tabIndex={path === p.id ? 0 : -1}
                className={styles.tab}
                onClick={() => setPath(p.id)}>
                {p.label}
              </button>
            ))}
          </div>
          <div className={styles.panels}>
            <div
              id="launch-panel-gateway"
              role="tabpanel"
              aria-labelledby="launch-tab-gateway"
              className={styles.panel}
              data-active={path === 'gateway' || undefined}
              inert={path !== 'gateway'}>
              <CommandChip command={GATEWAY_INSTALL_COMMAND} size="md" dark className={styles.command} />
              <div className={styles.panelNote}>
                <span>Paste it into a terminal or your agent.</span>
                <LinkArrow to="/docs/quickstart">Gateway docs</LinkArrow>
              </div>
              <span className={`${home.ctaCaption} ${home.ctaCheck} ${styles.panelCheck}`}>
                <i aria-hidden="true" />No signup required
              </span>
            </div>
            <div
              id="launch-panel-app"
              role="tabpanel"
              aria-labelledby="launch-tab-app"
              className={`${styles.panel} ${styles.panelApp}`}
              data-active={path === 'app' || undefined}
              inert={path !== 'app'}>
              <DownloadCta caption="No signup required" />
            </div>
          </div>
        </div>
      </div>

      <ModelMarquee />

      <div className={styles.statsBand}>
        <HeroStatsRow className={styles.stats} />
      </div>
    </header>
  );
}
