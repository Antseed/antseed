/**
 * Shared light/dark theme state: a `dark-theme` class on <body> (styled in
 * global.scss) persisted under one localStorage key. Every window applies it
 * on boot — the main app, the setup title bar, and the floating pill — and a
 * `storage` listener keeps already-open windows in sync when the mode is
 * changed from any of them.
 *
 * Private mode paints the night palette on top of the saved mode without ever
 * changing it, so going back to Anonymous restores the user's own setting.
 */

export type ThemeMode = 'light' | 'dark';

const THEME_STORAGE_KEY = 'antseed:theme';

let chosenMode: ThemeMode = 'light';
let privateNight = false;

function paint(): void {
  document.body.classList.toggle('dark-theme', privateNight || chosenMode === 'dark');
}

export function getStoredThemeMode(): ThemeMode | null {
  try {
    const saved = localStorage.getItem(THEME_STORAGE_KEY);
    return saved === 'dark' || saved === 'light' ? saved : null;
  } catch {
    return null;
  }
}

/** The mode the user chose, whatever Private is painting over it. */
export function activeThemeMode(): ThemeMode {
  return chosenMode;
}

export function applyThemeMode(mode: ThemeMode): void {
  chosenMode = mode;
  paint();
  try {
    localStorage.setItem(THEME_STORAGE_KEY, mode);
  } catch {
    // storage unavailable — theme still applies for this session
  }
}

/** Paint the night palette while Private is on, leaving the saved mode alone. */
export function setPrivateNight(on: boolean): void {
  privateNight = on;
  paint();
}

/** Paint the persisted mode and follow changes made from other windows. */
export function initThemeMode(): void {
  chosenMode = getStoredThemeMode() ?? 'light';
  paint();
  window.addEventListener('storage', (event) => {
    if (event.key !== THEME_STORAGE_KEY) return;
    if (event.newValue === 'dark' || event.newValue === 'light') {
      chosenMode = event.newValue;
      paint();
    }
  });
}
