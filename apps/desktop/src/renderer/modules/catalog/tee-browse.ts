import { advertisesTeeSupport } from '@antseed/node/verifier-capabilities';
import type { DiscoverRow, VprModelCatalogEntry, VprRoutingPreferences } from '../../core/state';
import { isRouteEligibleForAutoSelection } from '../routing/select';
import { modelPinKey } from '../routing/model-pins';
import { projectRowsToVprModelCatalog } from './model-catalog';
import { applyOpenRouterBaselines, getCachedOpenRouterPrices } from './openrouter-baseline';

export type TeeBrowseFilter = 'all' | 'tee';

export const teeBrowseCache = { filter: 'all' as TeeBrowseFilter };

export function filterTeeBrowseRows(rows: DiscoverRow[], filter: TeeBrowseFilter): DiscoverRow[] {
  return filter === 'tee' ? rows.filter(advertisesTeeSupport) : rows;
}

export function projectTeeBrowseCatalog(
  catalog: VprModelCatalogEntry[],
  rows: DiscoverRow[],
  preferences: VprRoutingPreferences,
  filter: TeeBrowseFilter,
): VprModelCatalogEntry[] {
  if (filter === 'all') return catalog;
  const projected = applyOpenRouterBaselines(
    projectRowsToVprModelCatalog(filterTeeBrowseRows(rows, filter),
      (row) => isRouteEligibleForAutoSelection(row, preferences)),
    getCachedOpenRouterPrices(),
  );
  const byModel = new Map(projected.map((entry) => [modelPinKey(entry.provider, entry.serviceId), entry]));
  return catalog.flatMap((entry) => {
    const matching = byModel.get(modelPinKey(entry.provider, entry.serviceId));
    return matching ? [{ ...matching, provider: entry.provider, serviceId: entry.serviceId, label: entry.label }] : [];
  });
}
