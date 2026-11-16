import {useEffect, useState} from 'react';
import styles from './AgentsHeroArt.module.css';

/**
 * /agents hero animation. Three agent apps fire requests (green dots) down
 * dotted lines into the Antseed node; the node pulses on arrival and the
 * request continues to the right, where a counter ticks and the running
 * cost line grows — Antseed price bold, list price struck through.
 *
 * Geometry lives in a 520×340 SVG (the design-system card, scaled up).
 * Motion is SVG animateMotion + CSS keyframes; counters are React state.
 * prefers-reduced-motion freezes everything at a sensible frame.
 */

const AGENTS = [
  {id: 'openclaw', logo: '/logos/openclaw.svg', name: 'OpenClaw', cy: 72},
  {id: 'hermes', logo: '/logos/nousresearch.svg', name: 'Hermes', cy: 170},
  {id: 'codex', logo: '/logos/openai.png', name: 'Codex', cy: 268},
];

const NODE = {cx: 262, cy: 170, r: 44};
const CHIP = {x: 44, size: 56};
const CYCLE = 1.8; // seconds per request, per agent

/* chip right edge → node left edge, easing into the node's centre line */
const inPath = (cy: number) =>
  `M${CHIP.x + CHIP.size + 8} ${cy} C ${CHIP.x + CHIP.size + 70} ${cy}, ${NODE.cx - NODE.r - 70} ${NODE.cy}, ${NODE.cx - NODE.r - 8} ${NODE.cy}`;
const OUT_PATH = `M${NODE.cx + NODE.r + 8} ${NODE.cy} L 326 ${NODE.cy}`;

/* Spec numbers: same task at list $4.86, on Antseed $0.97 (placeholder run). */
const START = {requests: 1204, antseed: 0.97, list: 4.86};
const PER_REQUEST = {antseed: 0.0008, list: 0.004};

const money = (n: number) => `$${n.toFixed(2)}`;

export function AgentsHeroArt() {
  const [tick, setTick] = useState(0);
  const [reduced, setReduced] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    setReduced(mq.matches);
    if (mq.matches) return undefined;
    // one increment per arriving dot (three agents, staggered across the cycle)
    const id = window.setInterval(() => setTick((t) => t + 1), (CYCLE * 1000) / AGENTS.length);
    return () => window.clearInterval(id);
  }, []);

  const requests = START.requests + tick;
  const antseed = START.antseed + tick * PER_REQUEST.antseed;
  const list = START.list + tick * PER_REQUEST.list;

  return (
    <div className={`${styles.well} ${reduced ? styles.reduced : ''}`}>
      <div className={styles.panel}>
        <svg viewBox="0 0 520 340" className={styles.svg} role="img" aria-label="Agents sending requests through Antseed">
          <defs>
            <clipPath id="agentsHeroNode">
              <circle cx={NODE.cx} cy={NODE.cy} r={NODE.r - 2} />
            </clipPath>
          </defs>

          {/* dotted routes in */}
          {AGENTS.map((a) => (
            <path key={a.id} d={inPath(a.cy)} className={styles.route} />
          ))}
          <path d={OUT_PATH} className={styles.route} />

          {/* agent chips */}
          {AGENTS.map((a) => (
            <g key={a.id}>
              <rect x={CHIP.x} y={a.cy - CHIP.size / 2} width={CHIP.size} height={CHIP.size} rx="15" className={styles.chip} />
              <image href={a.logo} x={CHIP.x + 14} y={a.cy - 14} width="28" height="28" preserveAspectRatio="xMidYMid meet" />
            </g>
          ))}

          {/* node */}
          <circle cx={NODE.cx} cy={NODE.cy} r={NODE.r} className={styles.pulse} />
          <circle cx={NODE.cx} cy={NODE.cy} r={NODE.r} className={styles.nodeHalo} />
          <circle cx={NODE.cx} cy={NODE.cy} r={NODE.r} className={styles.node} />
          <image href="/logo.svg" x={NODE.cx - 22} y={NODE.cy - 22} width="44" height="44" clipPath="url(#agentsHeroNode)" />

          {/* travelling requests */}
          {AGENTS.map((a, i) => (
            <circle key={a.id} r="4" className={styles.dot}>
              <animateMotion dur={`${CYCLE}s`} begin={`${(i * CYCLE) / AGENTS.length}s`} repeatCount="indefinite" path={inPath(a.cy)} keyPoints="0;1" keyTimes="0;1" calcMode="linear" />
            </circle>
          ))}
          {AGENTS.map((a, i) => (
            <circle key={`out-${a.id}`} r="4" className={styles.dot}>
              <animateMotion dur={`${CYCLE / 2}s`} begin={`${(i * CYCLE) / AGENTS.length + CYCLE}s`} repeatCount="indefinite" path={OUT_PATH} />
            </circle>
          ))}
        </svg>

        {/* readouts — HTML so the fonts and tabular numbers behave */}
        <div className={styles.readouts}>
          <div className={`${styles.pill} ${styles.pillCost}`}>
            <strong>{money(antseed)}</strong>
            <s>{money(list)}</s>
          </div>
          <div className={styles.pill}>
            <span className={styles.count}>{requests.toLocaleString('en-US')}</span>
            <span className={styles.label}>requests</span>
          </div>
          <div className={`${styles.pill} ${styles.pillMuted}`}>24/7</div>
        </div>
      </div>
    </div>
  );
}
