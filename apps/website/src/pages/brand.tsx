import {useEffect, useRef, useState, type JSX} from 'react';
import Layout from '@theme/Layout';
import styles from './brand.module.css';
import {PageHero, Reveal, Section, SectionHeader} from '../components/ui';

/* ── Pheromone trail — same asset + animation as the homepage pricing
   section, rotated horizontal for this small showcase card. ── */
const TRAIL_DOTS = Array.from({length: 11}, (_, i) => 3 + i * 8);
const TRAIL_CYCLE = 1.6;

/* Dot grid step must match .motifSwatchDots background-size (9px tiles,
   dot centered in each tile) so the sparkle lands exactly on a real dot. */
const GRID_STEP = 9;

function DotSparkle() {
  const ref = useRef<HTMLDivElement>(null);
  const [dot, setDot] = useState<{x: number; y: number; key: number} | null>(null);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return undefined;
    let key = 0;
    const pick = () => {
      const el = ref.current;
      if (!el) return;
      const {width, height} = el.getBoundingClientRect();
      const cols = Math.max(1, Math.floor(width / GRID_STEP));
      const rows = Math.max(1, Math.floor(height / GRID_STEP));
      const col = Math.floor(Math.random() * cols);
      const row = Math.floor(Math.random() * rows);
      key += 1;
      setDot({x: GRID_STEP / 2 + col * GRID_STEP, y: GRID_STEP / 2 + row * GRID_STEP, key});
    };
    pick();
    const id = setInterval(pick, 4000);
    return () => clearInterval(id);
  }, []);

  return (
    <div ref={ref} className={styles.dotSparkleLayer} aria-hidden="true">
      {dot && <span key={dot.key} className={styles.dotSparkle} style={{left: dot.x, top: dot.y}} />}
    </div>
  );
}

/* ── Logo assets — built from the existing marks, nothing new invented ── */
type LogoAsset = {
  name: string;
  swatch: 'light' | 'ink';
  svg: string;
  downloadSvg: string;
  downloadPng: string;
};

const ICONS: LogoAsset[] = [
  {
    name: 'Icon - Primary',
    swatch: 'light',
    svg: '/logo.svg',
    downloadSvg: '/logo.svg',
    downloadPng: '/brand/downloads/antseed-icon-green.png',
  },
  {
    name: 'Icon - Money',
    swatch: 'light',
    svg: '/logos/antseed-mark-clay.svg',
    downloadSvg: '/logos/antseed-mark-clay.svg',
    downloadPng: '/brand/downloads/antseed-icon-clay.png',
  },
  {
    name: 'Icon - Black',
    swatch: 'light',
    svg: '/logos/antseed-mark-ink.svg',
    downloadSvg: '/logos/antseed-mark-ink.svg',
    downloadPng: '/brand/downloads/antseed-icon-ink.png',
  },
  {
    name: 'Icon - White',
    swatch: 'ink',
    svg: '/logos/antseed-mark-white.svg',
    downloadSvg: '/logos/antseed-mark-white.svg',
    downloadPng: '/brand/downloads/antseed-icon-white.png',
  },
];

const WORDMARKS: LogoAsset[] = [
  {
    name: 'For light backgrounds',
    swatch: 'light',
    svg: '/logo-light.svg',
    downloadSvg: '/logo-light.svg',
    downloadPng: '/brand/downloads/antseed-logo-light.png',
  },
  {
    name: 'For dark backgrounds',
    swatch: 'ink',
    svg: '/logo-dark.svg',
    downloadSvg: '/logo-dark.svg',
    downloadPng: '/brand/downloads/antseed-logo-dark.png',
  },
  {
    name: 'Monochrome black',
    swatch: 'light',
    svg: '/logos/antseed-wordmark-black.svg',
    downloadSvg: '/logos/antseed-wordmark-black.svg',
    downloadPng: '/brand/downloads/antseed-logo-black.png',
  },
  {
    name: 'Monochrome white',
    swatch: 'ink',
    svg: '/logo-white.svg',
    downloadSvg: '/logo-white.svg',
    downloadPng: '/brand/downloads/antseed-logo-white.png',
  },
];

