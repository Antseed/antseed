import { useMemo, type ReactElement } from 'react'
import QRCode from 'qrcode'

// Ported from the desktop's deposit view (apps/desktop/.../VprDepositView.tsx), so both QR codes look the same.

/** Official Base mark (24×24): blue disc with the white horizontal slot. */
const BASE_LOGO_PATH =
  'M12 24C18.6274 24 24 18.6274 24 12C24 5.37258 18.6274 0 12 0C5.72532 0 ' +
  '0.578514 4.81465 0.0491943 10.9512H15.8916V13.0488H0.0491943C0.578514 ' +
  '19.1853 5.72532 24 12 24Z'

function roundedRectPath(x: number, y: number, w: number, h: number, r: number): string {
  return `M${x + r},${y} h${w - 2 * r} a${r},${r} 0 0 1 ${r},${r} v${h - 2 * r} ` +
    `a${r},${r} 0 0 1 ${-r},${r} h${-(w - 2 * r)} a${r},${r} 0 0 1 ${-r},${-r} ` +
    `v${-(h - 2 * r)} a${r},${r} 0 0 1 ${r},${-r} z`
}

/** One finder eye: outer rounded ring (even-odd hole) + solid rounded pupil. */
function finderPaths(x: number, y: number): [string, string] {
  return [
    roundedRectPath(x, y, 7, 7, 2.2) + ' ' + roundedRectPath(x + 1, y + 1, 5, 5, 1.6),
    roundedRectPath(x + 2, y + 2, 3, 3, 1.05),
  ]
}

/**
 * Renders the payment QR as themed SVG: round data dots, rounded finder
 * eyes, and the Base logo in a punched-out center badge. Error correction is
 * 'Q' (25%) so the ~4% of modules hidden by the badge stay well within the
 * recovery budget.
 */
export function StyledQr({ text, label }: { text: string; label: string }) {
  const matrix = useMemo(() => {
    try {
      const qr = QRCode.create(text, { errorCorrectionLevel: 'Q' })
      return { size: qr.modules.size, data: qr.modules.data as Uint8Array }
    } catch {
      return null
    }
  }, [text])

  if (!matrix) return <div className="gc-qr gc-qr--placeholder" aria-hidden="true" />
  const { size, data } = matrix
  const center = size / 2
  const badgeR = size * 0.11; // badge diameter ≈ 22% of QR width
  const clearR = badgeR + 0.6; // dot clearance around the badge
  const logoR = badgeR * 0.82

  const inFinder = (row: number, col: number): boolean =>
    (row < 7 && col < 7) || (row < 7 && col >= size - 7) || (row >= size - 7 && col < 7)
  const underBadge = (row: number, col: number): boolean =>
    Math.hypot(row + 0.5 - center, col + 0.5 - center) < clearR

  const dots: ReactElement[] = []
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (!data[row * size + col]) continue
      if (inFinder(row, col) || underBadge(row, col)) continue
      dots.push(<circle key={`${row}-${col}`} cx={col + 0.5} cy={row + 0.5} r={0.34} />)
    }
  }

  return (
    <svg className="gc-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label}>
      <g fill="currentColor">
        {dots}
        {[[0, 0], [size - 7, 0], [0, size - 7]].map(([x, y]) => {
          const [ring, pupil] = finderPaths(x!, y!)
          return (
            <g key={`${x}-${y}`}>
              <path d={ring} fillRule="evenodd" />
              <path d={pupil} />
            </g>
          )
        })}
      </g>
      <circle cx={center} cy={center} r={badgeR} className="gc-qr__badge" />
      <circle cx={center} cy={center} r={logoR} fill="#fff" />
      <path
        d={BASE_LOGO_PATH}
        fill="#0052FF"
        transform={`translate(${center - logoR}, ${center - logoR}) scale(${(logoR * 2) / 24})`}
      />
    </svg>
  )
}
