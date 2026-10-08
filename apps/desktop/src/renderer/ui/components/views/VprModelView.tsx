import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { HugeiconsIcon } from '@hugeicons/react';
import {
  ContractsIcon,
  Copy01Icon,
  GithubIcon,
  Globe02Icon,
  PreferenceHorizontalIcon,
  StarIcon,
  Tick02Icon,
} from '@hugeicons/core-free-icons';
import { chooseBestVprRoute } from '../../../modules/routing/select';
import { compareModelRoutesByReputation, routesForSelectedModel } from '../../../modules/catalog/view-models';
import { findCatalogEntry } from '../../../modules/catalog/model-catalog';
import { peerCapabilitySummary, supportsServiceParameter } from '../../../modules/catalog/model-capabilities';
import { modelTagsFor } from '../../../modules/catalog/model-metadata';
import { buildImageModelSkillPrompt } from '../../../modules/chat/image-model-instructions';
import { favoriteModelKey, loadFavoriteModels, toggleFavoriteModel } from '../../../modules/catalog/favorites';
import { vprModelPageTarget } from '../../../modules/catalog/model-page-target';
import { modelPinKey, vprModelPinFor } from '../../../modules/routing/model-pins';
import { isFreeRoute, sellerMetaLabel, sellerReputationLabel } from '../../../modules/catalog/seller-format';
import { getKnownProxy } from '../../../core/known-proxies';
import type { DiscoverRow, DiscoverVerificationLink } from '../../../core/state';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import type { ViewName } from '../../types';
import { BrandIcon } from '../brand/BrandIcon';
import { InfoTooltip } from '../InfoTooltip';
import { formatUsdShort, VprBadge, VprCard, VprPage, VprSettingRow, VprStatRow, VprStatTile, VprToggle } from '../vpr/VprKit';
import styles from './VprModelView.module.scss';
import { advertisesTeeSupport } from '@antseed/node/verifier-capabilities';
import { filterTeeBrowseRows, projectTeeBrowseCatalog, teeBrowseCache } from '../../../modules/catalog/tee-browse';
import { useRetainedState } from '../../hooks/useRetainedState';
import { VprTeeFilter, VprTeeNotice } from '../vpr/VprTeeAvailability';
import { VprTeeStatus } from '../vpr/VprTeeStatus';
import { useTeeVerification, useTeeVisibleSellers } from '../../hooks/useTeeVerification';

type Props = { onSelectView?: (view: ViewName) => void };

function priceRange(min: number | null, max: number | null): string {
  if (min === null) return '-';
  if (min <= 0 && (max === null || max <= 0)) return 'Free';
  if (max !== null && max !== min) return `${formatUsdShort(min)}-${formatUsdShort(max)}`;
  return formatUsdShort(min);
}

function priceTile(entry: { minInputUsdPerMillion: number | null; maxInputUsdPerMillion: number | null }): string {
  const min = entry.minInputUsdPerMillion;
  const max = entry.maxInputUsdPerMillion;
  return priceRange(min, max);
}

