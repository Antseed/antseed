import type {Os} from '../../../parts/DownloadButton/useDesktopDownload';

export const PILL = {href: '/blog/antseed-foundation-raises-2-4m/', lead: 'We raised ', amount: '$2.4M', tail: ', led by Spark Capital'};
export const TITLE = {ink: 'The open', muted: 'intelligence network'};

export const GATEWAY_COMMAND = 'curl -fsSL https://antseed.com/install.sh | bash';
export const GATEWAY_DOCS = '/docs/quickstart/';

export type Build = {os: Os; id: string; detail: string};
export const BUILDS: Build[] = [
  {os: 'mac', id: 'mac-arm64', detail: 'Apple Silicon'},
  {os: 'mac', id: 'mac-x64', detail: 'Intel'},
  {os: 'win', id: 'win-x64', detail: 'x64 installer'},
  {os: 'linux', id: 'linux-x64', detail: 'AppImage · x86_64'},
  {os: 'linux', id: 'linux-arm64', detail: 'AppImage · ARM64'},
];
export const OLDER_BUILDS = 'https://github.com/AntSeed/antseed/releases';

export type Figure = {label: string; value: string};

const billions = (n: number) => `${(n / 1e9).toFixed(1)}B`;
export const formatFigure = (n: number): string => (n >= 1e9 ? billions(n) : n.toLocaleString('en-US'));

export const ASSETS = {
  poster: '/site/assets/hero/meadow-day.webp',
  night: '/site/assets/hero/meadow-night.webp',
  nightLoop: '/site/assets/hero/meadow-night-loop.mp4',
  dayLoop: '/site/assets/hero/meadow-day-loop',
  seedDay: '/site/assets/hero/seed-day.webp',
  seedNight: '/site/assets/hero/seed-night.webp',
  chevron: '/site/assets/hero/chevron-right.svg',
  copy: '/site/assets/hero/copy.svg',
};
