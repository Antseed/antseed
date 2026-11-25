import { describe, expect, it } from 'vitest';
import { createHomeProgressStore, HOME_PROGRESS_KEY, parseHomeProgress } from './home-progress';
import { daysSince, pickHomePromo, promoDismissKey, HOME_PROMOS, type PromoFacts } from './home-promos';

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, data };
}

describe('home progress', () => {
  it('ignores malformed saved progress', () => {
    expect(parseHomeProgress('{not json').firstPromptAt).toBeNull();
    expect(parseHomeProgress(JSON.stringify({ firstPromptAt: 'yesterday', promosDismissed: ['a', 3] }))).toMatchObject({
      firstPromptAt: null,
      promosDismissed: ['a'],
    });
  });

  it('keeps the first prompt time and first agent, and saves each change', () => {
    const storage = memoryStorage();
    const store = createHomeProgressStore(storage);
    let notified = 0;
    store.subscribe(() => { notified += 1; });
    store.markFirstPrompt(100);
    store.markFirstPrompt(200);
    store.markAgent('OpenCode');
    store.markAgent('Codex');
    expect(store.get()).toMatchObject({ firstPromptAt: 100, agent: 'OpenCode' });
    expect(notified).toBe(2);
    expect(JSON.parse(storage.data.get(HOME_PROGRESS_KEY)!).agent).toBe('OpenCode');
  });

  it('hides setup only from the launch after it was finished', () => {
    const storage = memoryStorage();
    const first = createHomeProgressStore(storage);
    first.markSetupDone();
    expect(first.setupHiddenAtLaunch).toBe(false);
    expect(createHomeProgressStore(storage).setupHiddenAtLaunch).toBe(true);
  });

  it('minimize and close replace each other', () => {
    const store = createHomeProgressStore(memoryStorage());
    store.minimizeSetup();
    store.closeSetup();
    expect(store.get()).toMatchObject({ setupClosed: true, setupMinimized: false });
    store.openSetup();
    expect(store.get()).toMatchObject({ setupClosed: false, setupMinimized: false });
  });
});

describe('home banners', () => {
  const facts = (over: Partial<PromoFacts> = {}): PromoFacts => ({
    day: 0, funded: true, lowBalance: false, privateMode: false, rewardsLive: true, dismissed: [], ...over,
  });

  it('counts whole days from the first prompt', () => {
    expect(daysSince(null, 5)).toBe(0);
    expect(daysSince(0, 86_400_000 * 2.5)).toBe(2);
  });

  it('shows the newest banner the user has reached', () => {
    expect(pickHomePromo(facts({ day: 1 }))).toBeNull();
    expect(pickHomePromo(facts({ day: 3 }))?.id).toBe('telegram');
    expect(pickHomePromo(facts({ day: 6 }))?.id).toBe('private');
    expect(pickHomePromo(facts({ day: 6, privateMode: true }))?.id).toBe('telegram');
    expect(pickHomePromo(facts({ day: 8 }))?.id).toBe('rewards');
  });

  it('puts a low balance first, and a closed one returns the next day', () => {
    const topUp = HOME_PROMOS.find((promo) => promo.id === 'top-up')!;
    expect(pickHomePromo(facts({ day: 8, lowBalance: true }))?.id).toBe('top-up');
    const dismissed = [promoDismissKey(topUp, 8)];
    expect(pickHomePromo(facts({ day: 8, lowBalance: true, dismissed }))?.id).toBe('rewards');
    expect(pickHomePromo(facts({ day: 9, lowBalance: true, dismissed }))?.id).toBe('top-up');
  });
});
