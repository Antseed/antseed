// Decorative SVG flow diagram showing how the staking loop works. Purely
// presentational — no on-chain reads. Two renderings:
//   - Desktop: wide SVG with animated USDC coins + marching ants
//   - Mobile: vertical stream layout (FlowMobile) because the wide SVG
//             compresses illegibly on narrow screens

import { AntsTokenCoinInline, AntsTokenLogo, AntIcon, AntInline, DiemLogo, UsdcLogo } from './icons';

const ANTSEED_PRICING_URL = 'https://antseed.com/network';

export function FlowDiagram() {
  const models = ['llama-3.3', 'qwen-3', 'mistral', 'gemma-3', 'deepseek'];
  const modelCycleDur = 10;

  const usdcReturnPath =
    'M 950 210 C 1020 320, 720 400, 500 395 C 280 390, 110 330, 150 210';

  const usdcCoins = [
    { scale: 1.3,  delay: 0,    dur: 5.5 },
    { scale: 0.75, delay: 0.65, dur: 5.5 },
    { scale: 1.0,  delay: 1.3,  dur: 5.5 },
    { scale: 1.5,  delay: 1.95, dur: 5.5 },
    { scale: 0.85, delay: 2.6,  dur: 5.5 },
    { scale: 1.15, delay: 3.25, dur: 5.5 },
    { scale: 0.9,  delay: 3.9,  dur: 5.5 },
    { scale: 1.35, delay: 4.55, dur: 5.5 },
  ];

  const ants = [
    { x: 130, delay: 0 },
    { x: 155, delay: 0.35 },
    { x: 180, delay: 0.7 },
    { x: 140, delay: 1.05 },
    { x: 165, delay: 1.4 },
    { x: 175, delay: 1.75 },
  ];
  const antCycle = 7;
  const antMarchDur = 2.2;

  return (
    <div className="flow-diagram">
      <svg viewBox="0 0 1100 420" className="flow-svg" preserveAspectRatio="xMidYMid meet">
        <defs>
          <radialGradient id="ants-coin-face" cx="38%" cy="30%" r="75%">
            <stop offset="0%" stopColor="#1b2230" />
            <stop offset="55%" stopColor="#0f1622" />
            <stop offset="100%" stopColor="#06090e" />
          </radialGradient>
          <linearGradient id="ants-coin-edge" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffcf74" />
            <stop offset="100%" stopColor="#c8792a" />
          </linearGradient>
          <filter id="coin-glow">
            <feGaussianBlur stdDeviation="1.5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
          <marker
            id="arrow-clay"
            viewBox="0 0 10 10"
            refX="8"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto"
          >
            <path d="M 0 0 L 10 5 L 0 10 Z" fill="#e8a33d" />
          </marker>

          {/* Reusable coin shapes — centred on (0,0) so animateMotion places the centre on the path */}
          <g id="usdc-coin-svg">
            <circle r="14" fill="#2775CA" />
            <circle r="10" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="0.6" />
            <text
              x="0"
              y="5"
              textAnchor="middle"
              fontFamily="system-ui, -apple-system, sans-serif"
              fontSize="15"
              fontWeight={700}
              fill="#fff"
            >
              $
            </text>
          </g>
          {/* Official DIEM token icon (see src/components/icons.tsx).
              36×36 bounding box centred on (0,0) so the symbol drops in
              where the prior gradient-circle version did without relayout. */}
          <g id="diem-coin-svg">
            <image href="/diem-logo.png" x="-18" y="-18" width="36" height="36" />
          </g>
        </defs>

        {/* Forward arrows: Pool → Inference → User */}
        <g>
          <line x1="260" y1="145" x2="418" y2="145" stroke="#e8a33d" strokeWidth="2.5" strokeDasharray="8 6" markerEnd="url(#arrow-clay)">
            <animate attributeName="stroke-dashoffset" from="0" to="-28" dur="1s" repeatCount="indefinite" />
          </line>
          <line x1="680" y1="145" x2="838" y2="145" stroke="#e8a33d" strokeWidth="2.5" strokeDasharray="8 6" markerEnd="url(#arrow-clay)">
            <animate attributeName="stroke-dashoffset" from="0" to="-28" dur="1s" repeatCount="indefinite" />
          </line>
        </g>

        {/* "thinking" model bubbles above the User node, cycling through names */}
        {models.map((name, i) => {
          const slotStart = i / models.length;
          const slotEnd = (i + 1) / models.length;
          const fade = 0.01;
          const keyTimes = [0, Math.max(0, slotStart - fade), slotStart, slotEnd, Math.min(1, slotEnd + fade), 1].join(';');
          const values = [0, 0, 1, 1, 0, 0].join(';');
          return (
            <g key={`think-${i}`} opacity="0">
              <rect x="840" y="40" width="220" height="34" rx="17" fill="var(--flow-node-dark)" stroke="var(--green)" strokeWidth="1.5" />
              <circle cx="858" cy="57" r="3" fill="var(--green)">
                <animate attributeName="opacity" values="0.3;1;0.3" dur="1.2s" repeatCount="indefinite" />
              </circle>
              <circle cx="868" cy="57" r="3" fill="var(--green)">
                <animate attributeName="opacity" values="0.3;1;0.3" dur="1.2s" repeatCount="indefinite" begin="0.2s" />
              </circle>
              <circle cx="878" cy="57" r="3" fill="var(--green)">
                <animate attributeName="opacity" values="0.3;1;0.3" dur="1.2s" repeatCount="indefinite" begin="0.4s" />
              </circle>
              <text x="955" y="61" textAnchor="middle" fontFamily="'Share Tech Mono', monospace" fontSize="12" fontWeight={600} fill="var(--flow-inference-text)">
                thinking · {name}
              </text>
              <animate attributeName="opacity" values={values} keyTimes={keyTimes} dur={`${modelCycleDur}s`} repeatCount="indefinite" />
            </g>
          );
        })}
        <polygon points="944,74 956,74 950,82" fill="var(--flow-node-dark)" stroke="var(--green)" strokeWidth="1.5" />

        <path
          id="return-path"
          d={usdcReturnPath}
          stroke="#2775CA"
          strokeWidth="1.2"
          strokeDasharray="4 8"
          strokeLinecap="round"
          fill="none"
          opacity="0.22"
        />

        {/* Node 1: $DIEM Pool */}
        <g>
          <rect x="40" y="90" width="220" height="110" rx="16" fill="rgba(232,163,61,0.11)" stroke="#e8a33d" strokeWidth="2" />
          <g transform="translate(72 142)"><use href="#diem-coin-svg" /></g>
          <text x="105" y="135" fontFamily="'Oxanium', system-ui, sans-serif" fontSize="18" fontWeight={700} fill="var(--flow-econ-text)">$DIEM</text>
          <text x="105" y="156" fontFamily="'Oxanium', system-ui, sans-serif" fontSize="15" fontWeight={600} fill="var(--flow-econ-text)">Capacity</text>
          <text x="105" y="180" fontFamily="'Share Tech Mono', monospace" fontSize="10" fill="var(--flow-econ-muted)" letterSpacing="0.6">participants lock</text>
          <text x="55" y="108" fontFamily="'Share Tech Mono', monospace" fontSize="9" fontWeight={700} fill="#e8a33d" opacity="0.9" letterSpacing="1">01</text>
        </g>

        {/* Node 2: Providing Inference (clickable) */}
        <a href={ANTSEED_PRICING_URL} target="_blank" rel="noopener noreferrer">
          <g className="flow-node-inference-g">
            <rect x="420" y="90" width="260" height="110" rx="16" fill="var(--flow-node-dark)" stroke="var(--green)" strokeWidth="2" />
            <text x="550" y="128" textAnchor="middle" fontFamily="'Oxanium', system-ui, sans-serif" fontSize="17" fontWeight={700} fill="var(--flow-inference-text)">Providing Inference</text>
            <text x="550" y="150" textAnchor="middle" fontFamily="'Oxanium', system-ui, sans-serif" fontSize="14" fontWeight={500} fill="var(--flow-inference-muted)">on Antseed</text>
            <text x="550" y="178" textAnchor="middle" fontFamily="'Share Tech Mono', monospace" fontSize="10" fontWeight={700} fill="var(--green)" letterSpacing="1.4">◆ SEE PRICING →</text>
            <text x="434" y="108" fontFamily="'Share Tech Mono', monospace" fontSize="9" fontWeight={700} fill="var(--green)" opacity="0.9" letterSpacing="1">02</text>
          </g>
        </a>

        {/* Node 3: User Consumes */}
        <g>
          <rect x="840" y="90" width="220" height="110" rx="16" fill="rgba(232,163,61,0.1)" stroke="#e8a33d" strokeWidth="2" />
          <text x="950" y="132" textAnchor="middle" fontFamily="'Oxanium', system-ui, sans-serif" fontSize="18" fontWeight={700} fill="var(--flow-econ-text)">User Consumes</text>
          <text x="950" y="156" textAnchor="middle" fontFamily="'Oxanium', system-ui, sans-serif" fontSize="13" fontWeight={500} fill="var(--flow-econ-text)">inference</text>
          <text x="950" y="180" textAnchor="middle" fontFamily="'Share Tech Mono', monospace" fontSize="10" fill="var(--flow-econ-muted)" letterSpacing="0.6">pays USDC per request</text>
          <text x="855" y="108" fontFamily="'Share Tech Mono', monospace" fontSize="9" fontWeight={700} fill="#e8a33d" opacity="0.9" letterSpacing="1">03</text>
        </g>

        {usdcCoins.map((c, i) => (
          <g key={`usdcReturn-${i}`} filter="url(#coin-glow)" opacity="0.95">
            <g transform={`scale(${c.scale})`}>
              <use href="#usdc-coin-svg" />
            </g>
            <animateMotion dur={`${c.dur}s`} repeatCount="indefinite" begin={`${c.delay}s`} rotate="0">
              <mpath href="#return-path" />
            </animateMotion>
          </g>
        ))}

        <line x1="160" y1="290" x2="160" y2="210" stroke="var(--green)" strokeWidth="1" strokeDasharray="3 5" opacity="0.42" />

        {/* $ANTS emission box below the Pool */}
        <g>
          <rect x="65" y="300" width="190" height="70" rx="14" fill="rgba(var(--green-rgb),0.12)" stroke="var(--green)" strokeWidth="1.5" strokeDasharray="5 3" />
          <g transform="translate(71 311)">
            <AntsTokenCoinInline />
          </g>
          <text x="130" y="332" fontFamily="'Oxanium', system-ui, sans-serif" fontSize="14" fontWeight={700} fill="var(--flow-ants-text)">$ANTS</text>
          <text x="130" y="349" fontFamily="'Share Tech Mono', monospace" fontSize="9" fill="var(--flow-ants-muted)" letterSpacing="0.4">emissions ·</text>
          <text x="130" y="362" fontFamily="'Share Tech Mono', monospace" fontSize="9" fill="var(--flow-ants-muted)" letterSpacing="0.4">every epoch</text>
        </g>

        {/* Ants marching UP from the $ANTS box into the Pool */}
        {ants.map((a, i) => (
          <g key={`ant-${i}`}>
            <g transform={`translate(${a.x} 300)`}>
              <g>
                <AntInline />
                <animateTransform
                  attributeName="transform"
                  type="translate"
                  from="0 0"
                  to="0 -100"
                  dur={`${antMarchDur}s`}
                  begin={`${a.delay}s; marchEnd${i}.end + ${antCycle - antMarchDur}s`}
                  fill="freeze"
                  id={`march${i}`}
                />
                <animate
                  attributeName="opacity"
                  values="0; 1; 1; 0"
                  keyTimes="0; 0.15; 0.85; 1"
                  dur={`${antMarchDur}s`}
                  begin={`${a.delay}s; marchEnd${i}.end + ${antCycle - antMarchDur}s`}
                  fill="freeze"
                  id={`marchEnd${i}`}
                />
              </g>
            </g>
          </g>
        ))}
      </svg>

      <FlowMobile />
    </div>
  );
}