export function VprModelView({ onSelectView }: Props) {
  const actions = useActions();
  const tee = useTeeVerification();
  const snap = useUiSelector((state) => ({
    catalog: state.vprModelCatalog,
    discoverRows: state.vprRoutableRows,
    selection: state.vprRouteSelection,
    preferences: state.vprRoutingPreferences,
    pins: state.vprModelPins,
    discoverRowsLoaded: state.chatDiscoverRowsLoaded,
    proxyPort: state.chatProxyPort,
  }), shallowEqual);
  const [favorites, setFavorites] = useState(loadFavoriteModels);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'error'>('idle');
  const [teeFilter, setTeeFilter] = useRetainedState(teeBrowseCache, 'filter');
  // The page shows the model the user drilled into, which may not be the
  // applied route — browsing must not change routing until "Use" is pressed.
  const selectionModel = snap.selection.model;
  const model = useMemo(() => vprModelPageTarget()
    ?? (selectionModel ? { provider: selectionModel.provider, serviceId: selectionModel.serviceId } : null),
  [selectionModel]);
  const applied = Boolean(model && selectionModel
    && modelPinKey(selectionModel.provider, selectionModel.serviceId) === modelPinKey(model.provider, model.serviceId));
  const entry = model ? findCatalogEntry(snap.catalog, model.provider, model.serviceId) : null;
  const routes = useMemo(() => {
    const list = routesForSelectedModel(snap.discoverRows, model);
    return [...list].sort(compareModelRoutesByReputation);
  }, [model, snap.discoverRows]);
  const bestRoute = useMemo(() => chooseBestVprRoute(routes, snap.preferences), [routes, snap.preferences]);
  const displayedRoutes = useMemo(() => filterTeeBrowseRows(routes, teeFilter), [routes, teeFilter]);
  useTeeVisibleSellers(displayedRoutes);
  const displayCatalog = useMemo(() => projectTeeBrowseCatalog(
    snap.catalog, snap.discoverRows, snap.preferences, teeFilter,
  ), [snap.catalog, snap.discoverRows, snap.preferences, teeFilter]);
  const displayEntry = model ? findCatalogEntry(displayCatalog, model.provider, model.serviceId) : null;

  // An unapplied model previews its remembered pin (if that seller still
  // serves it); the applied model reflects the live selection.
  const pinnedPeerId = useMemo(() => {
    if (applied) return snap.selection.mode === 'pinned-peer' ? snap.selection.peerId : null;
    if (!model) return null;
    const pin = vprModelPinFor(snap.pins, model.provider, model.serviceId);
    return pin && routes.some((route) => route.peerId === pin) ? pin : null;
  }, [applied, model, routes, snap.pins, snap.selection]);

  const autoSelect = pinnedPeerId === null;
  // The active route (auto-chosen or pinned) leads the list with a checkmark.
  const activePeerId = autoSelect ? bestRoute?.peerId : pinnedPeerId;
  const selectedRoute = routes.find((route) => route.peerId === activePeerId) ?? bestRoute;

  if (!model || !entry) {
    return (
      <section className={`view view-vpr-model ${styles.view}`} role="tabpanel">
        <div className={styles.empty}>
          {model && !snap.discoverRowsLoaded ? (
            <div role="status" aria-label="Loading models">Loading models…</div>
          ) : <button type="button" onClick={() => onSelectView?.('explore')}>Choose a model</button>}
        </div>
      </section>
    );
  }

  const favorite = favorites.has(favoriteModelKey(model.provider, model.serviceId));
  const imageOnly = entry.kind === 'image';
  const priceValue = !displayEntry ? '-' : imageOnly
    ? priceRange(displayEntry.minImageUsdPerImage, displayEntry.maxImageUsdPerImage)
    : priceTile(displayEntry);
  const modelTags = modelTagsFor(entry.serviceId);
  const displayedModelTags = imageOnly ? ['Image generation', ...modelTags] : modelTags;

  const viewedModel = model;
  /** Make the browsed text model (and its previewed pin) the active route. */
  function applyModel(): void {
    actions.selectVprModel(viewedModel.provider, viewedModel.serviceId, pinnedPeerId);
  }

  async function copyImageInstructions(): Promise<void> {
    if (!imageOnly || !entry) return;
    try {
      await navigator.clipboard.writeText(buildImageModelSkillPrompt(entry, snap.proxyPort));
      setCopyState('copied');
      window.setTimeout(() => setCopyState('idle'), 2_000);
    } catch {
      setCopyState('error');
      window.setTimeout(() => setCopyState('idle'), 2_000);
    }
  }

  function useImageInChat(): void {
    if (!selectedRoute) return;
    const peerId = autoSelect ? null : selectedRoute.peerId;
    actions.startNewChat();
    actions.selectVprModel(viewedModel.provider, viewedModel.serviceId, peerId);
    onSelectView?.('chat');
  }

  return (
    <section className={`view view-vpr-model view-pinned-header ${styles.view}`} role="tabpanel">
      <VprPage title="Models" backFallback="explore">
      <div className={styles.stack}>

        <div className={styles.headRow}>
          <div className={styles.headText}>
            <div className={styles.titleLine}>
              <BrandIcon name={model.provider} hints={[entry.label]} size={20} />
              <h2 className={styles.title}>{entry.label}</h2>
              {applied && (
                <span className={styles.titleCheck} title="Currently selected model">
                  <HugeiconsIcon icon={Tick02Icon} size={18} strokeWidth={2} />
                </span>
              )}
            </div>
            {displayedModelTags.length > 0 && (
              <ModelTagBadges tags={displayedModelTags} />
            )}
          </div>
          <div className={styles.headActions}>
            <div className={styles.headActionsRow}>
              <button
                type="button"
                className={`${styles.star}${favorite ? ` ${styles.starActive}` : ''}`}
                aria-pressed={favorite}
                title={favorite ? 'Remove from favorites' : 'Add to favorites'}
                onClick={() => setFavorites(new Set(toggleFavoriteModel(model.provider, model.serviceId)))}
              >
                <HugeiconsIcon icon={StarIcon} size={20} strokeWidth={1.8} />
              </button>
              <button
                type="button"
                className={styles.use}
                disabled={imageOnly && !selectedRoute}
                onClick={() => {
                  if (imageOnly) {
                    useImageInChat();
                    return;
                  }
                  applyModel();
                  onSelectView?.('home');
                }}
              >
                {imageOnly ? 'Use in chat' : 'Use'}
              </button>
            </div>
            {imageOnly ? (
              <button
                type="button"
                className={styles.startChat}
                onClick={() => { void copyImageInstructions(); }}
              >
                <HugeiconsIcon icon={Copy01Icon} size={13} strokeWidth={1.8} />
                {copyState === 'copied' ? 'Copied instructions' : copyState === 'error' ? 'Copy failed' : 'Copy instructions'}
              </button>
            ) : (
              <button
                type="button"
                className={styles.startChat}
                onClick={() => {
                  // New chat first: applying the model while a conversation is
                  // open would rebind that conversation instead of a fresh one.
                  actions.startNewChat();
                  applyModel();
                  onSelectView?.('chat');
                }}
              >
                Start chat
              </button>
            )}
          </div>
        </div>

        <VprTeeFilter value={teeFilter} onChange={setTeeFilter} />
        {teeFilter === 'tee' && (
          <VprTeeNotice
            selectedSellerHidden={Boolean(activePeerId && !displayedRoutes.some((route) => route.peerId === activePeerId))}
            onClear={() => setTeeFilter('all')}
          />
        )}
        <VprStatRow>
          <VprStatTile
            label={imageOnly
              ? 'Price · /image'
              : priceValue === 'Free' || priceValue === '-' ? 'Price' : 'Price · /m tok'}
            value={priceValue}
            tone={priceValue === '-' ? undefined : 'success'}
            outlined
          />
          <VprStatTile
            label="Saving"
            value={displayEntry?.expectedSavingsPct != null ? `${displayEntry.expectedSavingsPct}%` : '-'}
            tone={displayEntry?.expectedSavingsPct != null ? 'success' : undefined}
            strong
            outlined
          />
          <VprStatTile label={teeFilter === 'tee' ? 'TEE sellers' : 'Sellers'} value={displayEntry?.peerCount ?? 0} outlined />
        </VprStatRow>

        <div className={styles.autoRow}>
          <VprSettingRow
            title="Auto select seller"
            hint="Price + Trust preference"
            control={(
              <div className={styles.autoControls}>
                <VprToggle
                  checked={autoSelect}
                  onChange={(next) => {
                    // Only the applied model touches the live route; browsing
                    // stages the choice in the per-model pin memory.
                    if (next) {
                      if (applied) actions.clearVprPinnedPeer();
                      else actions.setVprModelSellerPin(model.provider, model.serviceId, null);
                    } else {
                      const peerId = bestRoute?.peerId ?? entry.bestPeerId ?? null;
                      if (applied) actions.selectVprModel(model.provider, model.serviceId, peerId ?? undefined);
                      else if (peerId) actions.setVprModelSellerPin(model.provider, model.serviceId, peerId);
                    }
                  }}
                  ariaLabel="Auto select seller"
                />
                <button
                  type="button"
                  className={styles.prefsLink}
                  title="Routing preferences"
                  onClick={() => onSelectView?.('preferences')}
                >
                  <HugeiconsIcon icon={PreferenceHorizontalIcon} size={24} strokeWidth={1.8} />
                </button>
              </div>
            )}
          />
        </div>

        <div className={styles.divider} aria-hidden="true" />

        <div className={styles.sellerSection}>
          <div className={styles.sellerHead}>
            <span className={styles.sellerHeadTitle}>Sellers</span>
            <span className={styles.sellerHeadAside}>Reputation</span>
          </div>
          {displayedRoutes.length === 0 ? (
            <div className={styles.empty} role="status">
              {!snap.discoverRowsLoaded ? 'Loading sellers…' : teeFilter === 'tee' ? (
                <>
                  <span>No sellers advertising TEE support match these filters.</span>
                  <button type="button" onClick={() => setTeeFilter('all')}>Show all sellers</button>
                </>
              ) : 'No sellers available for this model'}
            </div>
          ) : (
            <VprCard className={styles.sellerCard}>
              {displayedRoutes.map((route) => {
                const active = route.peerId === activePeerId;
                return (
                  <SellerRow
                    key={route.rowKey}
                    route={route}
                    active={active}
                    auto={autoSelect}
                    tee={tee}
                    onClick={() => {
                      // Clicking the pinned seller unpins it; anyone else pins
                      // them. Only the applied model touches the live route.
                      if (active && !autoSelect) {
                        if (applied) actions.clearVprPinnedPeer();
                        else actions.setVprModelSellerPin(model.provider, model.serviceId, null);
                      } else if (applied) {
                        actions.selectVprModel(model.provider, model.serviceId, route.peerId);
                      } else {
                        actions.setVprModelSellerPin(model.provider, model.serviceId, route.peerId);
                      }
                    }}
                  />
                );
              })}
            </VprCard>
          )}
        </div>
      </div>
      </VprPage>
    </section>
  );
}

