import { useMemo, useCallback } from 'react';
import type { DiscoverRow } from '../../core/state';
import { getPeerGradient } from '../../core/peer-utils';
import { getKnownProxy, type KnownProxy } from '../../core/known-proxies';
import { useRetainedState } from './useRetainedState';
import {
  applyFilters, applySort, rowReputationScore,
  MAX_INPUT_PRICE_SLIDER_USD, MAX_OUTPUT_PRICE_SLIDER_USD,
  DEFAULT_MIN_REPUTATION_SCORE,
  type DiscoverSortKey,
} from '../components/chat/discover-filter-util';

export type DiscoverPeerOption = {
  peerId: string;
  label: string;
  letter: string;
  gradient: string;
  iconUrl: string | null;
  /**
   * Metadata for a recognised on-chain seller-proxy contract (e.g. the DIEM
   * Staking Pool). Surfaced as a tiny contract icon next to the peer name in
   * the Discover peer-filter list and the chat sidebar so users can tell at
   * a glance which peers route settlement through a known pool. `null` for
   * peers that settle directly to their own derived address.
   */
  knownProxy: KnownProxy | null;
};

export type DiscoverFilterState = {
  search: string;
  categorySet: Set<string>;
  peerSet: Set<string>;
  maxInputPrice: number;
  maxOutputPrice: number;
  minStakeAnts: number;
  minReputationScore: number;
  sortKey: DiscoverSortKey;

  sortedRows: DiscoverRow[];
  availableCategories: string[];
  availablePeers: DiscoverPeerOption[];

  setSearch: (v: string) => void;
  toggleCategory: (cat: string) => void;
  togglePeer: (peerId: string) => void;
  setMaxInputPrice: (v: number) => void;
  setMaxOutputPrice: (v: number) => void;
  setMinStakeAnts: (v: number) => void;
  setMinReputationScore: (v: number) => void;
  setSortKey: (k: DiscoverSortKey) => void;
  resetAll: () => void;
};

// Renderer-lifetime cache: discover filters survive lazy page unmounts.
const discoverFilterCache = {
  search: '',
  categorySet: new Set<string>(),
  peerSet: new Set<string>(),
  maxInputPrice: MAX_INPUT_PRICE_SLIDER_USD,
  maxOutputPrice: MAX_OUTPUT_PRICE_SLIDER_USD,
  minStakeAnts: 0,
  minReputationScore: DEFAULT_MIN_REPUTATION_SCORE,
  sortKey: 'reputationDesc' as DiscoverSortKey,
};

export function useDiscoverFilters(rows: DiscoverRow[]): DiscoverFilterState {
  const [search, setSearch] = useRetainedState(discoverFilterCache, 'search');
  const [categorySet, setCategorySet] = useRetainedState(
    discoverFilterCache,
    'categorySet',
    (value) => new Set(value),
  );
  const [peerSet, setPeerSet] = useRetainedState(
    discoverFilterCache,
    'peerSet',
    (value) => new Set(value),
  );
  const [maxInputPrice, setMaxInputPrice] = useRetainedState(discoverFilterCache, 'maxInputPrice');
  const [maxOutputPrice, setMaxOutputPrice] = useRetainedState(discoverFilterCache, 'maxOutputPrice');
  const [minStakeAnts, setMinStakeAnts] = useRetainedState(discoverFilterCache, 'minStakeAnts');
  const [minReputationScore, setMinReputationScore] = useRetainedState(discoverFilterCache, 'minReputationScore');
  const [sortKey, setSortKey] = useRetainedState(discoverFilterCache, 'sortKey');

  const toggleCategory = useCallback((cat: string) => {
    setCategorySet((prev) => {
      const next = new Set(prev);
      const key = cat.toLowerCase();
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, [setCategorySet]);

  const togglePeer = useCallback((peerId: string) => {
    setPeerSet((prev) => {
      const next = new Set(prev);
      if (next.has(peerId)) next.delete(peerId);
      else next.add(peerId);
      return next;
    });
  }, [setPeerSet]);

  const resetAll = useCallback(() => {
    setSearch('');
    setCategorySet(new Set());
    setPeerSet(new Set());
    setMaxInputPrice(MAX_INPUT_PRICE_SLIDER_USD);
    setMaxOutputPrice(MAX_OUTPUT_PRICE_SLIDER_USD);
    setMinStakeAnts(0);
    setMinReputationScore(DEFAULT_MIN_REPUTATION_SCORE);
    setSortKey('reputationDesc');
  }, [
    setCategorySet,
    setMaxInputPrice,
    setMaxOutputPrice,
    setMinReputationScore,
    setMinStakeAnts,
    setPeerSet,
    setSearch,
    setSortKey,
  ]);

  const availableCategories = useMemo(() => {
    const set = new Set<string>();
    for (const r of rows) for (const c of r.categories) set.add(c);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [rows]);

  const availablePeers = useMemo<DiscoverPeerOption[]>(() => {
    // One entry per peer, ranked by on-chain reputation so strong activity
    // floats to the top of the sidebar without hiding brand-new peers.
    const seen = new Map<string, { opt: DiscoverPeerOption; score: number; label: string }>();
    for (const r of rows) {
      if (!r.peerId || seen.has(r.peerId)) continue;
      const label = r.peerDisplayName?.trim() || r.peerLabel?.trim() || r.peerId;
      const gradient = getPeerGradient(r.peerId || r.peerLabel || r.provider || r.serviceId);
      const letter = (label || '?').charAt(0).toUpperCase();
      seen.set(r.peerId, {
        opt: { peerId: r.peerId, label, letter, gradient, iconUrl: r.peerIconUrl, knownProxy: getKnownProxy(r.sellerContract) },
        score: rowReputationScore(r),
        label,
      });
    }
    return Array.from(seen.values())
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return a.label.localeCompare(b.label);
      })
      .map((e) => e.opt);
  }, [rows]);

  const filteredRows = useMemo(
    () => applyFilters(rows, {
      search, categorySet, peerSet, maxInputPrice, maxOutputPrice, minStakeAnts,
      minReputationScore,
    }),
    [rows, search, categorySet, peerSet, maxInputPrice, maxOutputPrice, minStakeAnts,
      minReputationScore],
  );

  const sortedRows = useMemo(
    () => applySort(filteredRows, sortKey, 'desc'),
    [filteredRows, sortKey],
  );

  return {
    search,
    categorySet,
    peerSet,
    maxInputPrice,
    maxOutputPrice,
    minStakeAnts,
    minReputationScore,
    sortKey,

    sortedRows,
    availableCategories,
    availablePeers,

    setSearch,
    toggleCategory,
    togglePeer,
    setMaxInputPrice,
    setMaxOutputPrice,
    setMinStakeAnts,
    setMinReputationScore,
    setSortKey,
    resetAll,
  };
}
