import type { JSX } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import { ArrowRight01Icon, Settings02Icon, StarIcon, Tick02Icon } from '@hugeicons/core-free-icons';
import type { VprModelCatalogEntry } from '../../../core/state';
import { favoriteModelKey } from '../../../modules/catalog/favorites';
import { sameCanonicalModel } from '../../../modules/catalog/model-identity';
import { modelCapabilitySummary } from '../../../modules/catalog/model-capabilities';
import { modelTagsFor } from '../../../modules/catalog/model-metadata';
import { BrandIcon } from '../brand/BrandIcon';
import { InfoTooltip } from '../InfoTooltip';
import { formatUsdShort, VprBadge } from './VprKit';
import styles from './VprModelRows.module.scss';

export type VprModelRowListProps = {
  entries: VprModelCatalogEntry[];
  selectedProvider?: string;
  selectedServiceId?: string;
  onSelect: (provider: string, serviceId: string) => void;
  emptyLabel: string;
  limit?: number;
  /** `provider:serviceId` keys of user-starred models — matching rows get a
   * star so favorites read apart from the recommended lineup. */
  favoriteKeys?: ReadonlySet<string>;
  /** The first N rows are the lead recommendations: they render inside a thin
   * framed group whose border is cut by a small label, so the lead picks read
   * apart from the rest of the list without becoming a separate section. */
  recommendedCount?: number;
  /** Label cutting the frame's border. Defaults to "Recommended"; hosts whose
   * lead picks are the user's starred models pass "Favorites". */
  recommendedLabel?: string;
  /** Drop the card chrome (bg/radius/shadow) — for hosts that provide their
   * own panel, e.g. the Home model dropdown. */
  frameless?: boolean;
  /** Narrow-host layout (the floating pill): the price joins the meta line
   * under the name and the trailing chevron is dropped, so the model name
   * keeps the full row width instead of truncating after a few characters. */
  compact?: boolean;
  /** Tighter rows with the full content kept — menus that must fit on screen
   * (the Home composer's model menu). */
  dense?: boolean;
  /** Rows only pick a model instead of drilling into its page (the Home
   * dropdown, the chat model pickers) — the trailing chevron is dropped so
   * the row doesn't promise a navigation that never happens. */
  selectOnly?: boolean;
  /** Seller names for models pinned to one peer, keyed `provider:serviceId`.
   * A matching row swaps its peer count for the seller, so a non-auto route is
   * visible without opening the model page. */
  pinnedPeerLabels?: ReadonlyMap<string, string>;
  /** Rows get a trailing config button opening per-context settings for that
   * model (the chat detail's seller picker). Hosts without one (Home
   * dropdown, floating pill) omit this and render no button. */
  onConfigure?: (provider: string, serviceId: string) => void;
};

function entryMinTotalPrice(entry: VprModelCatalogEntry): number | null {
  if (entry.kind === 'image') return entry.minImageUsdPerImage;
  if (entry.minInputUsdPerMillion === null || entry.minOutputUsdPerMillion === null) return null;
  return entry.minInputUsdPerMillion + entry.minOutputUsdPerMillion;
}

function isFreeEntry(entry: VprModelCatalogEntry): boolean {
  if (entry.kind === 'image') return false;
  const { minInputUsdPerMillion: input, minOutputUsdPerMillion: output } = entry;
  return input !== null && output !== null && input <= 0 && output <= 0;
}

function discountLabel(entry: VprModelCatalogEntry): string | null {
  return entry.expectedSavingsPct !== null && entry.expectedSavingsPct > 0
    ? `${entry.expectedSavingsPct}% off`
    : null;
}

function formatPrice(price: number | null): string {
  return price === null ? '—' : formatUsdShort(price);
}

