import { useState, useMemo, useCallback, useEffect } from 'react';
import type { CSSProperties, MouseEvent } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { Copy01Icon, Tick02Icon, ContractsIcon, GithubIcon, Globe02Icon } from '@hugeicons/core-free-icons';
import Skeleton from 'react-loading-skeleton';
import 'react-loading-skeleton/dist/skeleton.css';
import type { ChatServiceOptionEntry, DiscoverRow, DiscoverVerificationLink } from '../../../core/state';
import { useUiSelector } from '../../hooks/useUiSelector';
import { useDiscoverFilters } from '../../hooks/useDiscoverFilters';
import {
  type DiscoverSortKey,
  MAX_INPUT_PRICE_SLIDER_USD,
  MAX_OUTPUT_PRICE_SLIDER_USD,
  DEFAULT_MIN_REPUTATION_SCORE,
  formatCategoryLabel,
} from './discover-filter-util';
import { DiscoverFilters } from './DiscoverFilters';
import { displayModelLabel } from '../../../modules/catalog/model-identity';
import {
  getPeerGradient,
  getPeerDisplayName,
  formatPerMillionPrice,
  getTagTint,
  formatReputationScore,
} from '../../../core/peer-utils';
import { getKnownProxy, type KnownProxy } from '../../../core/known-proxies';
import { InfoTooltip } from '../InfoTooltip';
import styles from './DiscoverWelcome.module.scss';

/**
 * Cap the visible tag count on Discover cards to avoid wrapping onto a
 * second line when a service has 5+ categories (e.g. anon + chat + coding +
 * reasoning + multimodal). Overflow is shown as a single “+N” pill whose
 * tooltip lists the hidden tags.
 */
const MAX_VISIBLE_CARD_TAGS = 4;
const LOW_REPUTATION_SCORE_THRESHOLD = 50;

const SORT_OPTIONS: Array<{ key: DiscoverSortKey; label: string }> = [
  { key: 'reputationDesc',  label: 'Best reputation' },
  { key: 'channelsDesc',    label: 'Most channels' },
  { key: 'recentlyUsed',    label: 'Recently used' },
  { key: 'serviceAsc',      label: 'Name A–Z' },
  { key: 'serviceDesc',     label: 'Name Z–A' },
  { key: 'priceAsc',        label: 'Price low to high' },
  { key: 'priceDesc',       label: 'Price high to low' },
  { key: 'stakeDesc',       label: 'Most staked' },
  { key: 'lastSettledDesc', label: 'Recently settled' },
];

/* ── Card data type ──────────────────────────────────────────────────── */

type CardItem = {
  name: string;
  canonicalName: string;
  displayName: string;
  peerLabel: string;
  peerId: string;
  peerIconUrl: string | null;
  value: string;
  provider: string;
  providerCount: number;
  tags: string[];
  gradient: string;
  description: string;
  /**
   * Identification (not verification) badge for known seller-proxy contracts
   * — e.g. the DIEM Staking Pool. `null` when the peer settles to its own
   * derived address or the proxy is not in our known registry.
   */
  knownProxy: KnownProxy | null;
  verificationLinks: DiscoverVerificationLink[];
  inputUsdPerMillion: number | null;
  outputUsdPerMillion: number | null;
  cachedInputUsdPerMillion: number | null;
  reputationScore: number | null; // 0-100 trust score (model-adjusted when available)
  channelCount: number;       // on-chain, from AntseedChannels.getAgentStats
  volumeUsdc: number;         // settled on-chain USDC volume
  poolStakeAnts: number;      // ANTS staked in the seller pool this epoch
  washFlagged: boolean | null; // AntseedWashTradingRegistry verdict; null when unavailable
  sybilRisk: number | null;
  sybilFlags: string[];
  lifetimeRequests: number;   // network-wide (mainnet) or local buyer total (fallback)
  lifetimeTokens: number;     // network-wide (mainnet) or local buyer total (fallback)
};

const SYBIL_WARN_THRESHOLD = 0.30;

const SYBIL_FLAG_LABELS: Record<string, string> = {
  narrow_custom:   'narrow custom service',
  burn_rate:       'high channel burn rate',
  subfloor_ticket: 'sub-floor avg ticket',
  young_high_vol:  'young agent, high volume',
};

function formatSybilFlag(flag: string): string {
  return SYBIL_FLAG_LABELS[flag] ?? flag.replace(/_/g, ' ');
}

function sybilHasSignals(item: { sybilFlags: string[] }): boolean {
  return item.sybilFlags.length > 0;
}

