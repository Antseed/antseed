// Brand marks used across the portal. No state, no props of significance
// beyond `size`. Most are inline SVG (USDC + $ANTS coin + ant silhouette),
// kept verbatim from the design mock so they stay on-brand. DIEM is the
// exception — it renders the real Venice token PNG served from /public.
// See each component's doc-comment for provenance.

/** Official DIEM token icon (Venice). Source:
 *  https://s2.coinmarketcap.com/static/img/coins/200x200/38186.png
 *  Pulled into `public/diem-logo.png` at 200×200 so it scales cleanly on
 *  HiDPI displays up to ~100px rendered. Decorative — always paired with a
 *  "$DIEM" text label, so `alt=""` + `aria-hidden` is correct. */
export function DiemLogo({ size = 24 }: { size?: number }) {
  return (
    <img
      src="/diem-logo.png"
      width={size}
      height={size}
      alt=""
      aria-hidden="true"
      decoding="async"
      style={{ display: 'inline-block', verticalAlign: 'middle' }}
    />
  );
}

export function UsdcLogo({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="15" fill="#2775CA" />
      <circle cx="16" cy="16" r="11.5" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="0.6" />
      <text
        x="16"
        y="21"
        textAnchor="middle"
        fontFamily="system-ui, -apple-system, sans-serif"
        fontSize="15"
        fontWeight={700}
        fill="#fff"
      >
        $
      </text>
    </svg>
  );
}

/**
 * Brand-accurate ant paths (viewBox 0 0 32 32). Uses `currentColor` so the
 * parent <g> can set the colour for light/dark surfaces. Verbatim from the
 * Antseed brand guidelines.
 */
function BrandAntPaths() {
  return (
    <g fill="currentColor" stroke="currentColor">
      {/* 3 body segments */}
      <path d="M16 11C17.1046 11 18 10.015 18 8.79998C18 7.58495 17.1046 6.59998 16 6.59998C14.8954 6.59998 14 7.58495 14 8.79998C14 10.015 14.8954 11 16 11Z" />
      <path d="M16 17.6C17.5464 17.6 18.8 16.1673 18.8 14.4C18.8 12.6326 17.5464 11.2 16 11.2C14.4536 11.2 13.2 12.6326 13.2 14.4C13.2 16.1673 14.4536 17.6 16 17.6Z" />
      <path d="M16 26.8C17.9882 26.8 19.6 24.6509 19.6 22C19.6 19.349 17.9882 17.2 16 17.2C14.0118 17.2 12.4 19.349 12.4 22C12.4 24.6509 14.0118 26.8 16 26.8Z" />
      {/* Antennae */}
      <path opacity="0.7" fill="none" strokeWidth="0.6" strokeLinecap="round" d="M14.8 6.80002L11.2 2.40002" />
      <path opacity="0.7" fill="none" strokeWidth="0.6" strokeLinecap="round" d="M17.2 6.80002L20.8 2.40002" />
      <path d="M11.2 3.40002C11.7523 3.40002 12.2 2.95231 12.2 2.40002C12.2 1.84774 11.7523 1.40002 11.2 1.40002C10.6477 1.40002 10.2 1.84774 10.2 2.40002C10.2 2.95231 10.6477 3.40002 11.2 3.40002Z" />
      <path d="M20.8 3.40002C21.3523 3.40002 21.8 2.95231 21.8 2.40002C21.8 1.84774 21.3523 1.40002 20.8 1.40002C20.2477 1.40002 19.8 1.84774 19.8 2.40002C19.8 2.95231 20.2477 3.40002 20.8 3.40002Z" />
      {/* Legs — top pair */}
      <path opacity="0.5" fill="none" strokeWidth="0.52" strokeLinecap="round" d="M14 12.8L7 8.80005" />
      <path opacity="0.5" fill="none" strokeWidth="0.52" strokeLinecap="round" d="M18 12.8L25 8.80005" />
      <path d="M7.20001 9.80005C7.7523 9.80005 8.20001 9.35233 8.20001 8.80005C8.20001 8.24776 7.7523 7.80005 7.20001 7.80005C6.64773 7.80005 6.20001 8.24776 6.20001 8.80005C6.20001 9.35233 6.64773 9.80005 7.20001 9.80005Z" />
      <path d="M24.8 9.80005C25.3523 9.80005 25.8 9.35233 25.8 8.80005C25.8 8.24776 25.3523 7.80005 24.8 7.80005C24.2477 7.80005 23.8 8.24776 23.8 8.80005C23.8 9.35233 24.2477 9.80005 24.8 9.80005Z" />
      {/* Legs — middle pair */}
      <path opacity="0.5" fill="none" strokeWidth="0.52" strokeLinecap="round" d="M13.2 15.2L5.59998 16" />
      <path opacity="0.5" fill="none" strokeWidth="0.52" strokeLinecap="round" d="M18.8 15.2L26.4 16" />
      <path d="M5.59998 17C6.15226 17 6.59998 16.5523 6.59998 16C6.59998 15.4477 6.15226 15 5.59998 15C5.04769 15 4.59998 15.4477 4.59998 16C4.59998 16.5523 5.04769 17 5.59998 17Z" />
      <path d="M26.4 17C26.9523 17 27.4 16.5523 27.4 16C27.4 15.4477 26.9523 15 26.4 15C25.8477 15 25.4 15.4477 25.4 16C25.4 16.5523 25.8477 17 26.4 17Z" />
      {/* Legs — bottom pair */}
      <path opacity="0.5" fill="none" strokeWidth="0.52" strokeLinecap="round" d="M13.6 20.8L6.40002 24" />
      <path opacity="0.5" fill="none" strokeWidth="0.52" strokeLinecap="round" d="M18.4 20.8L25.6 24" />
      <path d="M6.40002 25C6.95231 25 7.40002 24.5523 7.40002 24C7.40002 23.4477 6.95231 23 6.40002 23C5.84774 23 5.40002 23.4477 5.40002 24C5.40002 24.5523 5.84774 25 6.40002 25Z" />
      <path d="M25.6 25C26.1523 25 26.6 24.5523 26.6 24C26.6 23.4477 26.1523 23 25.6 23C25.0477 23 24.6 23.4477 24.6 24C24.6 24.5523 25.0477 25 25.6 25Z" />
      {/* Leg-joint connective lines */}
      <path opacity="0.15" fill="none" strokeWidth="0.52" strokeLinecap="round" d="M7.19998 8.80005L5.59998 16" />
      <path opacity="0.15" fill="none" strokeWidth="0.52" strokeLinecap="round" d="M24.8 8.80005L26.4 16" />
      <path opacity="0.15" fill="none" strokeWidth="0.52" strokeLinecap="round" d="M5.59998 16L6.39998 24" />
      <path opacity="0.15" fill="none" strokeWidth="0.52" strokeLinecap="round" d="M26.4 16L25.6 24" />
    </g>
  );
}

