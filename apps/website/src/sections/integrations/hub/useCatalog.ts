import {useMemo} from 'react';
import {CATEGORY_LABELS, CATEGORY_ORDER, integrations, type Integration, type IntegrationCategory} from '../../../integrations/integrations';

export type CatalogGroup = {category: IntegrationCategory; items: readonly Integration[]};

function matches(i: Integration, q: string): boolean {
  return [i.name, i.oneLiner, CATEGORY_LABELS[i.category]].some((s) => s.toLowerCase().includes(q));
}

/** The integrations in category order, filtered by a search query; empty categories are left out. */
export function useCatalog(query: string): {groups: readonly CatalogGroup[]; count: number} {
  return useMemo(() => {
    const q = query.trim().toLowerCase();
    const shown = q ? integrations.filter((i) => matches(i, q)) : integrations;
    const groups = CATEGORY_ORDER
      .map((category) => ({category, items: shown.filter((i) => i.category === category)}))
      .filter((g) => g.items.length > 0);
    return {groups, count: shown.length};
  }, [query]);
}
