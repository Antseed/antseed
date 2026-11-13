import { useSyncExternalStore } from 'react';
import { defaultStorage, type StorageLike } from './local-storage-flag';

/**
 * What the user has done so far, for Home's setup steps and banners. Kept per
 * install in localStorage, like the other one-off onboarding state.
 */
export const HOME_PROGRESS_KEY = 'antseed:homeProgress';

export type HomeProgress = {
  /** When the first prompt went out. Home shows the big chat box until then. */
  firstPromptAt: number | null;
  /** The agent the Antseed skills went into, or 'prompt' once the setup prompt was copied. */
  agent: string | null;
  /** The user opened their keys or copied this app's key. */
  key: boolean;
  /** The one-time "your chats live here now" note in Chat was dismissed. */
  chatNoteSeen: boolean;
  /** Every setup step is done. Setup leaves Home from the next launch. */
  setupDone: boolean;
  setupMinimized: boolean;
  setupClosed: boolean;
  /** Banner ids the user closed (daily ones carry `@day`). */
  promosDismissed: string[];
};

const EMPTY: HomeProgress = {
  firstPromptAt: null,
  agent: null,
  key: false,
  chatNoteSeen: false,
  setupDone: false,
  setupMinimized: false,
  setupClosed: false,
  promosDismissed: [],
};

export function parseHomeProgress(raw: string | null): HomeProgress {
  if (!raw) return EMPTY;
  try {
    const value = JSON.parse(raw) as Partial<Record<keyof HomeProgress, unknown>>;
    return {
      firstPromptAt: typeof value.firstPromptAt === 'number' ? value.firstPromptAt : null,
      agent: typeof value.agent === 'string' ? value.agent : null,
      key: value.key === true,
      chatNoteSeen: value.chatNoteSeen === true,
      setupDone: value.setupDone === true,
      setupMinimized: value.setupMinimized === true,
      setupClosed: value.setupClosed === true,
      promosDismissed: Array.isArray(value.promosDismissed)
        ? value.promosDismissed.filter((id): id is string => typeof id === 'string')
        : [],
    };
  } catch {
    return EMPTY;
  }
}

export function createHomeProgressStore(storage: StorageLike | null) {
  let state = parseHomeProgress(safeRead(storage));
  // Setup that was already finished at launch stays off Home this session.
  const setupHiddenAtLaunch = state.setupDone;
  const listeners = new Set<() => void>();

  function update(patch: Partial<HomeProgress>): void {
    const next = { ...state, ...patch };
    if ((Object.keys(patch) as Array<keyof HomeProgress>).every((key) => next[key] === state[key])) return;
    state = next;
    try {
      storage?.setItem(HOME_PROGRESS_KEY, JSON.stringify(state));
    } catch {
      // Storage unavailable; progress lasts until the app restarts.
    }
    listeners.forEach((listener) => listener());
  }

  return {
    get: (): HomeProgress => state,
    setupHiddenAtLaunch,
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    markFirstPrompt(at = Date.now()): void {
      if (state.firstPromptAt === null) update({ firstPromptAt: at });
    },
    markAgent(agent: string): void {
      if (state.agent === null) update({ agent });
    },
    markKey: (): void => update({ key: true }),
    markChatNoteSeen: (): void => update({ chatNoteSeen: true }),
    markSetupDone: (): void => update({ setupDone: true }),
    minimizeSetup: (): void => update({ setupMinimized: true, setupClosed: false }),
    openSetup: (): void => update({ setupMinimized: false, setupClosed: false }),
    closeSetup: (): void => update({ setupClosed: true, setupMinimized: false }),
    dismissPromo(id: string): void {
      if (!state.promosDismissed.includes(id)) update({ promosDismissed: [...state.promosDismissed, id] });
    },
  };
}

function safeRead(storage: StorageLike | null): string | null {
  try {
    return storage?.getItem(HOME_PROGRESS_KEY) ?? null;
  } catch {
    return null;
  }
}

export const homeProgress = createHomeProgressStore(defaultStorage());

export function useHomeProgress(): HomeProgress & { setupHidden: boolean } {
  const state = useSyncExternalStore(homeProgress.subscribe, homeProgress.get, homeProgress.get);
  return { ...state, setupHidden: homeProgress.setupHiddenAtLaunch };
}