function sybilIsAlarming(item: { sybilRisk: number | null; sybilFlags: string[] }): boolean {
  return sybilHasSignals(item)
    && typeof item.sybilRisk === 'number'
    && item.sybilRisk >= SYBIL_WARN_THRESHOLD;
}

/* ── Normalize service name for display (dashes → spaces) ─────────────── */

function normalizeServiceName(name: string): string {
  return name.replace(/[-_]+/g, ' ');
}

/* ── Generate description from service name ──────────────────────────── */

function generateDescription(serviceId: string, categories: string[], provider: string): string {
  const lower = serviceId.toLowerCase();
  const prov = provider || 'a network peer';

  if (lower.includes('claude')) return `Access to Anthropic's Claude model. Powered by ${prov}.`;
  if (lower.includes('gpt') || lower.includes('openai')) return `OpenAI model access through ${prov}.`;
  if (lower.includes('llama')) return `Meta's Llama open-weight model. Hosted by ${prov}.`;
  if (lower.includes('deepseek')) return `DeepSeek reasoning model. Served by ${prov}.`;
  if (lower.includes('mistral')) return `Mistral's flagship model. Strong multilingual and instruction following.`;
  if (lower.includes('kimi')) return `Moonshot's Kimi reasoning model. High-performance math and code.`;
  if (lower.includes('qwen')) return `Alibaba's Qwen model series. Multilingual and versatile.`;
  if (lower.includes('gemini') || lower.includes('gemma')) return `Google's model. Powered by ${prov}.`;
  if (lower.includes('flux') || lower.includes('sdxl')) return `Image generation model. Served by ${prov}.`;
  if (categories.length > 0) return `${categories.map(formatCategoryLabel).join(' & ')} service powered by ${prov}.`;
  return `AI service powered by ${prov}.`;
}

/* ── Build cards from network service options ──────────────────────────── */

function buildCards(options: ChatServiceOptionEntry[]): CardItem[] {
  return options.map((opt) => {
    const baseTags = opt.categories;
    const tags = baseTags.some((t) => t.toLowerCase() === 'anon')
      ? baseTags
      : ['anon', ...baseTags];
    const rawName = displayModelLabel(opt.id, opt.label);
    return {
      name: rawName,
      canonicalName: opt.id,
      displayName: normalizeServiceName(rawName),
      peerLabel: opt.peerLabel || '',
      peerId: opt.peerId || '',
      peerIconUrl: opt.peerIconUrl ?? null,
      value: opt.value,
      provider: opt.provider,
      providerCount: opt.count,
      tags,
      gradient: getPeerGradient(opt.peerId || opt.peerLabel || opt.provider || opt.id),
      description: opt.description || generateDescription(opt.id, opt.categories, opt.peerLabel || opt.provider),
      // ChatServiceOptionEntry doesn't carry sellerContract — only the
      // DiscoverRow path (below) does. Cards built from the fallback options
      // list therefore never light up the badge, which is fine: as soon as
      // the daemon delivers DiscoverRows the proxy gets surfaced.
      knownProxy: null,
      verificationLinks: [],
      inputUsdPerMillion: opt.inputUsdPerMillion,
      outputUsdPerMillion: opt.outputUsdPerMillion,
      cachedInputUsdPerMillion: opt.cachedInputUsdPerMillion ?? null,
      reputationScore: null,
      channelCount: 0,
      volumeUsdc: 0,
      poolStakeAnts: 0,
      washFlagged: null,
      sybilRisk: null,
      sybilFlags: [],
      lifetimeRequests: 0,
      lifetimeTokens: 0,
    };
  });
}

/* ── Build cards directly from rows (carries lifetime stats) ─────────── */

function pickRequests(row: DiscoverRow): number {
  if (row.networkRequests !== null) {
    const n = Number(row.networkRequests);
    if (Number.isFinite(n)) return n;
  }
  return row.lifetimeRequests;
}

function pickTokens(row: DiscoverRow): number {
  if (row.networkInputTokens !== null || row.networkOutputTokens !== null) {
    const inp = row.networkInputTokens !== null ? Number(row.networkInputTokens) : 0;
    const out = row.networkOutputTokens !== null ? Number(row.networkOutputTokens) : 0;
    if (Number.isFinite(inp) && Number.isFinite(out)) return inp + out;
  }
  return row.lifetimeInputTokens + row.lifetimeOutputTokens;
}