/* Gap between badges — must match .badgeRow's gap in the stylesheet. */
const BADGE_GAP = 2;

/**
 * Curated model tags on a single line, always. The row measures itself before
 * paint and shows only as many tags as actually fit, collapsing the rest into
 * a "+N" chip whose title lists them — no wrapping, no clipped chips.
 */
function ModelTagBadges({ tags }: { tags: string[] }) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  // null = measuring pass: render every tag (plus a worst-case "+N" chip) so
  // their widths can be read; the fitted count replaces it before paint.
  const [visibleCount, setVisibleCount] = useState<number | null>(null);
  const tagSignature = tags.join('\0');

  useLayoutEffect(() => {
    setVisibleCount(null);
  }, [tagSignature]);

  // Refit when the row's width changes (window resize, layout shifts).
  useLayoutEffect(() => {
    const row = rowRef.current;
    if (!row) return undefined;
    const observer = new ResizeObserver(() => setVisibleCount(null));
    observer.observe(row);
    return () => observer.disconnect();
  }, []);

  useLayoutEffect(() => {
    if (visibleCount !== null) return;
    const row = rowRef.current;
    if (!row) return;
    const children = Array.from(row.children) as HTMLElement[];
    if (children.length < 2) return;
    const chip = children[children.length - 1];
    const badges = children.slice(0, -1);
    const fitted = (budget: number): number => {
      let width = 0;
      let count = 0;
      for (const badge of badges) {
        width += (count > 0 ? BADGE_GAP : 0) + badge.offsetWidth;
        if (width > budget) break;
        count += 1;
      }
      return count;
    };
    const max = row.clientWidth;
    setVisibleCount(fitted(max) === badges.length
      ? badges.length
      : fitted(max - BADGE_GAP - chip.offsetWidth));
  }, [visibleCount]);

  const visible = visibleCount ?? tags.length;
  const hiddenTags = tags.slice(visible);

  return (
    <div className={styles.badgeRow} ref={rowRef}>
      {tags.slice(0, visible).map((tag) => (
        <span
          key={tag}
          className={`${styles.modelTag}${tag === 'Uncensored' ? ` ${styles.modelTagUncensored}` : ''}`}
        >
          {tag}
        </span>
      ))}
      {(visibleCount === null || hiddenTags.length > 0) && (
        <InfoTooltip
          align="left"
          narrow
          interactive
          content={<span>{hiddenTags.join(' · ')}</span>}
        >
          <span className={styles.badgeMore} role="button" tabIndex={0}>
            +{hiddenTags.length || tags.length}
          </span>
        </InfoTooltip>
      )}
    </div>
  );
}

