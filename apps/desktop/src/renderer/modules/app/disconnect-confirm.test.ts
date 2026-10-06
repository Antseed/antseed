import { describe, expect, it } from 'vitest';
import {
  DISCONNECT_CONFIRM_DISMISSED_KEY,
  isDisconnectConfirmDismissed,
  persistDisconnectConfirmDismissed,
} from './disconnect-confirm';

function memoryStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    map,
  };
}

describe('disconnect-confirm', () => {
  it('is not dismissed by default', () => {
    expect(isDisconnectConfirmDismissed(memoryStorage())).toBe(false);
    expect(isDisconnectConfirmDismissed(null)).toBe(false);
  });

  it('persists only when the user ticks "don\'t show again"', () => {
    const storage = memoryStorage();
    persistDisconnectConfirmDismissed(false, storage);
    expect(storage.map.has(DISCONNECT_CONFIRM_DISMISSED_KEY)).toBe(false);
    expect(isDisconnectConfirmDismissed(storage)).toBe(false);

    persistDisconnectConfirmDismissed(true, storage);
    expect(storage.getItem(DISCONNECT_CONFIRM_DISMISSED_KEY)).toBe('true');
    expect(isDisconnectConfirmDismissed(storage)).toBe(true);
  });

  it('swallows storage errors', () => {
    const broken = {
      getItem: () => { throw new Error('denied'); },
      setItem: () => { throw new Error('denied'); },
    };
    expect(isDisconnectConfirmDismissed(broken)).toBe(false);
    expect(() => persistDisconnectConfirmDismissed(true, broken)).not.toThrow();
  });
});