/** The $ANTS coin. Brand-accurate ant silhouette inside a coin, dark face
 *  with a brand-mint ring, subtle glow. */
export function AntsTokenLogo({ size = 48 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 48 48" aria-hidden="true">
      <defs>
        <radialGradient id="ants-coin-face" cx="38%" cy="30%" r="75%">
          <stop offset="0%" stopColor="#1b2230" />
          <stop offset="55%" stopColor="#0f1622" />
          <stop offset="100%" stopColor="#06090e" />
        </radialGradient>
        <linearGradient id="ants-coin-edge" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#6affba" />
          <stop offset="100%" stopColor="#0f7d4d" />
        </linearGradient>
        <filter id="ants-coin-glow">
          <feGaussianBlur stdDeviation="0.6" result="b" />
          <feMerge>
            <feMergeNode in="b" />
            <feMergeNode in="SourceGraphic" />
          </feMerge>
        </filter>
      </defs>
      <circle cx="24" cy="24" r="23" fill="url(#ants-coin-face)" />
      <circle cx="24" cy="24" r="23" fill="none" stroke="url(#ants-coin-edge)" strokeWidth="1.3" />
      <circle cx="24" cy="24" r="20.5" fill="none" stroke="rgba(var(--green-rgb),0.2)" strokeWidth="0.5" />
      <path
        d="M 6.5 20 A 18 18 0 0 1 22 6.5"
        fill="none"
        stroke="rgba(255,255,255,0.18)"
        strokeWidth="0.8"
        strokeLinecap="round"
      />
      <g transform="translate(8 8)" color="var(--green)" filter="url(#ants-coin-glow)">
        <BrandAntPaths />
      </g>
    </svg>
  );
}

/** Same coin body as AntsTokenLogo but with no outer <svg> — for embedding
 *  inside a parent <svg> via <g transform="translate(...)">. */
