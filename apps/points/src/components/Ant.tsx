import { useId } from 'react';

// The Antseed ant faces from the design canvas ("Ant face avatars"):
// 01 Node head — the logo's head and dot antennae plus two eyes; it blinks and
// its antennae twitch. 04 Halftone — the site's dot-ant texture as a face.

export function Ant({ size = 200, color = '#10B981', ink = '#001E12', style }: { size?: number; color?: string; ink?: string; style?: React.CSSProperties }) {
  return (
    <svg viewBox="0 0 200 200" width={size} height={size} aria-hidden="true" style={style}>
      <g className="ant-l">
        <path d="M78 72 L52 34" stroke={color} strokeWidth="7" strokeLinecap="round" />
        <circle cx="50" cy="31" r="11" fill={color} />
      </g>
      <g className="ant-r">
        <path d="M122 72 L148 34" stroke={color} strokeWidth="7" strokeLinecap="round" />
        <circle cx="150" cy="31" r="11" fill={color} />
      </g>
      <ellipse cx="100" cy="118" rx="60" ry="56" fill={color} />
      <g className="ant-eyes">
        <ellipse cx="80" cy="112" rx="9" ry="15" fill={ink} />
        <ellipse cx="120" cy="112" rx="9" ry="15" fill={ink} />
      </g>
    </svg>
  );
}

export function HalftoneAnt({ size = 200, color = '#0A6F4D', style }: { size?: number; color?: string; style?: React.CSSProperties }) {
  const id = useId().replace(/:/g, '');
  return (
    <svg viewBox="0 0 200 200" width={size} height={size} aria-hidden="true" style={style}>
      <defs>
        <pattern id={`ht-${id}`} width="10" height="10" patternUnits="userSpaceOnUse">
          <circle cx="5" cy="5" r="3.3" fill={color} />
        </pattern>
        <clipPath id={`hc-${id}`}>
          <ellipse cx="100" cy="118" rx="62" ry="58" />
        </clipPath>
      </defs>
      <g fill={color}>
        <circle cx="78" cy="68" r="4" /><circle cx="72" cy="58" r="4" /><circle cx="66" cy="48" r="4" /><circle cx="60" cy="38" r="4" /><circle cx="52" cy="30" r="8" />
        <circle cx="122" cy="68" r="4" /><circle cx="128" cy="58" r="4" /><circle cx="134" cy="48" r="4" /><circle cx="140" cy="38" r="4" /><circle cx="148" cy="30" r="8" />
      </g>
      <rect width="200" height="200" fill={`url(#ht-${id})`} clipPath={`url(#hc-${id})`} />
      <g className="ant-eyes" style={{ animationDelay: '-1.3s' }}>
        <ellipse cx="80" cy="112" rx="11" ry="17" fill="#001E12" />
        <ellipse cx="120" cy="112" rx="11" ry="17" fill="#001E12" />
      </g>
    </svg>
  );
}

/** Small round icons for the three ways to earn. */
export function WayIcon({ kind }: { kind: 'use' | 'provide' | 'back' }) {
  if (kind === 'back') {
    return (
      <i style={{ background: '#001E12' }}>
        <svg viewBox="0 0 120 120" width="46" height="46" aria-hidden="true">
          <circle cx="60" cy="22" r="13" fill="#F2C46D" />
          <path d="M16 46 V92 Q16 106 30 106 H90 Q104 106 104 92 V46" fill="none" stroke="#3DC799" strokeWidth="10" strokeLinecap="round" />
          <circle cx="44" cy="84" r="13" fill="#3DC799" />
          <circle cx="76" cy="84" r="13" fill="#3DC799" />
          <circle cx="60" cy="62" r="13" fill="#3DC799" />
        </svg>
      </i>
    );
  }
  const provide = kind === 'provide';
  const head = provide ? '#001E12' : '#C6F0E2';
  const eye = provide ? '#FFFFFF' : '#001E12';
  return (
    <i style={{ background: provide ? '#F2C46D' : '#10B981' }}>
      <svg viewBox="0 0 200 200" width="60" height="60" aria-hidden="true">
        <path d="M78 72 L52 34 M122 72 L148 34" stroke="#001E12" strokeWidth="9" strokeLinecap="round" />
        <circle cx="50" cy="31" r="13" fill="#001E12" />
        <circle cx="150" cy="31" r="13" fill="#001E12" />
        <ellipse cx="100" cy="118" rx="60" ry="56" fill={head} />
        <ellipse cx="80" cy="112" rx="10" ry="16" fill={eye} />
        <ellipse cx="120" cy="112" rx="10" ry="16" fill={eye} />
      </svg>
    </i>
  );
}

const PIXEL_BODY =
  'M2 0h1v1h-1zM10 0h1v1h-1zM3 1h1v1h-1zM9 1h1v1h-1zM4 2h5v1h-5zM3 3h7v1h-7zM2 4h9v1h-9zM2 5h2v1h-2zM5 5h3v1h-3zM9 5h2v1h-2zM2 6h2v1h-2zM5 6h3v1h-3zM9 6h2v1h-2zM2 7h9v1h-9zM2 8h9v1h-9zM3 9h7v1h-7zM4 10h5v1h-5z';
const PIXEL_EYES = 'M4 5h1v1h-1zM8 5h1v1h-1zM4 6h1v1h-1zM8 6h1v1h-1z';

/**
 * The pixel ant from the "for agents" direction: illustration only, never the logo.
 * It blinks; with `seed` it carries a gold seed (an ANTS) on its back; with `hop` it bounces.
 */
export function PixelAnt({ size = 52, color = '#001E12', eyes = '#C6F0E2', seed = false, hop = false, style }: {
  size?: number;
  color?: string;
  eyes?: string;
  seed?: boolean;
  hop?: boolean;
  style?: React.CSSProperties;
}) {
  return (
    <svg
      viewBox={seed ? '0 -2 13 13' : '0 0 13 11'}
      width={size}
      height={seed ? size : (size * 11) / 13}
      shapeRendering="crispEdges"
      aria-hidden="true"
      className={hop ? 'px-hop' : undefined}
      style={style}
    >
      {seed && <rect x="5" y="-2" width="3" height="1.4" fill="#F2C46D" />}
      <path d={PIXEL_BODY} fill={color} />
      <path className="px-eyes" d={PIXEL_EYES} fill={eyes} />
    </svg>
  );
}
