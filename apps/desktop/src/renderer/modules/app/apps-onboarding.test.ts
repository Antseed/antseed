import { describe, expect, it } from 'vitest';
import {
  APPS_ONBOARDING_SEEN_KEY,
  isAppsOnboardingSeen,
  persistAppsOnboardingSeen,
  shouldNotifyAppsOnboarding,
} from './apps-onboarding';

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    map,
  };
}

describe('apps-onboarding', () => {
  it('is unseen by default', () => {
    expect(isAppsOnboardingSeen(memoryStorage())).toBe(false);
    expect(isAppsOnboardingSeen(null)).toBe(false);
  });

  it('notifies until the intro has been seen', () => {
    const storage = memoryStorage();
    expect(shouldNotifyAppsOnboarding(storage)).toBe(true);

    persistAppsOnboardingSeen(storage);
    expect(storage.getItem(APPS_ONBOARDING_SEEN_KEY)).toBe('true');
    expect(shouldNotifyAppsOnboarding(storage)).toBe(false);
  });

  it('swallows storage errors', () => {
    const broken = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    };
    expect(isAppsOnboardingSeen(broken)).toBe(false);
    expect(() => persistAppsOnboardingSeen(broken)).not.toThrow();
    expect(shouldNotifyAppsOnboarding(broken)).toBe(true);
  });
});
