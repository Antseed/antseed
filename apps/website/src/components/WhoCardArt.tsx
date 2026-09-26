
/**
 * Illustrations for the "Who it's for" cards — from the Antseed design
 * system (assets/card-*.svg), inlined so the page's fonts apply to the
 * labels and the logos load from this site's own /logos and /img paths.
 * Canvas is 300×130; the wrapper scales it to the card's inner panel.
 */

const MONO = "'Geist Mono Variable', 'Geist Mono', ui-monospace, monospace";
const SANS = "'General Sans', 'Geist Variable', system-ui, sans-serif";

const svgProps = {
  viewBox: '0 0 300 130',
  width: '100%',
  role: 'img' as const,
  focusable: 'false' as const,
  'aria-hidden': true,
  style: {fontFamily: MONO, display: 'block'},
};

/** Agents: three agent apps → Antseed → cheapest price, 24/7 */
export function AgentsArt() {
  return (
    <svg {...svgProps}>
      <rect x="20" y="1" width="40" height="40" rx="11" fill="#fff" stroke="rgba(0,30,18,0.12)" />
      <image href="/logos/openclaw.svg" x="30" y="11" width="20" height="20" preserveAspectRatio="xMidYMid meet" />
      <rect x="20" y="45" width="40" height="40" rx="11" fill="#fff" stroke="rgba(0,30,18,0.12)" />
      <image href="/logos/nousresearch.svg" x="30" y="55" width="20" height="20" preserveAspectRatio="xMidYMid meet" />
      <rect x="20" y="89" width="40" height="40" rx="11" fill="#fff" stroke="rgba(0,30,18,0.12)" />
      <image href="/logos/openai.png" x="30" y="99" width="20" height="20" preserveAspectRatio="xMidYMid meet" />
      {[73.5, 81.5, 89.5, 97.5].map((cx) => (
        <circle key={cx} cx={cx} cy="65" r="1.5" fill="#10B981" />
      ))}
      <circle cx="138" cy="65" r="26.5" fill="rgba(16,185,129,0.1)" />
      <circle cx="138" cy="65" r="24" fill="#fff" stroke="#10B981" strokeWidth="1.5" />
      <image href="/logo.svg" x="126" y="53" width="24" height="24" />
      {[177.5, 185.5, 193.5, 201.5, 209.5].map((cx) => (
        <circle key={cx} cx={cx} cy="65" r="1.5" fill="#10B981" />
      ))}
      <rect x="226" y="47" width="58" height="20" rx="10" fill="rgba(16,185,129,0.1)" />
      <text x="255" y="60.96" textAnchor="middle" fontSize="11" fill="#0A6F4D">$0.19/M</text>
      <rect x="226" y="73" width="44" height="20" rx="10" fill="#fff" stroke="rgba(0,30,18,0.12)" />
      <text x="248" y="86.96" textAnchor="middle" fontSize="11" fill="rgba(0,30,18,0.5)">24/7</text>
    </svg>
  );
}

/** Coding tools: the AI app hits its limit; Antseed keeps going */
export function CodingToolsArt() {
  return (
    <svg {...svgProps}>
      <g opacity="0.55">
        <rect x="8" y="28" width="284" height="36" rx="12" fill="#fff" stroke="rgba(0,30,18,0.1)" />
        <rect x="20" y="38" width="16" height="16" rx="5" fill="#001E12" />
        <circle cx="28" cy="46" r="3" fill="#fff" />
        <text x="46" y="50.5" fontFamily={SANS} fontWeight="600" fontSize="12.5" fill="#001E12">AI app</text>
        <rect x="100" y="43" width="140" height="6" rx="3" fill="rgba(0,30,18,0.45)" />
        <text x="250" y="50" fontSize="10.5" fill="rgba(0,30,18,0.7)">LIMIT</text>
      </g>
      <rect x="8" y="72" width="284" height="36" rx="12" fill="#fff" stroke="rgba(16,185,129,0.25)" strokeWidth="9" />
      <rect x="8" y="72" width="284" height="36" rx="12" fill="#fff" stroke="#10B981" strokeWidth="1.5" />
      <image href="/logo.svg" x="20" y="82" width="16" height="16" />
      <text x="46" y="94.5" fontFamily={SANS} fontWeight="600" fontSize="12.5" fill="#001E12">Antseed</text>
      {[105.5, 113.5, 121.5, 129.5, 137.5, 145.5, 153.5, 161.5].map((cx) => (
        <circle key={cx} cx={cx} cy="90" r="1.5" fill="#10B981" />
      ))}
      <text x="209" y="94" fontSize="10.5" fill="#0A6F4D">KEEP GOING</text>
    </svg>
  );
}

/** Anonymity: you → no account → provider */
export function AnonymityArt() {
  return (
    <svg {...svgProps}>
      {/* the design's content spans x=24..246 (centre 135) on a 300 canvas — shift right to centre */}
      <g transform="translate(15 0)">
      <circle cx="46" cy="58" r="22" fill="none" stroke="#001E12" strokeWidth="1.5" />
      <circle cx="46" cy="54" r="4" fill="none" stroke="#001E12" strokeWidth="1.8" />
      <path d="M38 66c0-4 3.6-6.5 8-6.5s8 2.5 8 6.5" fill="none" stroke="#001E12" strokeWidth="1.8" strokeLinecap="round" />
      <text x="46" y="98" textAnchor="middle" fontSize="10" fill="rgba(0,30,18,0.5)">you</text>
      <line x1="70" y1="58" x2="94" y2="58" stroke="rgba(0,30,18,0.3)" />
      <circle cx="126" cy="58" r="30.5" fill="rgba(16,185,129,0.1)" />
      <circle cx="126" cy="58" r="26" fill="#fff" stroke="#10B981" strokeWidth="1.5" />
      <image href="/img/demo/anonymous-node.svg" x="111" y="43" width="30" height="30" preserveAspectRatio="xMidYMid meet" />
      <text x="126" y="102" textAnchor="middle" fontSize="10" fill="#0A6F4D">no account</text>
      {[161.5, 169.5, 177.5, 185.5, 193.5].map((cx) => (
        <circle key={cx} cx={cx} cy="58" r="1.5" fill="#10B981" />
      ))}
      <rect x="202" y="36" width="44" height="44" rx="12" fill="none" stroke="#001E12" strokeWidth="1.5" />
      <rect x="216" y="51" width="16" height="5" rx="1.5" fill="none" stroke="#001E12" strokeWidth="1.8" />
      <rect x="216" y="60" width="16" height="5" rx="1.5" fill="none" stroke="#001E12" strokeWidth="1.8" />
      <circle cx="220" cy="53.5" r="0.9" fill="#001E12" />
      <circle cx="220" cy="62.5" r="0.9" fill="#001E12" />
      <text x="224" y="98" textAnchor="middle" fontSize="10" fill="rgba(0,30,18,0.5)">provider</text>
      </g>
    </svg>
  );
}
