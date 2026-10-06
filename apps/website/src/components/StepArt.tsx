
/**
 * Step 3 illustration ("Pick your model") for the homepage steps section.
 * Drawn to match the static illo-*.svg wells (318×200, #F4F5F4 rx16, white
 * chips with #CCCDCC hairlines) but inlined so the page fonts apply and the
 * vendor logos load from /logos.
 */

const MONO = "'Geist Mono Variable', 'Geist Mono', ui-monospace, monospace";
const SANS = "'General Sans', 'Geist Variable', system-ui, sans-serif";

const ROWS = [
  {logo: '/logos/openai.png', name: 'GPT-5.5', tag: '$0.23/M', selected: true},
  {logo: '/logos/anthropic.png', name: 'Claude Opus 5', tag: '$0.31/M', selected: false},
  {logo: '/logos/deepseek.png', name: 'DeepSeek V4 Flash', tag: 'Free', selected: false},
];

export function PickModelArt() {
  return (
    <svg
      viewBox="0 0 318 200"
      width="100%"
      role="img"
      aria-hidden="true"
      focusable="false"
      style={{display: 'block', fontFamily: MONO}}>
      <rect width="317.333" height="200" rx="16" fill="#F4F5F4" />

      {/* model picker */}
      <rect x="32.5" y="24.5" width="253" height="42" rx="12" fill="#fff" stroke="#CCCDCC" />
      <text x="46" y="40" fontSize="9.5" fill="#A4A5A4" letterSpacing="0.04em">MODEL</text>
      <text x="46" y="56" fontFamily={SANS} fontWeight="600" fontSize="12.5" fill="#001E12">
        Auto · cheapest verified
      </text>
      <path d="M262 43l5 5 5-5" fill="none" stroke="#001E12" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />

      {/* options */}
      {ROWS.map((row, i) => {
        const y = 78 + i * 36;
        return (
          <g key={row.name}>
            {row.selected && (
              <rect x="32.5" y={y + 0.5} width="253" height="31" rx="10" fill="none" stroke="rgba(16,185,129,0.22)" strokeWidth="7" />
            )}
            <rect
              x="32.5"
              y={y + 0.5}
              width="253"
              height="31"
              rx="10"
              fill="#fff"
              stroke={row.selected ? '#10B981' : '#E3E6E4'}
              strokeWidth={row.selected ? 1.5 : 1}
            />
            <rect x="42.5" y={y + 5.5} width="21" height="21" rx="6" fill="#fff" stroke="#E3E6E4" />
            <image href={row.logo} x="46" y={y + 9} width="14" height="14" preserveAspectRatio="xMidYMid meet" />
            <text x="71" y={y + 20.5} fontFamily={SANS} fontWeight="600" fontSize="12" fill="#001E12">
              {row.name}
            </text>
            {row.selected ? (
              <>
                <rect x="150" y={y + 7} width="66" height="18" rx="9" fill="rgba(16,185,129,0.12)" />
                <text x="183" y={y + 19.6} textAnchor="middle" fontSize="9" fill="#0A6F4D">Best price</text>
                <text x="274" y={y + 20} textAnchor="end" fontSize="10.5" fill="#0A6F4D">{row.tag}</text>
              </>
            ) : (
              <text x="274" y={y + 20} textAnchor="end" fontSize="10.5" fill="rgba(0,30,18,0.5)">{row.tag}</text>
            )}
          </g>
        );
      })}
    </svg>
  );
}
