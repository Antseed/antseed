/**
 * macOS Dock and app icon selection rules.
 *
 * Packaged macOS `.app` bundles already ship `Contents/Resources/icon.icns` via
 * `CFBundleIconFile`. Calling `app.dock.setIcon()` at runtime replaces that
 * native bundle icon with a raw bitmap and bypasses macOS IconServices (which
 * breaks system squircle/Liquid Glass styling on macOS 26+ and causes the Dock
 * icon to jump size on launch). Only set the Dock icon at runtime in unpackaged
 * dev runs where the host bundle is still Electron.app.
 */
export function shouldSetMacDockIcon(platform: NodeJS.Platform, isPackaged: boolean): boolean {
  return platform === 'darwin' && !isPackaged;
}

/**
 * Asset filename preference order for the app icon on a given platform.
 * macOS uses a dedicated 1024x1024 asset with Apple's 824x824 squircle grid
 * (100px inset on every side); Windows and Linux keep `antseed-dock-icon.png`.
 */
export function appIconAssetCandidates(platform: NodeJS.Platform): readonly string[] {
  return platform === 'darwin'
    ? ['antseed-mac-icon.png', 'antseed-dock-icon.png', 'antseed-mark.png']
    : ['antseed-dock-icon.png', 'antseed-mark.png'];
}
