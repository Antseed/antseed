import { describe, expect, it } from 'vitest';
import { VIEW_NAMES, type ViewName } from '../types';
import { getViewRegistryEntry, navViews, preloadView, preloadViews, viewsForPreload, VIEW_REGISTRY } from './viewRegistry';

describe('view registry', () => {
  it('registers exactly one lazy component for every known view', () => {
    expect(Object.keys(VIEW_REGISTRY).sort()).toEqual([...VIEW_NAMES].sort());

    for (const view of VIEW_NAMES) {
      const entry = getViewRegistryEntry(view);
      expect(entry.component).toBe(VIEW_REGISTRY[view].component);
      expect(typeof entry.preload).toBe('function');
      expect(typeof entry.receivesOnSelectView).toBe('boolean');
    }
  });

  it('passes navigation callbacks to every view (diagnostics have back buttons)', () => {
    const navigationViews = VIEW_NAMES.filter((view) => getViewRegistryEntry(view).receivesOnSelectView);

    expect(navigationViews).toEqual([...VIEW_NAMES]);
  });

  it('reuses the same preload promise for repeated preload requests', () => {
    const entry = getViewRegistryEntry('connection');

    expect(entry.preload()).toBe(entry.preload());
  });

  it('can preload multiple views through the public helper', async () => {
    const loaded = await preloadViews(['connection']);

    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toBe(await preloadView('connection'));
  });

  it('derives the nav rail from registry metadata in slide order', () => {
    expect(navViews('main').map((entry) => entry.view)).toEqual(['home', 'chat', 'tools', 'rewards'] satisfies ViewName[]);
    expect(navViews('bottom').map((entry) => entry.view)).toEqual(['preferences'] satisfies ViewName[]);
    expect(getViewRegistryEntry('home').nav?.label).toBe('Home');
    expect(getViewRegistryEntry('tools').nav?.label).toBe('Apps');
    expect(getViewRegistryEntry('preferences').nav?.label).toBe('Settings');
    expect(getViewRegistryEntry('help').nav).toBeNull();
    expect(getViewRegistryEntry('deposit').nav).toBeNull();
    for (const entry of navViews('main')) {
      expect(entry.nav.label).toBeTruthy();
      expect(entry.nav.icon).toBeTruthy();
    }
  });

  it('splits route preloading into startup and idle tiers', () => {
    expect(viewsForPreload('eager')).toEqual(['home', 'tools', 'chat'] satisfies ViewName[]);
    expect(viewsForPreload('idle')).toEqual(['rewards', 'preferences', 'deposit', 'help'] satisfies ViewName[]);
  });

  it('assigns every view a slide position', () => {
    for (const view of VIEW_NAMES) {
      expect(getViewRegistryEntry(view).slideIndex).toBeGreaterThanOrEqual(0);
    }
    // Drill-in views slide in from the right of the tab that opens them.
    expect(getViewRegistryEntry('deposit').slideIndex).toBeGreaterThan(getViewRegistryEntry('preferences').slideIndex);
    expect(getViewRegistryEntry('help').slideIndex).toBeGreaterThan(getViewRegistryEntry('preferences').slideIndex);
  });
});
