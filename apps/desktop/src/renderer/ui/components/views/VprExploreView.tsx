import { useDeferredValue, useMemo, useState } from 'react';
import { HugeiconsIcon, type IconSvgElement } from '@hugeicons/react';
import {
  AiBrain01Icon,
  AlphabetGreekIcon,
  ChartUpIcon,
  CodeIcon,
  Dollar01Icon,
  EyeIcon,
  Globe02Icon,
  HeadphonesIcon,
  HierarchyIcon,
  Image01Icon,
  PaintBrush01Icon,
  Shield01Icon,
  Sorting01Icon,
  SourceCodeIcon,
  Tag01Icon,
  TextIcon,
  TheaterIcon,
  ZapIcon,
} from '@hugeicons/core-free-icons';
import type { VprModelCatalogEntry, VprModelKind } from '../../../core/state';
import {
  filterVprCatalog,
  pinnedSellerLabels,
  sortVprCatalog,
  type VprCatalogSort,
} from '../../../modules/catalog/view-models';
import { findCatalogEntry, sortFreeModelsByPriority } from '../../../modules/catalog/model-catalog';
import { availableModelFamilies } from '../../../modules/catalog/model-families';
import { loadFavoriteModels } from '../../../modules/catalog/favorites';
import { availableModelTags } from '../../../modules/catalog/model-metadata';
import { setVprModelPageTarget } from '../../../modules/catalog/model-page-target';
import { selectFavoriteVprCatalog } from '../../../modules/catalog/recommended';
import { shallowEqual, useUiSelector } from '../../hooks/useUiSelector';
import { useActions } from '../../hooks/useActions';
import { useEverFunded } from '../../hooks/useEverFunded';
import { useRetainedState } from '../../hooks/useRetainedState';
import { projectTeeBrowseCatalog, teeBrowseCache } from '../../../modules/catalog/tee-browse';
import { VprTeeFilter, VprTeeNotice } from '../vpr/VprTeeAvailability';
import type { ViewName } from '../../types';
import { BrandIcon } from '../brand/BrandIcon';
import { VprFilterDropdown, VprMultiFilterDropdown, type VprFilterOption } from '../vpr/VprFilterDropdown';
import { VprModelRowList } from '../vpr/VprModelRows';
import { VprPage, VprSearch } from '../vpr/VprKit';
import styles from './VprExploreView.module.scss';

type Props = { onSelectView?: (view: ViewName) => void };

/* Lead rows marked "Recommended" at the top of the list. */
const RECOMMENDED_COUNT = 3;

function FilterIconView({ icon }: { icon: IconSvgElement }) {
  return <HugeiconsIcon icon={icon} size={16} strokeWidth={1.8} />;
}

const TAG_ICONS: Readonly<Record<string, IconSvgElement>> = {
  Anime: PaintBrush01Icon,
  'Audio input': HeadphonesIcon,
  Coding: CodeIcon,
  Fast: ZapIcon,
  'Open weights': SourceCodeIcon,
  Reasoning: AiBrain01Icon,
  Roleplay: TheaterIcon,
  Uncensored: Shield01Icon,
  Vision: EyeIcon,
  'Web search': Globe02Icon,
};

// Renderer-lifetime cache: search/filter/sort survive drilling into a model
// page and back (ViewHost unmounts inactive views).
const exploreViewCache = {
  search: '',
  types: [] as string[],
  families: [] as string[],
  sort: 'Popular' as VprCatalogSort,
};

