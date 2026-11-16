import { beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'antseed:theme';

async function loadTheme(stored: string | null) {
  vi.resetModules();
  const classes = new Set<string>();
  const storage = new Map<string, string>(stored ? [[KEY, stored]] : []);
  vi.stubGlobal('document', {
    body: {
      classList: {
        toggle: (name: string, on: boolean) => { if (on) classes.add(name); else classes.delete(name); },
        contains: (name: string) => classes.has(name),
      },
    },
  });
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  });
  vi.stubGlobal('window', { addEventListener: () => {} });
  const theme = await import('./theme');
  theme.initThemeMode();
  return { theme, isDark: () => classes.has('dark-theme'), saved: () => storage.get(KEY) ?? null };
}

describe('Private night palette', () => {
  beforeEach(() => vi.unstubAllGlobals());

  it('paints night over a light setting and restores it, without saving anything', async () => {
    const { theme, isDark, saved } = await loadTheme('light');
    theme.setPrivateNight(true);
    expect(isDark()).toBe(true);
    expect(saved()).toBe('light');
    expect(theme.activeThemeMode()).toBe('light');
    theme.setPrivateNight(false);
    expect(isDark()).toBe(false);
  });

  it('keeps a dark setting after Private turns off', async () => {
    const { theme, isDark } = await loadTheme('dark');
    theme.setPrivateNight(true);
    theme.setPrivateNight(false);
    expect(isDark()).toBe(true);
  });

  it('saves a theme chosen during Private and applies it when Private turns off', async () => {
    const { theme, isDark, saved } = await loadTheme('dark');
    theme.setPrivateNight(true);
    theme.applyThemeMode('light');
    expect(isDark()).toBe(true);
    expect(saved()).toBe('light');
    theme.setPrivateNight(false);
    expect(isDark()).toBe(false);
  });
});