function SellerRow({ route, active, auto, onClick, tee }: {
  route: DiscoverRow;
  /** This seller currently serves the model (auto-chosen or pinned). */
  active: boolean;
  /** Whether the page-level seller routing is in auto mode. */
  auto: boolean;
  onClick: () => void;
  tee: ReturnType<typeof useTeeVerification>;
}) {
  const capabilities = peerCapabilitySummary(route);
  const parameters = route.capabilities?.supportedParameters ?? [];
  const hasModerationControl = route.protocol === 'openai-images'
    && supportsServiceParameter(route, 'moderation');
  const capabilityLabel = [
    ...capabilities,
    ...parameters
      .filter((parameter) => parameter.trim().toLowerCase() !== 'moderation')
      .map((parameter) => parameter.replaceAll('_', ' ')),
  ].join(' · ');
  const sellerName = route.peerDisplayName || route.peerLabel || route.peerId;
  return (
    <div className={`${styles.sellerRow}${active ? ` ${styles.sellerRowActive}` : ''}`}>
    <button
      type="button"
      className={styles.sellerSelect}
      onClick={onClick}
      title={active && !auto ? 'Unpin this seller' : 'Pin this seller'}
      aria-label={`${active && !auto ? 'Unpin' : 'Pin'} ${sellerName}`}
    />
    <div className={styles.sellerContent}>
      {active && (
        <HugeiconsIcon icon={Tick02Icon} size={16} strokeWidth={2} className={styles.sellerCheck} />
      )}
      <div className={styles.sellerText}>
        <div className={styles.sellerName}>
          <span className={styles.sellerNameLabel}>{sellerName}</span>
          <SellerIdentityBadges route={route} />
          {advertisesTeeSupport(route) &&
            <VprTeeStatus
              className={styles.sellerVerification}
              evidence={tee.status.snapshot?.evidence.find((entry) => entry.peerId === route.peerId)}
              now={tee.now}
              checking={tee.checking.includes(route.peerId)}
              available={Boolean(tee.status.snapshot?.verificationEnabled)}
              error={tee.peerErrors[route.peerId]}
            />
          }
          {active && <VprBadge tone="primary">{auto ? '• Auto' : 'Pinned'}</VprBadge>}
          {isFreeRoute(route) && <VprBadge tone="green">Free</VprBadge>}
          {hasModerationControl && <VprBadge tone="neutral">Moderation control</VprBadge>}
        </div>
        <span className={styles.sellerMeta}>
          {sellerMetaLabel(route)}
          {capabilityLabel ? ` · ${capabilityLabel}` : ''}
        </span>
      </div>
      <span className={styles.sellerScore}>{sellerReputationLabel(route)}</span>
    </div>
    </div>
  );
}

