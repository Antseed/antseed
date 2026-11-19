const DIR = '/brand/downloads';

export type LogoFile = {label: string; href: string};

export type LogoPlate = {
  /** Which ground the files are made for; the plate keeps that ground in both themes. */
  ground: 'paper' | 'night';
  title: string;
  logo: string;
  mark: string;
  files: readonly LogoFile[];
};

const files = (tone: 'black' | 'white'): readonly LogoFile[] => [
  {label: 'Logo SVG', href: `${DIR}/antseed-logo-${tone}.svg`},
  {label: 'Logo PNG', href: `${DIR}/antseed-logo-${tone}.png`},
  {label: 'Mark SVG', href: `${DIR}/antseed-mark-${tone}.svg`},
  {label: 'Mark PNG', href: `${DIR}/antseed-mark-${tone}.png`},
];

export const LOGO_PLATES: readonly LogoPlate[] = [
  {ground: 'paper', title: 'Black, on paper', logo: `${DIR}/antseed-logo-black.svg`, mark: `${DIR}/antseed-mark-black.svg`, files: files('black')},
  {ground: 'night', title: 'Near-white, at night', logo: `${DIR}/antseed-logo-white.svg`, mark: `${DIR}/antseed-mark-white.svg`, files: files('white')},
];

export const BRAND_KIT = `${DIR}/antseed-brand-assets.zip`;

export const LOGO_RULES = [
  {icon: 'check', text: 'Clear space at least the height of its capitals'},
  {icon: 'check', text: 'On paper or frosted glass, never on a painting'},
  {icon: 'check', text: 'Never redrawn, recoloured or given a face'},
] as const;