function ModelRow({ entry, checked, favorite, badge, compact, dense, chevron = true, pinnedPeerLabel, onClick, onConfigure }: {
  entry: VprModelCatalogEntry;
  /** Leading checkmark for the currently selected model (Figma "model list" checked state). */
  checked?: boolean;
  favorite?: boolean;
  badge?: JSX.Element | null;
  compact?: boolean;
  dense?: boolean;
  /** Trailing right chevron — only for rows that open the model page. */
  chevron?: boolean;
  /** Seller this model is pinned to; replaces the peer count on the meta line. */
  pinnedPeerLabel?: string | null;
  onClick: () => void;
  /** Trailing config button (per-context model settings). */
  onConfigure?: () => void;
}): JSX.Element {
  const free = isFreeEntry(entry);
  const hasPrice = entry.minInputUsdPerMillion !== null || entry.minOutputUsdPerMillion !== null;
  // Config-bearing rows (the chat detail's model list) trade the discount
  // column for meta-line width: the gear moves up onto the title line and
  // the second line runs the full row.
  const discount = onConfigure ? null : discountLabel(entry);
  const capabilities = modelCapabilitySummary(entry);
  const modelTags = modelTagsFor(entry.serviceId);
  const visibleModelTags = modelTags.slice(0, 1);
  const hiddenModelTags = modelTags.slice(visibleModelTags.length);

  const priceParts = entry.kind === 'image' ? (
    entry.minImageUsdPerImage !== null ? (
      <>
        <span className={styles.priceLine}>
          <span className={styles.pricePrefix}>From:</span>
          <span>{formatPrice(entry.minImageUsdPerImage)}</span>
        </span>
        <span className={styles.perTok}>/image</span>
      </>
    ) : (
      <span className={styles.perTok}>Price unknown</span>
    )
  ) : free ? (
    <span className={styles.perTok}>Free</span>
  ) : hasPrice ? (
    <>
      <span className={styles.priceLine}>
        <span className={styles.pricePrefix}>From:</span>
        <span><span className={styles.priceLabel}>In</span> {formatPrice(entry.minInputUsdPerMillion)}</span>
        <span><span className={styles.priceLabel}>Out</span> {formatPrice(entry.minOutputUsdPerMillion)}</span>
      </span>
      <span className={styles.perTok}>/m tok</span>
    </>
  ) : (
    <span className={styles.perTok}>Price unknown</span>
  );

  return (
    <button
      type="button"
      className={[
        styles.row,
        compact ? styles.rowCompact : '',
        dense ? styles.rowDense : '',
      ].filter(Boolean).join(' ')}
      aria-pressed={checked}
      onClick={onClick}
    >
      {checked && (
        <span className={styles.checkSlot} aria-hidden="true">
          <HugeiconsIcon icon={Tick02Icon} size={16} strokeWidth={2} className={styles.check} />
        </span>
      )}
      <span className={styles.rowMain}>
        <span className={styles.titleLine}>
          <BrandIcon name={entry.provider} hints={[entry.label]} size={16} className={styles.logo} />
          <span className={styles.label}>{entry.label}</span>
          {entry.kind === 'image' && <span className={styles.modelTypeTag}>Image</span>}
          {!compact && visibleModelTags.map((tag) => (
            <span
              key={tag}
              className={`${styles.modelTag}${tag === 'Uncensored' ? ` ${styles.modelTagUncensored}` : ''}`}
            >
              {tag}
            </span>
          ))}
          {!compact && hiddenModelTags.length > 0 && (
            <InfoTooltip
              align="left"
              narrow
              interactive
              content={<span>{hiddenModelTags.join(' · ')}</span>}
            >
              <span
                className={styles.modelTagMore}
                role="button"
                tabIndex={0}
                onClick={(event) => event.stopPropagation()}
              >
                +{hiddenModelTags.length}
              </span>
            </InfoTooltip>
          )}
          {favorite && (
            <HugeiconsIcon icon={StarIcon} size={13} strokeWidth={2} className={styles.favStar} />
          )}
          {badge}
          {discount && <span className={styles.discount}>{discount}</span>}
          {/* A span with the button role — the row itself is already a
              button, and a real nested button would be invalid markup (same
              pattern as the pill's Add balance shortcut). */}
          {onConfigure && (
            <span
              role="button"
              tabIndex={0}
              className={styles.configButton}
              title="Model settings for this chat"
              aria-label={`Settings for ${entry.label}`}
              onClick={(event) => {
                event.stopPropagation();
                onConfigure();
              }}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' && event.key !== ' ') return;
                event.stopPropagation();
                event.preventDefault();
                onConfigure();
              }}
            >
              <HugeiconsIcon icon={Settings02Icon} size={15} strokeWidth={1.8} />
            </span>
          )}
        </span>
        <span className={styles.metaLine}>
          {/* A pinned seller is the whole story of where the model routes —
              the seller's name replaces the peer count, unlabelled: naming a
              peer already says routing isn't on auto. */}
          {!compact && capabilities.length > 0 && (
            <>
              <span className={styles.capabilityMeta}>{capabilities.slice(0, 2).join(' · ')}</span>
              <span className={styles.metaDivider} aria-hidden="true">•</span>
            </>
          )}
          {pinnedPeerLabel || !compact ? (
            <>
              <span className={styles.peerMeta}>
                {pinnedPeerLabel ? (
                  <span className={styles.pinnedSeller}>{pinnedPeerLabel}</span>
                ) : (
                  `${entry.peerCount} ${entry.peerCount === 1 ? 'seller' : 'sellers'}`
                )}
              </span>
              <span className={styles.metaDivider} aria-hidden="true">•</span>
            </>
          ) : null}
          <span className={styles.metaPrice}>{priceParts}</span>
        </span>
      </span>
      {!compact && chevron && (
        <HugeiconsIcon icon={ArrowRight01Icon} size={16} strokeWidth={2} className={styles.chevron} />
      )}
    </button>
  );
}