function verificationTitle(link: DiscoverVerificationLink): string {
  return link.kind === 'domain'
    ? `Verified domain: ${link.label}`
    : `Verified GitHub: ${link.label}`;
}

function SellerIdentityBadges({ route }: { route: DiscoverRow }) {
  const knownProxy = getKnownProxy(route.sellerContract);
  if (!knownProxy && route.verificationLinks.length === 0) return null;

  return (
    <span className={styles.sellerIdentityBadges} aria-label="Seller identity badges">
      {knownProxy && (
        <InfoTooltip
          align="left"
          content={(
            <>
              <strong>{knownProxy.label}</strong>
              <span>{knownProxy.description}</span>
            </>
          )}
        >
          <span
            className={styles.sellerProxyBadge}
            tabIndex={0}
            role="button"
            aria-label={`${knownProxy.label} — ${knownProxy.description}`}
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => event.stopPropagation()}
          >
            <HugeiconsIcon icon={ContractsIcon} size={11} strokeWidth={1.8} />
          </span>
        </InfoTooltip>
      )}
      {route.verificationLinks.map((link) => {
        const title = verificationTitle(link);
        const hasDomainPreview = link.kind === 'domain' && (link.title || link.description);
        return (
          <InfoTooltip
            key={`${link.kind}:${link.href}`}
            align="left"
            content={(
              <>
                <strong>{hasDomainPreview ? (link.title ?? title) : title}</strong>
                {link.kind === 'domain' && link.description && (
                  <span className={styles.sellerVerificationDescription}>{link.description}</span>
                )}
                <span>{link.href}</span>
              </>
            )}
          >
            <a
              className={`${styles.sellerVerificationBadge} ${link.kind === 'domain'
                ? styles.sellerVerificationBadgeDomain
                : styles.sellerVerificationBadgeGithub}`}
              href={link.href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={title}
              title={title}
              onClick={(event) => event.stopPropagation()}
              onKeyDown={(event) => event.stopPropagation()}
            >
              <HugeiconsIcon icon={link.kind === 'domain' ? Globe02Icon : GithubIcon} size={11} strokeWidth={1.8} />
            </a>
          </InfoTooltip>
        );
      })}
    </span>
  );
}
