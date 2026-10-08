import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function Svg({ size = 16, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>
      {children}
    </svg>
  )
}

export const Icon = {
  overview: (p: IconProps) => <Svg {...p}><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></Svg>,
  activity: (p: IconProps) => <Svg {...p}><path d="M3 12h4l3 8 4-16 3 8h4" /></Svg>,
  logs: (p: IconProps) => <Svg {...p}><path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" /></Svg>,
  keys: (p: IconProps) => <Svg {...p}><circle cx="8" cy="15" r="4" /><path d="m10.8 12.2 9.2-9.2M17 6l3 3M14 9l2 2" /></Svg>,
  members: (p: IconProps) => <Svg {...p}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5a6.5 6.5 0 0 1 3.5 5.5" /></Svg>,
  workspaces: (p: IconProps) => <Svg {...p}><path d="M3 7h18v13H3zM8 7V4h8v3" /></Svg>,
  wallet: (p: IconProps) => <Svg {...p}><path d="M3 7a2 2 0 0 1 2-2h13v4" /><rect x="3" y="7" width="18" height="13" rx="2" /><circle cx="16.5" cy="13.5" r="1.3" /></Svg>,
  rewards: (p: IconProps) => <Svg {...p}><path d="M12 15a6 6 0 1 0 0-12 6 6 0 0 0 0 12Z" /><path d="m8.5 14-1.5 7 5-3 5 3-1.5-7" /></Svg>,
  network: (p: IconProps) => <Svg {...p}><circle cx="12" cy="5" r="2.2" /><circle cx="5" cy="18" r="2.2" /><circle cx="19" cy="18" r="2.2" /><path d="M11 7 6 16M13 7l5 9M7.2 18h9.6" /></Svg>,
  routing: (p: IconProps) => <Svg {...p}><path d="M6 3v6a4 4 0 0 0 4 4h8M14 9l4 4-4 4M6 21v-4" /></Svg>,
  presets: (p: IconProps) => <Svg {...p}><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></Svg>,
  settings: (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></Svg>,
  audit: (p: IconProps) => <Svg {...p}><path d="M9 4h6a1 1 0 0 1 1 1v1H8V5a1 1 0 0 1 1-1Z" /><path d="M8 6H6a1 1 0 0 0-1 1v13a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-2M9 12h6M9 16h4" /></Svg>,
  copy: (p: IconProps) => <Svg {...p}><rect x="9" y="9" width="12" height="12" rx="2" /><path d="M5 15V5a2 2 0 0 1 2-2h10" /></Svg>,
  check: (p: IconProps) => <Svg {...p}><path d="m5 12 5 5L20 7" /></Svg>,
  plus: (p: IconProps) => <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>,
  up: (p: IconProps) => <Svg {...p}><path d="m6 15 6-6 6 6" /></Svg>,
  down: (p: IconProps) => <Svg {...p}><path d="m6 9 6 6 6-6" /></Svg>,
  x: (p: IconProps) => <Svg {...p}><path d="M6 6l12 12M18 6 6 18" /></Svg>,
  menu: (p: IconProps) => <Svg {...p}><path d="M4 6h16M4 12h16M4 18h16" /></Svg>,
  sun: (p: IconProps) => <Svg {...p}><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></Svg>,
  monitor: (p: IconProps) => <Svg {...p}><rect x="3" y="4" width="18" height="12" rx="2" /><path d="M8 20h8M12 16v4" /></Svg>,
  moon: (p: IconProps) => <Svg {...p}><path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z" /></Svg>,
  external: (p: IconProps) => <Svg {...p}><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></Svg>,
  download: (p: IconProps) => <Svg {...p}><path d="M12 4v11M7 10l5 5 5-5M4 20h16" /></Svg>,
  more: (p: IconProps) => <Svg {...p}><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></Svg>,
  shield: (p: IconProps) => <Svg {...p}><path d="M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6Z" /><path d="m9 12 2 2 4-4" /></Svg>,
  logout: (p: IconProps) => <Svg {...p}><path d="M15 4h4a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1h-4M10 17l5-5-5-5M15 12H3" /></Svg>,
}
