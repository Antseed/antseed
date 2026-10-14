/**
 * Payment and chain marks for the Add funds options: small trust cues, the
 * same ones the desktop's deposit view shows (ported from
 * apps/desktop/.../VprDepositView.tsx).
 */

const USDC_BLUE = '#2775CA'

export function UsdcMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill={USDC_BLUE} />
      <text x="12" y="16.6" textAnchor="middle" fontSize="13.5" fontWeight="700" fill="#fff">$</text>
    </svg>
  )
}

export function BaseMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#0052FF" />
      <rect x="1" y="10.95" width="15.85" height="2.1" fill="#fff" />
    </svg>
  )
}

/** Apple logo silhouette (the classic bitten-apple path, 814×1000 box). */
const APPLE_LOGO_PATH =
  'M788.1 340.9c-5.8 4.5-108.2 62.2-108.2 190.5 0 148.4 130.3 200.9 134.2 ' +
  '202.2-.6 3.2-20.7 71.9-68.7 141.9-42.8 61.6-87.5 123.1-155.5 123.1s-85.5' +
  '-39.5-164-39.5c-76.5 0-103.7 40.8-165.9 40.8s-105.6-57-155.5-127C46.7 ' +
  '790.7 0 663 0 541.8c0-194.4 126.4-297.5 250.8-297.5 66.1 0 121.2 43.4 ' +
  '162.7 43.4 39.5 0 101.1-46 176.3-46 28.5 0 130.9 2.6 198.3 99.2zm-234-' +
  '181.5c31.1-36.9 53.1-88.1 53.1-139.3 0-7.1-.6-14.3-1.9-20.1-50.6 1.9-' +
  '110.8 33.7-147.1 75.8-28.5 32.4-55.1 83.6-55.1 135.5 0 7.8 1.3 15.6 1.9 ' +
  '18.1 3.2.6 8.4 1.3 13.6 1.3 45.4 0 102.5-30.4 135.5-71.3z'

/* Circular payment badges for the card option — same idiom as the chain marks
   (filled discs), with a hairline ring on the white ones so they hold up on
   any surface. */

export function ApplePayRoundMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="11.5" fill="#fff" stroke="#d5d7db" />
      <path d={APPLE_LOGO_PATH} fill="#000" transform="translate(7.3 6.4) scale(0.0115)" />
    </svg>
  )
}

export function MastercardRoundMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="11.5" fill="#fff" stroke="#d5d7db" />
      <circle cx="9.4" cy="12" r="4.6" fill="#EB001B" />
      <circle cx="14.6" cy="12" r="4.6" fill="#F79E1B" fillOpacity="0.9" />
    </svg>
  )
}

export function GooglePayRoundMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="11.5" fill="#fff" stroke="#d5d7db" />
      <g transform="translate(6 6) scale(0.5)">
        <path fill="#4285F4" d="M23.49 12.27c0-.79-.07-1.54-.19-2.27H12v4.51h6.47c-.29 1.48-1.14 2.73-2.4 3.58v3h3.86c2.26-2.09 3.56-5.17 3.56-8.82z" />
        <path fill="#34A853" d="M12 24c3.24 0 5.95-1.08 7.93-2.91l-3.86-3c-1.08.72-2.45 1.16-4.07 1.16-3.13 0-5.78-2.11-6.73-4.96H1.29v3.09C3.26 21.31 7.31 24 12 24z" />
        <path fill="#FBBC05" d="M5.27 14.29c-.25-.72-.38-1.49-.38-2.29s.14-1.57.38-2.29V6.62H1.29C.47 8.24 0 10.06 0 12s.47 3.76 1.29 5.38l3.98-3.09z" />
        <path fill="#EA4335" d="M12 4.75c1.77 0 3.35.61 4.6 1.8l3.42-3.42C17.95 1.19 15.24 0 12 0 7.31 0 3.26 2.69 1.29 6.62l3.98 3.09C6.22 6.86 8.87 4.75 12 4.75z" />
      </g>
    </svg>
  )
}

export function VisaRoundMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#1434CB" />
      <text x="12" y="14.6" textAnchor="middle" fontSize="7" fontWeight="800" fontStyle="italic" fill="#fff">VISA</text>
    </svg>
  )
}

export function AmexRoundMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#016FD0" />
      <text x="12" y="14.6" textAnchor="middle" fontSize="6" fontWeight="800" fill="#fff">AMEX</text>
    </svg>
  )
}

/** Official Stripe mark — from stripe.com's SVG favicon. */
export function StripeMark({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true">
      <rect width="512" height="512" rx="64" fill="#533AFD" />
      <path fillRule="evenodd" clipRule="evenodd" d="M120 392L392 334.317V120L120 178.357V392Z" fill="#fff" />
    </svg>
  )
}

/** Official Meridian (mrdn.finance) mark — the green pinwheel favicon. */
export function MeridianMark({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 542.25 542.25" fill="#34D399" aria-hidden="true">
      <path d="M493.18,424.48l-106.09,106.09c-7.48,7.48-17.63,11.69-28.21,11.69h-192.03l250.27-250.27,76.06,76.06c15.58,15.58,15.58,40.85,0,56.43Z" />
      <path d="M375.41,0L125.14,250.27l-76.06-76.06c-15.58-15.58-15.58-40.85,0-56.43L155.16,11.69c7.48-7.48,17.63-11.69,28.21-11.69h192.03Z" />
      <path d="M542.25,375.41l-250.27-250.27,76.06-76.06c15.58-15.58,40.85-15.58,56.43,0l106.09,106.09c7.48,7.48,11.69,17.63,11.69,28.21v192.03Z" />
      <path d="M250.27,417.12l-76.06,76.06c-15.58,15.58-40.85,15.58-56.43,0L11.69,387.09c-7.48-7.48-11.69-17.63-11.69-28.21v-192.03l250.27,250.27Z" />
    </svg>
  )
}

