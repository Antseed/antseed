import type {FileLink} from './Kit';

const DIR = '/brand/downloads';

export const BRAND_KIT = `${DIR}/antseed-brand-assets.zip`;
export const BRAND_KIT_SIZE = 'ZIP, 9 MB';
export const BRAND_GUIDE = `${DIR}/antseed-brand.md`;

export type LogoKind = 'logo' | 'mark';
export type LogoTone = 'black' | 'white';

export const logoSrc = (kind: LogoKind, tone: LogoTone): string => `${DIR}/antseed-${kind}-${tone}.svg`;

export const logoFiles = (kind: LogoKind, tone: LogoTone): readonly FileLink[] => [
  {label: 'SVG', href: logoSrc(kind, tone)},
  {label: 'PNG', href: `${DIR}/antseed-${kind}-${tone}.png`},
];