function buildCardsFromRows(rows: DiscoverRow[]): CardItem[] {
  const seen = new Set<string>();
  const out: CardItem[] = [];
  for (const row of rows) {
    const key = `${row.provider}\u0001${row.serviceId}\u0001${row.peerId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const baseTags = row.categories;
    const tags = baseTags.some((t) => t.toLowerCase() === 'anon')
      ? baseTags
      : ['anon', ...baseTags];
    const rawName = displayModelLabel(row.serviceId, row.serviceLabel);
    const peerLabel = row.peerLabel || '';
    out.push({
      name: rawName,
      canonicalName: row.serviceId,
      displayName: normalizeServiceName(rawName),
      peerLabel,
      peerId: row.peerId,
      peerIconUrl: row.peerIconUrl,
      value: row.selectionValue,
      provider: row.provider,
      providerCount: 1,
      tags,
      gradient: getPeerGradient(row.peerId || peerLabel || row.provider || row.serviceId),
      description: generateDescription(row.serviceId, row.categories, peerLabel || row.provider),
      knownProxy: getKnownProxy(row.sellerContract),
      verificationLinks: row.verificationLinks,
      inputUsdPerMillion: row.inputUsdPerMillion,
      outputUsdPerMillion: row.outputUsdPerMillion,
      cachedInputUsdPerMillion: row.cachedInputUsdPerMillion,
      reputationScore: row.effectiveReputationScore ?? row.onChainReputationScore,
      channelCount: row.onChainActiveChannelCount,
      volumeUsdc: Number(row.onChainTotalVolumeUsdc) / 1_000_000,
      poolStakeAnts: row.poolStakeAnts,
      washFlagged: row.washFlagged,
      sybilRisk: row.onChainSybilRisk,
      sybilFlags: row.onChainSybilFlags,
      lifetimeRequests: pickRequests(row),
      lifetimeTokens: pickTokens(row),
    });
  }
  return out;
}

/* ── Compact number formatter (12.3k / 1.2M) ─────────────────────────── */

function formatCompact(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1).replace(/\.0$/, '')}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(Math.floor(n));
}

function formatVolumeUsdc(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  if (n >= 100) return n.toFixed(0);
  if (n >= 10) return n.toFixed(1).replace(/\.0$/, '');
  return n.toFixed(2).replace(/\.00$/, '');
}

function isLowReputation(score: number | null): boolean {
  return typeof score === 'number' && Number.isFinite(score) && score < LOW_REPUTATION_SCORE_THRESHOLD;
}

function formatReputationTooltip(item: CardItem): { avgChannelUsdc: string } {
  const avg = item.channelCount > 0 ? item.volumeUsdc / item.channelCount : 0;
  return {
    avgChannelUsdc: formatVolumeUsdc(avg),
  };
}

/* ── Search matcher ──────────────────────────────────────────────────── */

function matchesSearch(item: CardItem, query: string): boolean {
  if (!query) return true;
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (item.name.toLowerCase().includes(q)) return true;
  if (item.displayName.toLowerCase().includes(q)) return true;
  if (item.peerLabel.toLowerCase().includes(q)) return true;
  if (item.verificationLinks.some((link) => link.label.toLowerCase().includes(q))) return true;
  if (item.tags.some((t) => t.toLowerCase().includes(q))) return true;
  return false;
}

/* ── Skeleton card ───────────────────────────────────────────────────── */

const skeletonBaseColor = 'rgba(0,0,0,0.04)';
const skeletonHighlightColor = 'rgba(0,0,0,0.07)';

function SkeletonCard() {
  return (
    <div className={styles.card}>
      <div className={styles.cardBody}>
        <div className={styles.cardTags}>
          <Skeleton width={52} height={18} borderRadius={24} baseColor={skeletonBaseColor} highlightColor={skeletonHighlightColor} />
          <Skeleton width={42} height={18} borderRadius={24} baseColor={skeletonBaseColor} highlightColor={skeletonHighlightColor} />
        </div>
        <Skeleton width="65%" height={16} baseColor={skeletonBaseColor} highlightColor={skeletonHighlightColor} />
        <Skeleton width="90%" height={12} baseColor={skeletonBaseColor} highlightColor={skeletonHighlightColor} />
        <Skeleton width="55%" height={12} baseColor={skeletonBaseColor} highlightColor={skeletonHighlightColor} />
      </div>
      <div className={styles.cardFooter}>
        <Skeleton width={90} height={12} baseColor={skeletonBaseColor} highlightColor={skeletonHighlightColor} />
      </div>
    </div>
  );
}

/* ── Provider avatar ─────────────────────────────────────────────────── */

function ProviderAvatar({ name, gradient, iconUrl }: { name: string; gradient: string; iconUrl?: string | null }) {
  const [iconFailed, setIconFailed] = useState(false);
  const letter = (name || '?').charAt(0).toUpperCase();
  const showIcon = Boolean(iconUrl) && !iconFailed;
  return (
    <span
      className={`${styles.providerAvatar}${showIcon ? ` ${styles.providerAvatarIcon}` : ''}`}
      style={showIcon ? undefined : { background: gradient }}
    >
      {showIcon ? (
        <img
          className={styles.providerAvatarImage}
          src={iconUrl ?? undefined}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onError={() => setIconFailed(true)}
        />
      ) : letter}
    </span>
  );
}

function verificationTitle(link: DiscoverVerificationLink): string {
  return link.kind === 'domain'
    ? `Verified domain: ${link.label}`
    : `Verified GitHub: ${link.label}`;
}

function VerificationLinkBadge({ link }: { link: DiscoverVerificationLink }) {
  const title = verificationTitle(link);
  const hasDomainPreview = link.kind === 'domain' && (link.title || link.description);
  return (
    <InfoTooltip
      align="left"
      content={(
        <>
          <strong>{hasDomainPreview ? (link.title ?? title) : title}</strong>
          {link.kind === 'domain' && link.description && (
            <span className={styles.verificationDescription}>{link.description}</span>
          )}
          <span>{link.href}</span>
        </>
      )}
    >
      <a
        className={`${styles.verificationBadge} ${link.kind === 'domain' ? styles.verificationBadgeDomain : styles.verificationBadgeGithub}`}
        href={link.href}
        target="_blank"
        rel="noopener noreferrer"
        aria-label={title}
        title={title}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => e.stopPropagation()}
      >
        <HugeiconsIcon icon={link.kind === 'domain' ? Globe02Icon : GithubIcon} size={11} strokeWidth={1.8} />
      </a>
    </InfoTooltip>
  );
}

function VerificationBadges({ links }: { links: DiscoverVerificationLink[] }) {
  if (links.length === 0) return null;
  return (
    <span className={styles.verificationBadges} aria-label="Verified external claims">
      {links.map((link) => (
        <VerificationLinkBadge key={`${link.kind}:${link.href}`} link={link} />
      ))}
    </span>
  );
}

function CardBadges({ item }: { item: CardItem }) {
  if (!item.knownProxy && item.verificationLinks.length === 0) return null;
  return (
    <span className={styles.cardBadges}>
      {item.knownProxy && (
        <InfoTooltip
          align="left"
          content={(
            <>
              <strong>{item.knownProxy.label}</strong>
              <span>{item.knownProxy.description}</span>
            </>
          )}
        >
          <span
            className={styles.proxyBadge}
            tabIndex={0}
            role="button"
            /* The label + description live in the popover; the surface only shows
               the icon, but screen readers still get the full sentence. */
            aria-label={`${item.knownProxy.label} — ${item.knownProxy.description}`}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <HugeiconsIcon icon={ContractsIcon} size={11} strokeWidth={1.8} />
          </span>
        </InfoTooltip>
      )}
      <VerificationBadges links={item.verificationLinks} />
    </span>
  );
}

/* ── Main component ──────────────────────────────────────────────────── */

type DiscoverWelcomeProps = {
  serviceOptions: ChatServiceOptionEntry[];
  onStartChatting: (serviceValue: string, peerId?: string) => void;
};

const MIN_CARD_WIDTH_PX = 280;
const GRID_GAP_PX = 12;
const CARD_ESTIMATED_HEIGHT_PX = 208;
const DEFAULT_PAGE_SIZE = 9;

type PaginationToken = number | 'ellipsis';

function estimatePageSize(): number {
  if (typeof window === 'undefined') return DEFAULT_PAGE_SIZE;

  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let columns = 1;
  if (viewportWidth > 520) columns = 2;
  if (viewportWidth > 780) {
    const estimatedColumns = Math.floor((viewportWidth + GRID_GAP_PX) / (MIN_CARD_WIDTH_PX + GRID_GAP_PX));
    columns = Math.max(3, estimatedColumns);
  }

  const usableHeight = Math.max(360, viewportHeight - 320);
  const rows = Math.max(1, Math.floor((usableHeight + GRID_GAP_PX) / (CARD_ESTIMATED_HEIGHT_PX + GRID_GAP_PX)));
  const estimatedPageSize = Math.max(columns, columns * rows);

  if (viewportWidth > 780) {
    return Math.max(DEFAULT_PAGE_SIZE, estimatedPageSize);
  }

  return estimatedPageSize;
}

function buildPaginationTokens(page: number, totalPages: number): PaginationToken[] {
  if (totalPages <= 7) {
    return Array.from({ length: totalPages }, (_, index) => index + 1);
  }

  // All branches below produce exactly 7 tokens so the pagination
  // container keeps a stable width when navigating between pages.
  if (page <= 3) {
    return [1, 2, 3, 4, 'ellipsis', totalPages - 1, totalPages];
  }

  if (page >= totalPages - 2) {
    return [1, 2, 'ellipsis', totalPages - 3, totalPages - 2, totalPages - 1, totalPages];
  }

  return [1, 'ellipsis', page - 1, page, page + 1, 'ellipsis', totalPages];
}

export function DiscoverWelcome({ serviceOptions, onStartChatting }: DiscoverWelcomeProps) {
  const rows = useUiSelector((state) => state.vprRoutableRows);

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(() => estimatePageSize());
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerClosing, setDrawerClosing] = useState(false);

  const closeDrawer = useCallback(() => {
    setDrawerClosing(true);
    window.setTimeout(() => {
      setDrawerOpen(false);
      setDrawerClosing(false);
    }, 200);
  }, []);

  const filterState = useDiscoverFilters(rows);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const updatePageSize = () => {
      setPageSize((prev) => {
        const next = estimatePageSize();
        return prev === next ? prev : next;
      });
    };

    updatePageSize();
    window.addEventListener('resize', updatePageSize);
    return () => window.removeEventListener('resize', updatePageSize);
  }, []);

  const hasActiveFilters =
    filterState.categorySet.size > 0 ||
    filterState.peerSet.size > 0 ||
    filterState.maxInputPrice < MAX_INPUT_PRICE_SLIDER_USD ||
    filterState.maxOutputPrice < MAX_OUTPUT_PRICE_SLIDER_USD ||
    filterState.minStakeAnts > 0 ||
    filterState.minReputationScore !== DEFAULT_MIN_REPUTATION_SCORE;

  const hasNetworkData = serviceOptions.length > 0 || rows.length > 0;
  const cards = useMemo(() => {
    if (rows.length > 0) {
      return buildCardsFromRows(filterState.sortedRows);
    }
    return serviceOptions.length > 0 ? buildCards(serviceOptions) : [];
  }, [rows.length, filterState.sortedRows, serviceOptions]);

  const filtered = useMemo(
    () => cards.filter((c) => matchesSearch(c, filterState.search)),
    [cards, filterState.search],
  );

  useEffect(() => { setPage(1); }, [
    filterState.search,
    filterState.categorySet,
    filterState.peerSet,
    filterState.maxInputPrice,
    filterState.maxOutputPrice,
    filterState.minStakeAnts,
    filterState.minReputationScore,
    filterState.sortKey,
  ]);

  const totalPages = Math.max(1, Math.ceil(filtered.length / pageSize));
  const currentPage = Math.min(page, totalPages);
  const pageStart = (currentPage - 1) * pageSize;
  const paged = filtered.slice(pageStart, pageStart + pageSize);
  const rangeStart = filtered.length === 0 ? 0 : pageStart + 1;
  const rangeEnd = pageStart + paged.length;
  const statusText = `${rangeStart}-${rangeEnd} of ${filtered.length} total service${filtered.length === 1 ? '' : 's'}`;

  const handleClick = useCallback(
    (value: string, peerId: string) => {
      if (value) onStartChatting(value, peerId || undefined);
    },
    [onStartChatting],
  );

  return (
    <div className={styles.discover}>
      <div className={styles.cardsScroll}>
        <div className={styles.cardsInner}>

          <div className={styles.header}>
            <h1 className={styles.heading}>
              The open market for <span className={styles.headingAccent}>AI</span> inference. No gatekeepers.
            </h1>
            <p className={styles.subtitle}>
              Pick a service to start chatting and building. Filter by what you need.
              Everything is anonymous — no account required.
            </p>
          </div>

          <div className={styles.controlsRow}>
            <div className={styles.searchBox}>
              <svg
                className={styles.searchIcon}
                width="14" height="14" viewBox="0 0 16 16" fill="none"
                xmlns="http://www.w3.org/2000/svg"
                aria-hidden="true"
              >
                <circle cx="7" cy="7" r="5.25" stroke="currentColor" strokeWidth="1.5"/>
                <path d="M11 11L14 14" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
              </svg>
              <input
                type="text"
                className={styles.searchInput}
                value={filterState.search}
                onChange={(e) => filterState.setSearch(e.target.value)}
                placeholder="Search services, peers, categories…"
                aria-label="Search services"
              />
            </div>
            <button
              type="button"
              className={`${styles.filterTrigger}${drawerOpen && !drawerClosing ? ` ${styles.filterTriggerActive}` : ''}`}
              onClick={() => {
                if (drawerOpen && !drawerClosing) closeDrawer();
                else setDrawerOpen(true);
              }}
              aria-expanded={drawerOpen && !drawerClosing}
              aria-label={drawerOpen && !drawerClosing ? 'Close filters' : 'Open filters'}
              title="Filters"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M2.5 5.83325H5M2.5 14.1666H7.5M15 14.1666H17.5M12.5 5.83325H17.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                <path d="M5 5.83325C5 5.05659 5 4.66825 5.12667 4.36242C5.21043 4.16007 5.33325 3.97621 5.4881 3.82135C5.64296 3.6665 5.82682 3.54368 6.02917 3.45992C6.335 3.33325 6.72333 3.33325 7.5 3.33325C8.27667 3.33325 8.665 3.33325 8.97083 3.45992C9.17318 3.54368 9.35704 3.6665 9.5119 3.82135C9.66675 3.97621 9.78957 4.16007 9.87333 4.36242C10 4.66825 10 5.05659 10 5.83325C10 6.60992 10 6.99825 9.87333 7.30409C9.78957 7.50643 9.66675 7.69029 9.5119 7.84515C9.35704 8.00001 9.17318 8.12282 8.97083 8.20658C8.665 8.33325 8.27667 8.33325 7.5 8.33325C6.72333 8.33325 6.335 8.33325 6.02917 8.20658C5.82682 8.12282 5.64296 8.00001 5.4881 7.84515C5.33325 7.69029 5.21043 7.50643 5.12667 7.30409C5 6.99825 5 6.60992 5 5.83325ZM10 14.1666C10 13.3899 10 13.0016 10.1267 12.6958C10.2104 12.4934 10.3332 12.3095 10.4881 12.1547C10.643 11.9998 10.8268 11.877 11.0292 11.7933C11.335 11.6666 11.7233 11.6666 12.5 11.6666C13.2767 11.6666 13.665 11.6666 13.9708 11.7933C14.1732 11.877 14.357 11.9998 14.5119 12.1547C14.6668 12.3095 14.7896 12.4934 14.8733 12.6958C15 13.0016 15 13.3899 15 14.1666C15 14.9433 15 15.3316 14.8733 15.6374C14.7896 15.8398 14.6668 16.0236 14.5119 16.1785C14.357 16.3333 14.1732 16.4562 13.9708 16.5399C13.665 16.6666 13.2767 16.6666 12.5 16.6666C11.7233 16.6666 11.335 16.6666 11.0292 16.5399C10.8268 16.4562 10.643 16.3333 10.4881 16.1785C10.3332 16.0236 10.2104 15.8398 10.1267 15.6374C10 15.3316 10 14.9433 10 14.1666Z" stroke="currentColor" strokeWidth="1.5"/>
              </svg>
              {hasActiveFilters && <span className={styles.filterTriggerDot} aria-hidden="true" />}
            </button>
            <select
              className={styles.sortSelect}
              value={filterState.sortKey}
              onChange={(e) => filterState.setSortKey(e.target.value as DiscoverSortKey)}
              aria-label="Sort services"
            >
              {SORT_OPTIONS.map((o) => (
                <option key={o.key} value={o.key}>{o.label}</option>
              ))}
            </select>
          </div>
          {!hasNetworkData && (
            <div className={styles.loadingHint}>
              Connecting to network...
            </div>
          )}

          <div className={styles.resultsArea}>
            {!hasNetworkData ? (
              <div className={styles.cardGrid} style={{ '--discover-columns': Math.max(1, Math.ceil(Math.sqrt(pageSize))) } as CSSProperties}>
                {Array.from({ length: pageSize }, (_, i) => (
                  <SkeletonCard key={i} />
                ))}
              </div>
            ) : filtered.length > 0 ? (
              <div className={styles.cardGrid} style={{ '--discover-columns': Math.max(1, Math.ceil(Math.sqrt(pageSize))) } as CSSProperties}>
                {paged.map((item) => (
                  <Card
                    key={item.value || item.name}
                    item={item}
                    onClick={handleClick}
                  />
                ))}
              </div>
            ) : (
              <div className={styles.emptyFilter}>No services match this filter.</div>
            )}
            {hasNetworkData && filtered.length > 0 && (
              <div className={styles.paginationBar}>
                <span className={styles.statusText}>{statusText}</span>
                {totalPages > 1 && (
                  <Pagination
                    page={currentPage}
                    totalPages={totalPages}
                    onPageChange={setPage}
                  />
                )}
              </div>
            )}
          </div>

        </div>
      </div>

      {drawerOpen && (
        <aside
          className={`${styles.drawer}${drawerClosing ? ` ${styles.drawerClosing}` : ''}`}
          role="dialog"
          aria-label="Filters"
        >
          <div className={styles.drawerHeader}>
            <span className={styles.drawerTitle}>Filters</span>
            <button
              type="button"
              className={styles.drawerClose}
              onClick={closeDrawer}
              aria-label="Close filters"
            >
              ×
            </button>
          </div>
          <div className={styles.drawerBody}>
            <DiscoverFilters filters={filterState} />
          </div>
        </aside>
      )}
    </div>
  );
}

/* ── Pagination ──────────────────────────────────────────────────────── */

function Pagination({
  page,
  totalPages,
  onPageChange,
}: {
  page: number;
  totalPages: number;
  onPageChange: (p: number) => void;
}) {
  const tokens = buildPaginationTokens(page, totalPages);
  return (
    <nav className={styles.pagination} aria-label="Pagination">
      <button
        className={styles.pageBtn}
        disabled={page === 1}
        onClick={() => onPageChange(Math.max(1, page - 1))}
        aria-label="Previous page"
      >
        ‹
      </button>
      {tokens.map((token, index) => {
        if (token === 'ellipsis') {
          return (
            <span key={`ellipsis-${index}`} className={styles.pageEllipsis} aria-hidden="true">
              …
            </span>
          );
        }

        return (
          <button
            key={token}
            className={`${styles.pageBtn}${token === page ? ` ${styles.pageBtnActive}` : ''}`}
            onClick={() => onPageChange(token)}
            aria-current={token === page ? 'page' : undefined}
          >
            {token}
          </button>
        );
      })}
      <button
        className={styles.pageBtn}
        disabled={page === totalPages}
        onClick={() => onPageChange(Math.min(totalPages, page + 1))}
        aria-label="Next page"
      >
        ›
      </button>
    </nav>
  );
}

/* ── Card ─────────────────────────────────────────────────────────────── */

function Card({
  item,
  onClick,
}: {
  item: CardItem;
  onClick: (v: string, peerId: string) => void;
}) {
  const providerName = (item.peerLabel ? getPeerDisplayName(item.peerLabel) : '') || item.provider || 'Peer';
  const [copied, setCopied] = useState(false);
  const hasInput = item.inputUsdPerMillion != null;
  const hasOutput = item.outputUsdPerMillion != null;
  const hasCachedInput = item.cachedInputUsdPerMillion != null;
  const isFree = hasInput
    && hasOutput
    && item.inputUsdPerMillion === 0
    && item.outputUsdPerMillion === 0
    && (!hasCachedInput || item.cachedInputUsdPerMillion === 0);
  const lowReputation = isLowReputation(item.reputationScore);
  const reputationTooltip = formatReputationTooltip(item);
  const hiddenTags = item.tags.slice(MAX_VISIBLE_CARD_TAGS);
  const hiddenTagLabels = hiddenTags.map(formatCategoryLabel).join(', ');

  useEffect(() => {
    if (!copied) return undefined;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const serviceKey = item.canonicalName || item.name;
  const copyValue = `${item.peerId} ${serviceKey}`.trim();

  const handleCopyIdentifiers = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    if (!copyValue) return;
    navigator.clipboard.writeText(copyValue).then(() => {
      setCopied(true);
    }).catch(() => {
      // Clipboard permission can be denied; keep the card interaction unchanged.
    });
  }, [copyValue]);

  return (
    <div
      className={styles.card}
      onClick={() => onClick(item.value, item.peerId)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(item.value, item.peerId); } }}
    >
      <div className={styles.cardBody}>
        <div className={styles.cardTags}>
          {item.tags.slice(0, MAX_VISIBLE_CARD_TAGS).map((t) => (
            <span key={t} className={styles.tag} style={getTagTint(t)}>{formatCategoryLabel(t)}</span>
          ))}
          {hiddenTags.length > 0 && (
            <InfoTooltip
              align="left"
              content={(
                <>
                  <strong>More categories</strong>
                  <span>{hiddenTagLabels}</span>
                </>
              )}
            >
              <span
                className={`${styles.tag} ${styles.tagMore}`}
                tabIndex={0}
                aria-label={`${hiddenTags.length} more categories: ${hiddenTagLabels}`}
                onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => e.stopPropagation()}
              >
                +{hiddenTags.length}
              </span>
            </InfoTooltip>
          )}
        </div>
        <div className={styles.cardNameRow}>
          <div className={styles.cardName} title={serviceKey}>{item.displayName}</div>
          <button
            type="button"
            className={`${styles.copyIconButton}${copied ? ` ${styles.copyIconButtonCopied}` : ''}`}
            onClick={handleCopyIdentifiers}
            onKeyDown={(e) => e.stopPropagation()}
            aria-label={copied ? `Copied ${copyValue}` : `Copy peer ID and service key ${copyValue}`}
            title={copied ? 'Copied peer ID and service key' : `Copy peer ID and service key: ${copyValue}`}
          >
            <HugeiconsIcon icon={copied ? Tick02Icon : Copy01Icon} size={13} strokeWidth={1.7} />
          </button>
        </div>
        <div className={styles.cardDesc}>{item.description}</div>
        <div className={styles.cardPricing}>
          {isFree ? (
            <span className={styles.pricingFree}>Free</span>
          ) : (
            <>
              {(hasInput || hasCachedInput) && (
                <span className={styles.pricingInputGroup}>
                  {hasInput && <span>{formatPerMillionPrice(item.inputUsdPerMillion!)} input tokens</span>}
                  {hasCachedInput && (
                    <span className={styles.pricingCached}>
                      {formatPerMillionPrice(item.cachedInputUsdPerMillion!)} cached input
                    </span>
                  )}
                </span>
              )}
              {hasOutput && (hasInput || hasCachedInput) && <span className={styles.pricingDot} />}
              {hasOutput && <span>{formatPerMillionPrice(item.outputUsdPerMillion!)} output tokens</span>}
            </>
          )}
        </div>
      </div>

      <div className={styles.cardFooter}>
        <div className={styles.cardFooterTop}>
          <div className={styles.cardProvider}>
            <ProviderAvatar name={providerName} gradient={item.gradient} iconUrl={item.peerIconUrl} />
            <span className={styles.cardProviderName}>{providerName}</span>
            <CardBadges item={item} />
          </div>
          <div className={styles.cardFooterMetrics}>
            <InfoTooltip
              align="right"
              content={(
                <>
                  <strong>On-chain trust score</strong>
                  <span>Settled volume: {formatVolumeUsdc(item.volumeUsdc)} USDC.</span>
                  <span>{formatCompact(item.channelCount)} settled session{item.channelCount === 1 ? '' : 's'}.</span>
                  <span>Avg channel value: {reputationTooltip.avgChannelUsdc} USDC.</span>
                  <span>Pool stake: {formatCompact(item.poolStakeAnts)} ANTS.</span>
                  {item.washFlagged === true && (
                    <span>⛔ Flagged as a proven wash trader by the on-chain registry.</span>
                  )}
                  {sybilHasSignals(item) && (
                    <span>
                      ⚠ Sybil risk signals: {item.sybilFlags.map(formatSybilFlag).join(', ')}.
                    </span>
                  )}
                  <span>Trust = settled service history (up to 50) + last epoch usage share (up to 20) + this epoch power share (up to 10) + verified identity (up to 20); proven wash traders score 0.</span>
                </>
              )}
            >
              <span className={`${styles.cardScoreBadge}${lowReputation || item.washFlagged === true ? ` ${styles.cardScoreBadgeWarn}` : ''}`} tabIndex={0}>
                {formatReputationScore(item.reputationScore)}
                <span className={styles.cardScoreStar} aria-hidden="true">★</span>
                {lowReputation && <span className={styles.cardScoreLowText}>Low</span>}
              </span>
            </InfoTooltip>
          </div>
        </div>
        <div className={`${styles.cardStats}${lowReputation || sybilHasSignals(item) || item.washFlagged === true ? ` ${styles.cardStatsWarning}` : ''}`}>
          {item.washFlagged === true ? (
            /* Registry verdict outranks the local sybil heuristic: a filled
               pill (reusing the tag-warn styling) rather than plain warn text. */
            <span className={`${styles.tag} ${styles.tagWarn}`} title="Flagged as a proven wash trader by the on-chain registry">
              ⛔ Wash trader
            </span>
          ) : sybilIsAlarming(item) ? (
            <span>⚠ Suspected wash activity: {item.sybilFlags.map(formatSybilFlag).join(', ')}</span>
          ) : sybilHasSignals(item) ? (
            <span>⚠ Sybil risk signals: {item.sybilFlags.map(formatSybilFlag).join(', ')}</span>
          ) : lowReputation ? (
            <span>Low reputation: limited on-chain history</span>
          ) : (
            <>
              <span className={styles.cardStatsValues}>
                {item.providerCount > 1 && (
                  <span>{item.providerCount} providers</span>
                )}
                {item.providerCount > 1 && <span className={styles.statsDot} />}
                <span>{formatCompact(item.channelCount)} session{item.channelCount === 1 ? '' : 's'}</span>
                <span className={styles.statsDot} />
                <span>{formatVolumeUsdc(item.volumeUsdc)} USDC volume</span>
                <span className={styles.statsDot} />
                <span>{formatCompact(item.lifetimeTokens)} token{item.lifetimeTokens === 1 ? '' : 's'}</span>
              </span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
