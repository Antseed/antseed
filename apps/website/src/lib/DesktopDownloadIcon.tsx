import type {JSX} from 'react';
import type {DesktopPlatform} from './useLatestDesktopDownload';

/**
 * Small monochrome glyph matching the visitor's OS. Inherits `currentColor`
 * so it works against any button background. Kept inline (no external icon
 * dep) to avoid pulling a package into the Docusaurus bundle for two icons.
 */
export function DesktopDownloadIcon({
  platform,
  size = 16,
}: {
  platform: DesktopPlatform;
  size?: number;
}): JSX.Element {
  if (platform === 'win') {
    // Windows logo: four tiles.
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M3 5.5L11 4.3v7.2H3zM12 4.2L21 3v8.5h-9zM3 12.5h8v7.2L3 18.5zM12 12.5h9V21l-9-1.3z"/>
      </svg>
    );
  }
  if (platform === 'mac') {
    // Apple logo.
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.8-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M13 3.5c.73-.83 1.94-1.46 2.94-1.5.13 1.17-.34 2.35-1.04 3.19-.69.85-1.83 1.51-2.95 1.42-.15-1.15.41-2.35 1.05-3.11z"/>
      </svg>
    );
  }
  // Generic download tray — used for Linux / unknown (mobile, etc.).
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 3v12"/>
      <path d="M7 10l5 5 5-5"/>
      <path d="M5 21h14"/>
    </svg>
  );
}
