import {useEffect, useState, type RefObject} from 'react';
import {usePluginData} from '@docusaurus/useGlobalData';
import {createSharedFetch, type SharedFetch} from '../sharedFetch';
import {useInView} from '../useInView';
import {LOADERS} from './client';
import type {AntsToken, AntscanResources, AntscanSnapshot, MarketView, NetworkTotals, ResourceKey} from './types';

/** The plugin (plugins/antscan-snapshot.ts) that reads every resource at build time. */
export const SNAPSHOT_PLUGIN = 'antscan-snapshot';

const CACHE_TTL_MS = 5 * 60 * 1000;
/** The market read (about 3 MB of JSON from Antscan and OpenRouter) starts once the visitor scrolls, or its section is on screen. */
const MARKET_MARGIN = '0px';
const NO_ELEMENT: RefObject<Element | null> = {current: null};
const TIMEOUT_MS = 10_000;
const cacheKey = (key: ResourceKey) => `antscan-${key}-v1`;

function readCache<K extends ResourceKey>(key: K): AntscanResources[K] | null {
  try {
    const raw = sessionStorage.getItem(cacheKey(key));
    if (!raw) return null;
    const {at, value} = JSON.parse(raw) as {at: number; value: AntscanResources[K]};
    return Date.now() - at < CACHE_TTL_MS ? value : null;
  } catch {
    return null;
  }
}

function writeCache<K extends ResourceKey>(key: K, value: AntscanResources[K]): void {
  try {
    sessionStorage.setItem(cacheKey(key), JSON.stringify({at: Date.now(), value}));
  } catch {
    /* storage disabled or full: the next page reads the network again */
  }
}

const shared = new Map<ResourceKey, () => SharedFetch<unknown>>();
/** Hooks showing a resource without reading it themselves, told when another hook's read lands. */
const watchers = new Map<ResourceKey, Set<(value: unknown) => void>>();

function subscribe<K extends ResourceKey>(key: K): SharedFetch<AntscanResources[K]> {
  let start = shared.get(key);
  if (!start) {
    start = createSharedFetch(async (signal) => {
      const value = await LOADERS[key](signal);
      writeCache(key, value);
      watchers.get(key)?.forEach((tell) => tell(value));
      return value;
    }, TIMEOUT_MS);
    shared.set(key, start);
  }
  return start() as SharedFetch<AntscanResources[K]>;
}

/**
 * One resource of the site's network view: the build's snapshot on the server and in the first client render (so hydration
 * matches), then the session's cached read, and a live one after mount while `live` (otherwise the next read another hook makes).
 * One request per resource is shared by every mounted hook, and it is aborted when the last one unmounts. A failed read keeps what
 * is shown.
 */
export function useAntscan<K extends ResourceKey>(key: K, live = true): AntscanResources[K] {
  const snapshot = usePluginData(SNAPSHOT_PLUGIN) as AntscanSnapshot;
  const [value, setValue] = useState<AntscanResources[K]>(snapshot[key]);
  useEffect(() => {
    const cached = readCache(key);
    if (cached) { setValue(cached); return undefined; }
    if (!live) {
      const tell = (read: unknown) => setValue(read as AntscanResources[K]);
      const set = watchers.get(key) ?? new Set();
      watchers.set(key, set.add(tell));
      return () => { set.delete(tell); };
    }
    let mounted = true;
    const {promise, unsubscribe} = subscribe(key);
    promise.then((read) => { if (mounted && read) setValue(read); });
    return () => { mounted = false; unsubscribe(); };
  }, [key, live]);
  return value;
}

/** Lifetime users, providers, requests, tokens and USDC settled. */
export const useNetworkTotals = (): NetworkTotals => useAntscan('totals');

/**
 * The count of models on offer and the price board's lanes. Read live once the visitor scrolls or `near` (the section showing them)
 * is on screen, so the read never weighs on the first screen; without `near`, the build's snapshot (or this session's earlier read).
 */
export function useMarket(near?: RefObject<Element | null>): MarketView {
  const shown = useInView(near ?? NO_ELEMENT, {rootMargin: MARKET_MARGIN, once: true});
  const scrolled = useScrolled(!!near);
  return useAntscan('market', !!near && (shown || scrolled));
}

/** True from the visitor's first scroll on (watched only while `watch`). */
function useScrolled(watch: boolean): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    if (!watch || scrolled) return undefined;
    const on = () => setScrolled(true);
    window.addEventListener('scroll', on, {once: true, passive: true});
    return () => window.removeEventListener('scroll', on);
  }, [watch, scrolled]);
  return scrolled;
}
/** ANTS supply, burned and the emission clock as last read. */
export const useAntsToken = (): AntsToken => useAntscan('ants');