const COLORS = [
  {name: 'Canvas', hex: '#FFFFFF', use: 'Default page background', bg: '#FFFFFF', border: true},
  {name: 'Surface', hex: '#F4F5F4', use: 'Raised cards and section wells', bg: '#F4F5F4', border: true},
  {name: 'Ink', hex: '#001E12', use: 'Headings, buttons, dark sections', bg: '#001E12'},
  {name: 'Green', hex: '#10B981', use: 'Network, action, live state', bg: '#10B981'},
  {name: 'Forest', hex: '#0A6F4D', use: 'Links and green text on light', bg: '#0A6F4D'},
  {name: 'Clay', hex: '#D79627', use: '$ANTS, USDC, fees, economics only', bg: '#D79627'},
];

export default function BrandPage(): JSX.Element {
  return (
    <Layout
      title="Brand"
      description="A lightweight reference for the Antseed identity: logo, color, typography, visual language, and the principles behind it."
    >
      <PageHero
        kicker="Brand"
        title={<>The Antseed identity, <em>at a glance.</em></>}
        lead="Antseed is an open peer-to-peer network for AI services. Our visual identity reflects the same principles as the protocol itself: openness, precision, transparency, and simplicity."
        animatedDots
      />

      {/* ── LOGO ── */}
      <Section tone="tinted" id="logo">
        <Reveal>
          <SectionHeader
            title="Logo"
            lead="The logo should always remain clear, recognizable, and unobstructed. Prefer the primary logo whenever possible."
          />
        </Reveal>

        <Reveal>
          <div className={styles.logoGroup}>
            <p className={styles.logoGroupLabel}>Wordmark</p>
            <div className={styles.logoGrid}>
              {WORDMARKS.map((item) => (
                <div className={styles.logoCard} key={item.name}>
                  <div className={`${styles.logoPreview} ${item.swatch === 'ink' ? styles.logoPreviewInk : styles.logoPreviewLight}`}>
                    <img src={item.svg} alt={item.name} />
                  </div>
                  <div className={styles.logoMeta}>
                    <span className={styles.logoName}>{item.name}</span>
                    <span className={styles.logoDownloads}>
                      <a href={item.downloadSvg} download>SVG</a>
                      <a href={item.downloadPng} download>PNG</a>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className={styles.logoGroup}>
            <p className={styles.logoGroupLabel}>Icon</p>
            <div className={styles.logoGrid}>
              {ICONS.map((item) => (
                <div className={styles.logoCard} key={item.name}>
                  <div className={`${styles.logoPreview} ${item.swatch === 'ink' ? styles.logoPreviewInk : styles.logoPreviewLight}`}>
                    <img src={item.svg} alt={item.name} className={styles.iconImg} />
                  </div>
                  <div className={styles.logoMeta}>
                    <span className={styles.logoName}>{item.name}</span>
                    <span className={styles.logoDownloads}>
                      <a href={item.downloadSvg} download>SVG</a>
                      <a href={item.downloadPng} download>PNG</a>
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className={styles.kitRow}>
            <p>Every file above, SVG and PNG, in one archive.</p>
            <a href="/brand/downloads/antseed-brand-assets.zip" download className={styles.kitDownload}>
              Download full kit (.zip)
            </a>
          </div>

          <ul className={styles.ruleList}>
            <li><strong>Keep clear space.</strong> Leave room equal to the icon&apos;s width on every side - no text or UI touching the mark.</li>
            <li><strong>Don&apos;t recolor it.</strong> Use the provided variants only. No gradients, outlines, or effects.</li>
            <li><strong>Don&apos;t distort it.</strong> Scale proportionally. Never stretch, rotate, or skew.</li>
          </ul>
        </Reveal>
      </Section>

      {/* ── COLORS ── */}
      <Section id="colors">
        <Reveal>
          <SectionHeader
            title="Colors"
            lead="Our color palette is intentionally restrained. Green highlights the network while neutral tones keep the interface calm and focused."
          />
        </Reveal>
        <Reveal>
          <div className={styles.colorGrid}>
            {COLORS.map((c) => (
              <div className={styles.colorCard} key={c.hex}>
                <div className={styles.colorChip} style={{background: c.bg, borderBottom: c.border ? '1px solid var(--as-line)' : 'none'}} />
                <div className={styles.colorMeta}>
                  <span className={styles.colorName}>{c.name}</span>
                  <span className={styles.colorHex}>{c.hex}</span>
                  <span className={styles.colorUse}>{c.use}</span>
                </div>
              </div>
            ))}
          </div>
        </Reveal>
      </Section>

      {/* ── TYPOGRAPHY ── */}
      <Section tone="tinted" id="typography">
        <Reveal>
          <SectionHeader
            title="Typography"
            lead="Typography should prioritize clarity and readability. Use consistent hierarchy and generous spacing to communicate technical information with confidence."
          />
        </Reveal>
        <Reveal>
          <div className={styles.typeRows}>
            <div className={styles.typeRow}>
              <span className={styles.typeLabel}>Display<span>General Sans · headings</span></span>
              <p className={styles.typeSampleDisplay}>The open market for AI inference</p>
            </div>
            <div className={styles.typeRow}>
              <span className={styles.typeLabel}>UI &amp; Body<span>General Sans · copy, buttons</span></span>
              <p className={styles.typeSampleBody}>Quiet and readable. Used for body text, cards, and buttons - never heavier than 600 weight.</p>
            </div>
            <div className={styles.typeRow}>
              <span className={styles.typeLabel}>Data<span>Geist Mono · numbers, code</span></span>
              <p className={styles.typeSampleData}>
                $ antseed network browse --service minimax
                <span>✓ found 23 peers · sorted by reputation</span>
              </p>
            </div>
          </div>
        </Reveal>
      </Section>

      {/* ── VISUAL LANGUAGE ── */}
      <Section id="visual-language">
        <Reveal>
          <SectionHeader
            title="Visual Language"
            lead="Antseed visuals are inspired by decentralized networks and collective intelligence. Simple geometric forms, subtle dot patterns, and clean technical lines communicate openness without unnecessary complexity."
          />
        </Reveal>
        <Reveal>
          <div className={styles.motifGrid}>
            <div className={styles.motifCard}>
              <div className={`${styles.motifSwatch} ${styles.motifSwatchTrail}`}>
                <div className={styles.trail} aria-hidden="true">
                  <img src="/img/home/dots-down.svg" alt="" className={styles.trailLine} />
                  {TRAIL_DOTS.map((top, i) => {
                    const peak = 0.25 + 0.75 * ((top - 3) / 88);
                    return (
                      <span
                        key={i}
                        className={styles.trailDot}
                        style={{
                          top,
                          animationDelay: `${i * (TRAIL_CYCLE / TRAIL_DOTS.length)}s`,
                          ['--dot-peak' as string]: peak,
                        }}
                      />
                    );
                  })}
                </div>
              </div>
              <h3>Pheromone trail</h3>
              <p>A dotted line motif for dividers and pathfinding - the network finding its route.</p>
            </div>
            <div className={styles.motifCard}>
              <div className={`${styles.motifSwatch} ${styles.motifSwatchDots}`}>
                <DotSparkle />
              </div>
              <h3>Dot grid</h3>
              <p>A quiet network texture behind hero sections. Never opaque enough to fight the content.</p>
            </div>
            <div className={styles.motifCard}>
              <div className={`${styles.motifSwatch} ${styles.motifSwatchGradient}`} />
              <h3>Antseed gradient</h3>
              <p>The signature green gradient - accents, CTAs, and moments that need energy.</p>
            </div>
          </div>
        </Reveal>
      </Section>

      {/* ── BRAND PRINCIPLES ── */}
      <Section tone="tinted" id="principles">
        <Reveal>
          <SectionHeader title="Brand Principles" />
        </Reveal>
        <Reveal>
          <ul className={styles.principlesList}>
            <li><span>1</span>Open by design.</li>
            <li><span>2</span>Simple before decorative.</li>
            <li><span>3</span>Technical, never intimidating.</li>
            <li><span>4</span>Every element has a purpose.</li>
            <li><span>5</span>Build trust through clarity.</li>
          </ul>
        </Reveal>
      </Section>
    </Layout>
  );
}