export function VprExploreView({ onSelectView }: Props) {
  const actions = useActions();
  const snap = useUiSelector((state) => ({
    catalog: state.vprModelCatalog,
    selection: state.vprRouteSelection,
    modelPins: state.vprModelPins,
    discoverRows: state.vprRoutableRows,
    discoverRowsLoaded: state.chatDiscoverRowsLoaded,
    preferences: state.vprRoutingPreferences,
  }), shallowEqual);
  const everFunded = useEverFunded();
  const [search, setSearch] = useRetainedState(exploreViewCache, 'search');
  const [types, setTypes] = useRetainedState(exploreViewCache, 'types');
  const [families, setFamilies] = useRetainedState(exploreViewCache, 'families');
  const [sort, setSort] = useRetainedState(exploreViewCache, 'sort');
  const [teeFilter, setTeeFilter] = useRetainedState(teeBrowseCache, 'filter');
  // Filter/search changes re-render the full model list — hundreds of rows.
  // Deriving the list from deferred values keeps the tapped control
  // responsive: the pill paints its new state in the urgent render and the
  // list catches up in an interruptible background render.
  const listInputs = useDeferredValue(useMemo(
    () => ({ search, types, families, sort, teeFilter }),
    [families, search, sort, types, teeFilter],
  ));
  // Starred on the model pages; fresh on every visit (the view remounts).
  const [favorites] = useState(loadFavoriteModels);

  const availableFamilies = useMemo(() => availableModelFamilies(snap.catalog), [snap.catalog]);
  const tags = useMemo(
    () => availableModelTags(snap.catalog.map((entry) => entry.serviceId)),
    [snap.catalog],
  );
  const typeOptions = useMemo<readonly VprFilterOption<string>[]>(() => [
    { value: 'kind:text', label: 'Text', description: 'Chat and language models', icon: <FilterIconView icon={TextIcon} /> },
    { value: 'kind:image', label: 'Image', description: 'Image generation models', icon: <FilterIconView icon={Image01Icon} /> },
    { value: 'free', label: 'Free', description: 'Models with a free offer', icon: <FilterIconView icon={Dollar01Icon} /> },
    ...tags.map((modelTag) => ({
      value: `tag:${modelTag}`,
      label: modelTag,
      description: `Models tagged ${modelTag}`,
      icon: <FilterIconView icon={TAG_ICONS[modelTag] ?? Tag01Icon} />,
    })),
  ], [tags]);
  const familyOptions = useMemo<readonly VprFilterOption<string>[]>(() => [
    ...availableFamilies.map((modelFamily) => ({
      value: modelFamily,
      label: modelFamily,
      description: `${modelFamily} models`,
      icon: <BrandIcon name={modelFamily} hints={[modelFamily]} size={16} />,
    })),
  ], [availableFamilies]);
  const sortOptions = useMemo<readonly VprFilterOption<VprCatalogSort>[]>(() => [
    { value: 'Popular', label: 'Popular', description: 'Most available sellers first', icon: <FilterIconView icon={Sorting01Icon} /> },
    { value: 'Price', label: 'Price', description: 'Lowest price first', icon: <FilterIconView icon={Dollar01Icon} /> },
    { value: 'Savings', label: 'Savings', description: 'Largest savings first', icon: <FilterIconView icon={ChartUpIcon} /> },
    { value: 'Name', label: 'Name', description: 'Alphabetical order', icon: <FilterIconView icon={AlphabetGreekIcon} /> },
  ], []);
  const displayCatalog = useMemo(() => projectTeeBrowseCatalog(
    snap.catalog, snap.discoverRows, snap.preferences, listInputs.teeFilter,
  ), [snap.catalog, snap.discoverRows, snap.preferences, listInputs.teeFilter]);
  const entries = useMemo(() => sortVprCatalog(
    filterVprCatalog(displayCatalog, {
      search: listInputs.search,
      kinds: listInputs.types
        .filter((value) => value.startsWith('kind:'))
        .map((value) => value.slice(5) as VprModelKind),
      tags: listInputs.types
        .filter((value) => value.startsWith('tag:'))
        .map((value) => value.slice(4)),
      families: listInputs.families,
      freeOnly: listInputs.types.includes('free'),
    }),
    listInputs.sort,
  ), [listInputs, displayCatalog]);

  const selectedModel = snap.selection.model;
  const selectedEntry = selectedModel
    ? findCatalogEntry(snap.catalog, selectedModel.provider, selectedModel.serviceId)
    : null;

  // The default view leads with three framed rows. The moment the user has
  // starred anything, the frame becomes their "Favorites"; otherwise it's
  // "Recommended": the selected model first, then — until the first deposit
  // ever lands — the most available free models (paid rows would just 402 for
  // an unfunded user), or the popular lineup once funded. Searching or
  // filtering drops the frame: the user is navigating the full list.
  const filtersActive = listInputs.search.trim().length > 0
    || listInputs.teeFilter === 'tee'
    || listInputs.types.length > 0
    || listInputs.families.length > 0;
  const favoriteEntries = useMemo(
    () => selectFavoriteVprCatalog(snap.catalog, favorites),
    [favorites, snap.catalog],
  );
  const recommendedEntries = useMemo(() => {
    if (filtersActive) return [];
    // Favorites own the frame outright — no padding with other picks, so the
    // label "Favorites" never covers a model the user didn't star.
    const source = favoriteEntries.length > 0
      ? favoriteEntries
      : (everFunded
          ? sortVprCatalog(snap.catalog, 'Popular')
          // hasEligibleFreeSeller, not the price-based Free filter: entry
          // prices fall back to untrusted rows when no seller passes the
          // routing gate, so a $0 offer from a low-reputation seller must
          // not put its model in the recommended frame.
          : sortFreeModelsByPriority(
              sortVprCatalog(snap.catalog.filter((entry) => entry.hasEligibleFreeSeller), 'Popular'),
            ));
    const picks = source.slice(0, RECOMMENDED_COUNT);
    // The selected model leads the frame only when it's naturally one of the
    // picks. An off-frame selection stays out — it leads the list below
    // instead of displacing a real recommendation.
    if (selectedEntry && picks.includes(selectedEntry) && picks[0] !== selectedEntry) {
      return [selectedEntry, ...picks.filter((entry) => entry !== selectedEntry)];
    }
    return picks;
  }, [everFunded, favoriteEntries, filtersActive, selectedEntry, snap.catalog]);

  // One flat list, no duplicate rows: the framed picks lead, then the
  // selected model when it isn't one of them, then the rest of the catalog in
  // the current sort order.
  const listEntries = useMemo(() => {
    const rest = entries.filter((entry) => !recommendedEntries.includes(entry));
    if (
      recommendedEntries.length > 0
      && selectedEntry
      && !recommendedEntries.includes(selectedEntry)
      && rest.includes(selectedEntry)
    ) {
      return [
        ...recommendedEntries,
        selectedEntry,
        ...rest.filter((entry) => entry !== selectedEntry),
      ];
    }
    return [...recommendedEntries, ...rest];
  }, [entries, recommendedEntries, selectedEntry]);

  // Any listed model that remembers a pin names its seller in place of the
  // peer count — pins are per model and survive switching between them.
  const listedPins = useMemo(
    () => pinnedSellerLabels(snap.discoverRows, snap.modelPins, listEntries),
    [listEntries, snap.discoverRows, snap.modelPins],
  );

  const openModelPage = (provider: string, serviceId: string): void => {
    // Drilling into a model only browses it — the model page's "Use" button
    // is what makes it the active route.
    setVprModelPageTarget(provider, serviceId);
    onSelectView?.('model');
  };

  return (
    <section className={`view view-vpr-explore view-pinned-header ${styles.view}`} role="tabpanel">
      <VprPage
        title="Models"
        backFallback="home"
        header={(
          <VprSearch
            value={search}
            onChange={setSearch}
            placeholder="Search models"
          />
        )}
      >
      <div className={styles.stack}>
        <div className={styles.filterRow}>
          <VprMultiFilterDropdown
            label="Type"
            values={types}
            options={typeOptions}
            onChange={setTypes}
          />
          <VprMultiFilterDropdown
            label="Family"
            values={families}
            options={familyOptions}
            onChange={setFamilies}
            emptyIcon={<FilterIconView icon={HierarchyIcon} />}
          />
          <div className={styles.filterEnd}>
            <VprFilterDropdown
              label="Sort models"
              value={sort}
              options={sortOptions}
              onChange={setSort}
              align="end"
            />
          </div>
          <div className={styles.sellerFilter}>
            <VprTeeFilter value={teeFilter} onChange={setTeeFilter} />
          </div>
        </div>

        {teeFilter === 'tee' && <VprTeeNotice onClear={() => setTeeFilter('all')} />}

        {listEntries.length > 0 ? (
          <VprModelRowList
            entries={listEntries}
            selectedProvider={selectedModel?.provider}
            selectedServiceId={selectedModel?.serviceId}
            favoriteKeys={favorites}
            recommendedCount={recommendedEntries.length}
            recommendedLabel={favoriteEntries.length > 0 ? 'Favorites' : 'Recommended'}
            pinnedPeerLabels={listedPins}
            onSelect={openModelPage}
            emptyLabel="No matching models"
          />
        ) : (
          snap.discoverRowsLoaded ? (
            <div className={styles.empty} role="status">
              <div>{teeFilter === 'tee' ? 'No sellers advertising TEE support match these filters.' : 'No models match the current filters.'}</div>
              {teeFilter === 'tee' && (
                <button type="button" onClick={() => {
                  setTeeFilter('all');
                  setSearch('');
                  setTypes([]);
                  setFamilies([]);
                }}>Clear filters</button>
              )}
              <button type="button" onClick={() => { void actions.refreshAll(); }}>
                Refresh models
              </button>
            </div>
          ) : (
            /* Discovery still fetching the first snapshot — a spinner, not a
               dead-end empty state; rows stream in as soon as the poll lands. */
            <div className={styles.empty} role="status" aria-live="polite" aria-label="Loading models">
              <span className="route-loading-spinner" aria-hidden="true" />
              <div>Loading models…</div>
            </div>
          )
        )}
      </div>
      </VprPage>
    </section>
  );
}