function FlowMobile() {
  const usdcLefts = [12, 28, 44, 62, 80];
  const antLefts = [18, 36, 52, 68, 86];
  return (
    <div className="flow-mobile" aria-hidden={false}>
      <div className="flow-mobile-pool">
        <div className="flow-mobile-pool-logo"><DiemLogo size={44} /></div>
        <div className="flow-mobile-pool-text">
          <h3>$DIEM Capacity</h3>
          <span>USDC allocations vary · $ANTS if eligible</span>
        </div>
      </div>

      <div className="flow-mobile-stream" aria-hidden="true">
        {usdcLefts.map((L, i) => (
          <span
            key={`u-${i}`}
            className="flow-mobile-particle flow-mobile-particle-coin"
            style={{ left: `${L}%`, animationDelay: `${i * 0.45}s` }}
          >
            <UsdcLogo size={22} />
          </span>
        ))}
      </div>

      <a
        href={ANTSEED_PRICING_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="flow-mobile-source flow-mobile-source-usdc"
      >
        <div className="flow-mobile-source-ic"><UsdcLogo size={28} /></div>
        <div className="flow-mobile-source-txt">
          <h4>USDC · per request</h4>
          <span className="flow-mobile-source-sub">inference on Antseed · <strong>SEE PRICING →</strong></span>
        </div>
      </a>

      <div className="flow-mobile-stream flow-mobile-stream-ants" aria-hidden="true">
        {antLefts.map((L, i) => (
          <span
            key={`a-${i}`}
            className="flow-mobile-particle flow-mobile-particle-ant"
            style={{ left: `${L}%`, animationDelay: `${i * 0.55}s` }}
          >
            <AntIcon size={14} />
          </span>
        ))}
      </div>

      <div className="flow-mobile-source flow-mobile-source-ants">
        <div className="flow-mobile-source-ic flow-mobile-source-ic-ants">
          <AntsTokenLogo size={38} />
        </div>
        <div className="flow-mobile-source-txt">
          <h4>$ANTS · if eligible</h4>
          <span className="flow-mobile-source-sub">incentives under Program rules</span>
        </div>
      </div>
    </div>
  );
}