/** Official Arbitrum mark (arbitrum.foundation brand asset). */
export function ArbitrumMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 2500 2500" aria-hidden="true">
      <path fill="#213147" d="M226,760v980c0,63,33,120,88,152l849,490c54,31,121,31,175,0l849-490c54-31,88-89,88-152V760c0-63-33-120-88-152l-849-490c-54-31-121-31-175,0L314,608c-54,31-87,89-87,152H226z" />
      <path fill="#12AAFF" d="M1435,1440l-121,332c-3,9-3,19,0,29l208,571l241-139l-289-793C1467,1422,1442,1422,1435,1440z" />
      <path fill="#12AAFF" d="M1678,882c-7-18-32-18-39,0l-121,332c-3,9-3,19,0,29l341,935l241-139L1678,883V882z" />
      <path fill="#9DCCED" d="M1250,155c6,0,12,2,17,5l918,530c11,6,17,18,17,30v1060c0,12-7,24-17,30l-918,530c-5,3-11,5-17,5s-12-2-17-5l-918-530c-11-6-17-18-17-30V719c0-12,7-24,17-30l918-530c5-3,11-5,17-5l0,0V155z M1250,0c-33,0-65,8-95,25L237,555c-59,34-95,96-95,164v1060c0,68,36,130,95,164l918,530c29,17,62,25,95,25s65-8,95-25l918-530c59-34,95-96,95-164V719c0-68-36-130-95-164L1344,25c-29-17-62-25-95-25l0,0H1250z" />
      <polygon fill="#213147" points="642,2179 727,1947 897,2088 738,2234" />
      <path fill="#fff" d="M1172,644H939c-17,0-33,11-39,27L401,2039l241,139l550-1507c5-14-5-28-19-28L1172,644z" />
      <path fill="#fff" d="M1580,644h-233c-17,0-33,11-39,27L738,2233l241,139l620-1701c5-14-5-28-19-28V644z" />
    </svg>
  )
}

/** Official BNB Chain mark (yellow disc + notched-diamond glyph). */
export function BnbMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 2496 2496" aria-hidden="true">
      <path fill="#F0B90B" fillRule="evenodd" clipRule="evenodd" d="M1248,0c689.3,0,1248,558.7,1248,1248s-558.7,1248-1248,1248S0,1937.3,0,1248S558.7,0,1248,0L1248,0z" />
      <g fill="#fff">
        <path d="M685.9,1248l0.9,330l280.4,165v193.2l-444.5-260.7v-524L685.9,1248L685.9,1248z M685.9,918v192.3l-163.3-96.6V821.4l163.3-96.6l164.1,96.6L685.9,918L685.9,918z M1084.3,821.4l163.3-96.6l164.1,96.6L1247.6,918L1084.3,821.4L1084.3,821.4z" />
        <path d="M803.9,1509.6v-193.2l163.3,96.6v192.3L803.9,1509.6L803.9,1509.6z M1084.3,1812.2l163.3,96.6l164.1-96.6v192.3l-164.1,96.6l-163.3-96.6V1812.2L1084.3,1812.2z M1645.9,821.4l163.3-96.6l164.1,96.6v192.3l-164.1,96.6V918L1645.9,821.4L1645.9,821.4L1645.9,821.4z M1809.2,1578l0.9-330l163.3-96.6v524l-444.5,260.7v-193.2L1809.2,1578L1809.2,1578L1809.2,1578z" />
        <polygon points="1692.1,1509.6 1528.8,1605.3 1528.8,1413 1692.1,1316.4 1692.1,1509.6" />
        <path d="M1692.1,986.4l0.9,193.2l-281.2,165v330.8l-163.3,95.7l-163.3-95.7v-330.8l-281.2-165V986.4L968,889.8l279.5,165.8l281.2-165.8l164.1,96.6H1692.1L1692.1,986.4z M803.9,656.5l443.7-261.6l444.5,261.6l-163.3,96.6l-281.2-165.8L967.2,753.1L803.9,656.5L803.9,656.5z" />
      </g>
    </svg>
  )
}

/** Official Polygon glyph (polygon.technology brand asset) on the brand disc. */
export function PolygonMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#6C00F6" />
      <path
        fill="#fff"
        transform="translate(5.5 6.15) scale(0.0731)"
        d="M66.8,54.7l-16.7-9.7L0,74.1v58l50.1,29l50.1-29V41.9L128,25.8l27.8,16.1v32.2L128,90.2l-16.7-9.7v25.8l16.7,9.7l50.1-29V29L128,0L77.9,29v90.2l-27.8,16.1l-27.8-16.1V86.9l27.8-16.1l16.7,9.7V54.7z"
      />
    </svg>
  )
}

/** Official Ethereum mark (ethereum.org diamond on the #627EEA disc). */
export function EthMark({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="16" fill="#627EEA" />
      <g fill="#fff" fillRule="nonzero">
        <path fillOpacity="0.602" d="M16.498 4v8.87l7.497 3.35z" />
        <path d="M16.498 4L9 16.22l7.498-3.35z" />
        <path fillOpacity="0.602" d="M16.498 21.968v6.027L24 17.616z" />
        <path d="M16.498 27.995v-6.028L9 17.616z" />
        <path fillOpacity="0.2" d="M16.498 20.573l7.497-4.353-7.497-3.348z" />
        <path fillOpacity="0.602" d="M9 16.22l7.498 4.353v-7.701z" />
      </g>
    </svg>
  )
}