export function AntsTokenCoinInline() {
  return (
    <g>
      <circle cx="24" cy="24" r="23" fill="url(#ants-coin-face)" />
      <circle cx="24" cy="24" r="23" fill="none" stroke="url(#ants-coin-edge)" strokeWidth="1.3" />
      <circle cx="24" cy="24" r="20.5" fill="none" stroke="rgba(var(--green-rgb),0.2)" strokeWidth="0.5" />
      <path
        d="M 6.5 20 A 18 18 0 0 1 22 6.5"
        fill="none"
        stroke="rgba(255,255,255,0.18)"
        strokeWidth="0.8"
        strokeLinecap="round"
      />
      <g transform="translate(8 8)" color="var(--green)">
        <BrandAntPaths />
      </g>
    </g>
  );
}

/** Antseed-style ant drawing. `light = true` inside dark badges, `false`
 *  on light backgrounds. Used in the claim marketing block + flow diagram. */
export function AntIcon({ size = 22, light = false }: { size?: number; light?: boolean }) {
  const body = light ? '#ffffff' : '#1a1a1a';
  const limb = light ? 'var(--green)' : '#8a8a8a';
  return (
    <svg width={size} height={size * 1.25} viewBox="-20 -25 40 50" aria-hidden="true">
      <line x1="-4" y1="-14" x2="-8" y2="-21" stroke={limb} strokeWidth="1.6" strokeLinecap="round" />
      <line x1="4" y1="-14" x2="8" y2="-21" stroke={limb} strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="-8" cy="-21" r="2.2" fill={limb} />
      <circle cx="8" cy="-21" r="2.2" fill={limb} />
      <circle cx="0" cy="-11" r="4.5" fill={body} />
      <ellipse cx="0" cy="0" rx="6.5" ry="5.5" fill={body} />
      <ellipse cx="0" cy="13" rx="8" ry="9" fill={body} />
      <g stroke={limb} strokeWidth="1.3" strokeLinecap="round">
        <line x1="-5" y1="-4" x2="-14" y2="-8" />
        <line x1="5" y1="-4" x2="14" y2="-8" />
        <line x1="-6" y1="1" x2="-16" y2="1" />
        <line x1="6" y1="1" x2="16" y2="1" />
        <line x1="-6" y1="8" x2="-15" y2="14" />
        <line x1="6" y1="8" x2="15" y2="14" />
      </g>
      <g fill={limb}>
        <circle cx="-14" cy="-8" r="1.9" />
        <circle cx="14" cy="-8" r="1.9" />
        <circle cx="-16" cy="1" r="1.9" />
        <circle cx="16" cy="1" r="1.9" />
        <circle cx="-15" cy="14" r="1.9" />
        <circle cx="15" cy="14" r="1.9" />
      </g>
    </svg>
  );
}

/** Ant silhouette used inside the animated flow-diagram SVG. Smaller than
 *  `AntIcon` and centred on (0,0) so animateTransform translate tracks it. */
export function AntInline({ light = false }: { light?: boolean }) {
  const body = light ? '#ffffff' : '#1a1a1a';
  const limb = light ? 'var(--green)' : '#8a8a8a';
  return (
    <g>
      <line x1="-2.4" y1="-8.5" x2="-4.6" y2="-12.5" stroke={limb} strokeWidth="0.9" strokeLinecap="round" />
      <line x1="2.4" y1="-8.5" x2="4.6" y2="-12.5" stroke={limb} strokeWidth="0.9" strokeLinecap="round" />
      <circle cx="-4.6" cy="-12.5" r="1.3" fill={limb} />
      <circle cx="4.6" cy="-12.5" r="1.3" fill={limb} />
      <circle cx="0" cy="-6.5" r="2.7" fill={body} />
      <ellipse cx="0" cy="0" rx="3.9" ry="3.3" fill={body} />
      <ellipse cx="0" cy="7.8" rx="4.8" ry="5.4" fill={body} />
      <g stroke={limb} strokeWidth="0.8" strokeLinecap="round">
        <line x1="-3" y1="-2.5" x2="-8.5" y2="-5" />
        <line x1="3" y1="-2.5" x2="8.5" y2="-5" />
        <line x1="-3.6" y1="0.6" x2="-9.5" y2="0.6" />
        <line x1="3.6" y1="0.6" x2="9.5" y2="0.6" />
        <line x1="-3.6" y1="4.8" x2="-9" y2="8.5" />
        <line x1="3.6" y1="4.8" x2="9" y2="8.5" />
      </g>
      <g fill={limb}>
        <circle cx="-8.5" cy="-5" r="1.1" />
        <circle cx="8.5" cy="-5" r="1.1" />
        <circle cx="-9.5" cy="0.6" r="1.1" />
        <circle cx="9.5" cy="0.6" r="1.1" />
        <circle cx="-9" cy="8.5" r="1.1" />
        <circle cx="9" cy="8.5" r="1.1" />
      </g>
    </g>
  );
}