export function VprModelRowList({
  entries,
  selectedProvider,
  selectedServiceId,
  onSelect,
  emptyLabel,
  limit,
  favoriteKeys,
  recommendedCount,
  recommendedLabel,
  frameless,
  dense,
  compact,
  selectOnly,
  pinnedPeerLabels,
  onConfigure,
}: VprModelRowListProps): JSX.Element {
  if (entries.length === 0) {
    return (
      <div className={styles.empty} role="status">
        {emptyLabel}
      </div>
    );
  }

  const visibleEntries = typeof limit === 'number' ? entries.slice(0, Math.max(0, limit)) : entries;

  // The single cheapest priced entry in the visible list gets the badge.
  let cheapestKey: string | null = null;
  if (visibleEntries.length > 1) {
    let cheapestPrice = Infinity;
    for (const entry of visibleEntries) {
      const price = entryMinTotalPrice(entry);
      if (price !== null && price < cheapestPrice) {
        cheapestPrice = price;
        cheapestKey = `${entry.provider}:${entry.serviceId}`;
      }
    }
  }

  const renderRow = (entry: VprModelCatalogEntry): JSX.Element => {
    const key = `${entry.provider}:${entry.serviceId}`;
    const selected = Boolean(selectedServiceId) && (
      (entry.provider === selectedProvider && entry.serviceId === selectedServiceId)
      || sameCanonicalModel(entry.serviceId, selectedServiceId ?? '')
    );
    const free = isFreeEntry(entry);
    // Pins are per model, so any row can name a seller — not just the
    // selected one.
    const pinned = pinnedPeerLabels?.get(key) ?? null;

    return (
      <ModelRow
        key={key}
        entry={entry}
        checked={selected}
        compact={compact}
        dense={dense}
        chevron={!selectOnly}
        pinnedPeerLabel={pinned}
        favorite={favoriteKeys?.has(favoriteModelKey(entry.provider, entry.serviceId))}
        badge={free ? (
          <VprBadge tone="green">Free</VprBadge>
        ) : key === cheapestKey ? (
          <VprBadge tone="green">Cheapest</VprBadge>
        ) : null}
        onClick={() => onSelect(entry.provider, entry.serviceId)}
        onConfigure={onConfigure ? () => onConfigure(entry.provider, entry.serviceId) : undefined}
      />
    );
  };

  const framedEntries = visibleEntries.slice(0, Math.max(0, recommendedCount ?? 0));
  const plainEntries = visibleEntries.slice(framedEntries.length);

  return (
    <div className={frameless ? styles.listBare : styles.list}>
      {framedEntries.length > 0 && (
        <div className={styles.recommendedFrame}>
          <span className={styles.recommendedLegend}>{recommendedLabel ?? 'Recommended'}</span>
          {framedEntries.map(renderRow)}
        </div>
      )}
      {plainEntries.map(renderRow)}
    </div>
  );
}
