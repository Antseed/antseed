import { useState, useRef, useEffect, useMemo } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowDown01Icon, ArrowRight01Icon, StarIcon } from '@hugeicons/core-free-icons';
import type { VprModelCatalogEntry } from '../../../core/state';
import { formatPerMillionPrice } from '../../../core/peer-utils';
import { displayModelLabel, sameCanonicalModel } from '../../../modules/catalog/model-identity';
import { findCatalogEntry } from '../../../modules/catalog/model-catalog';
import { modelCapabilitySummary } from '../../../modules/catalog/model-capabilities';
import { loadFavoriteModels } from '../../../modules/catalog/favorites';
import {
  catalogEntryKey,
  selectFavoriteVprCatalog,
  selectRecommendedVprCatalog,
} from '../../../modules/catalog/recommended';
import { BrandIcon } from '../brand/BrandIcon';
import styles from './VprModelDropdown.module.scss';

/* The menu shows the curated recommended lineup (frontier + free models);
   the full list lives on the Models page via the footer link. */
const TOP_MODEL_COUNT = 12;

type VprModelDropdownProps = {
  catalog: VprModelCatalogEntry[];
  kind: VprModelCatalogEntry['kind'];
  selectedProvider: string;
  selectedServiceId: string;
  /** Trigger label when the selection has no catalog entry (loading, none). */
  fallbackLabel: string;
  disabled: boolean;
  onSelect: (entry: VprModelCatalogEntry) => void;
  onBrowseAll: () => void;
};

export function filterVprModelDropdownCatalog(
  catalog: VprModelCatalogEntry[],
  kind: VprModelCatalogEntry['kind'],
): VprModelCatalogEntry[] {
  return catalog.filter((entry) => entry.kind === kind);
}

function isSelected(entry: VprModelCatalogEntry, provider: string, serviceId: string): boolean {
  // Entries aggregate serviceId variants — a selection referencing any
  // variant marks the aggregated entry as active.
  return (entry.provider === provider && entry.serviceId === serviceId)
    || sameCanonicalModel(entry.serviceId, serviceId);
}

function priceLabel(entry: VprModelCatalogEntry): string | null {
  if (entry.kind === 'image') return 'Per image';
  if (entry.minInputUsdPerMillion === null) return null;
  if (entry.minInputUsdPerMillion <= 0) return 'Free';
  return `${formatPerMillionPrice(entry.minInputUsdPerMillion)} in`;
}

export function VprModelDropdown({
  catalog,
  kind,
  selectedProvider,
  selectedServiceId,
  fallbackLabel,
  disabled,
  onSelect,
  onBrowseAll,
}: VprModelDropdownProps) {
  const [open, setOpen] = useState(false);
  const [favorites, setFavorites] = useState(loadFavoriteModels);
  const ref = useRef<HTMLDivElement>(null);

  // Favorites are starred on the model pages (localStorage); re-read on each
  // open so stars toggled elsewhere show up without a remount.
  useEffect(() => {
    if (open) setFavorites(loadFavoriteModels());
  }, [open]);

  const selectedEntry = useMemo(
    () => (selectedServiceId ? findCatalogEntry(catalog, selectedProvider, selectedServiceId) : null),
    [catalog, selectedProvider, selectedServiceId],
  );

  const modeCatalog = useMemo(
    () => filterVprModelDropdownCatalog(catalog, kind),
    [catalog, kind],
  );

  const favoriteEntries = useMemo(
    () => selectFavoriteVprCatalog(modeCatalog, favorites),
    [favorites, modeCatalog],
  );

  // Curated recommended lineup (minus favorites, which get their own group),
  // with the current selection always present so the active model never
  // disappears from its own switcher.
  const recommendedEntries = useMemo(() => {
    const top = (kind === 'image' ? modeCatalog : selectRecommendedVprCatalog(modeCatalog))
      .filter((entry) => !favorites.has(catalogEntryKey(entry)))
      .slice(0, kind === 'image' ? modeCatalog.length : TOP_MODEL_COUNT);
    if (selectedEntry?.kind === kind && !top.includes(selectedEntry) && !favoriteEntries.includes(selectedEntry)) {
      return [selectedEntry, ...top.slice(0, TOP_MODEL_COUNT - 1)];
    }
    return top;
  }, [favorites, favoriteEntries, kind, modeCatalog, selectedEntry]);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // Prettify the fallback in case it is a raw service key (e.g. the bound
  // conversation's serviceId while the catalog is still loading).
  const triggerLabel = selectedEntry?.label || displayModelLabel(selectedServiceId, fallbackLabel);

  function renderEntry(entry: VprModelCatalogEntry) {
    const active = isSelected(entry, selectedProvider, selectedServiceId);
    const price = priceLabel(entry);
    const capabilitySummary = modelCapabilitySummary(entry);
    return (
      <button
        key={`${entry.provider}${entry.serviceId}`}
        type="button"
        className={`${styles.modelDropdownItem}${active ? ` ${styles.active}` : ''}`}
        role="option"
        aria-selected={active}
        onClick={() => {
          setOpen(false);
          if (!active) onSelect(entry);
        }}
      >
        <span className={styles.itemTopRow}>
          <span className={styles.itemNameGroup}>
            <BrandIcon name={entry.provider} hints={[entry.label]} size={16} />
            <span className={styles.itemName}>{entry.label}</span>
            {entry.kind === 'image' && <span className={styles.imageBadge}>Image</span>}
          </span>
          {price && <span className={styles.itemPricing}>{price}</span>}
        </span>
        <span className={styles.itemMeta}>
          <span>{capabilitySummary[0] ?? `${entry.peerCount} ${entry.peerCount === 1 ? 'seller' : 'sellers'}`}</span>
          {capabilitySummary.length > 0 && (
            <span>{entry.peerCount} {entry.peerCount === 1 ? 'seller' : 'sellers'}</span>
          )}
          {entry.expectedSavingsPct !== null && entry.expectedSavingsPct > 0 && (
            <span className={styles.itemSavings}>save up to {entry.expectedSavingsPct}%</span>
          )}
        </span>
      </button>
    );
  }

  return (
    <div className={styles.modelDropdown} ref={ref}>
      <button
        type="button"
        className={styles.modelDropdownTrigger}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        {selectedEntry && (
          <BrandIcon name={selectedEntry.provider} hints={[selectedEntry.label]} size={16} />
        )}
        <span className={styles.modelDropdownLabel}>{triggerLabel}</span>
        <HugeiconsIcon icon={ArrowDown01Icon} size={16} strokeWidth={1.5} />
      </button>
      {open && (
        <div className={styles.modelDropdownMenu} role="listbox">
          {favoriteEntries.length > 0 && (
            <>
              <div className={styles.modelDropdownSection}>
                <HugeiconsIcon icon={StarIcon} size={12} strokeWidth={2} className={styles.sectionStar} />
                Favorites
              </div>
              {favoriteEntries.map(renderEntry)}
              <div className={styles.modelDropdownSection}>{kind === 'image' ? 'Image models' : 'Recommended'}</div>
            </>
          )}
          {recommendedEntries.map(renderEntry)}
          {kind === 'text' && (
            <button
              type="button"
              className={styles.modelDropdownFooter}
              onClick={() => {
                setOpen(false);
                onBrowseAll();
              }}
            >
              <span>All models</span>
              <HugeiconsIcon icon={ArrowRight01Icon} size={13} strokeWidth={1.8} />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
